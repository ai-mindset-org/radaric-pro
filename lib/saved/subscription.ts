import type { InterestCadence } from "@prisma/client"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { createParallelMonitor, deleteParallelMonitor, buildWebhookUrl } from "@/lib/parsers/interest"
import { regenerateSynthesis } from "@/lib/saved/synthesis"
import { hasAccessForUserId, resolveAccessWithReason } from "@/lib/subscription"

/** Max self-filling collections (tracked questions) per non-admin user. */
export const SELF_FILLING_CAP = Number(process.env.SELF_FILLING_CAP ?? 10)
/** A self-filling collection's answer regenerates at most this often (worker debounce). */
export const SYNTH_DEBOUNCE_MS = Number(process.env.SYNTH_DEBOUNCE_MS ?? 5 * 60_000)

/** Cadence → the freshness-floor window (max age of an answer before the floor regenerates it). */
const CADENCE_MS: Record<InterestCadence, number> = {
  HOURLY: 60 * 60_000,
  DAILY: 24 * 60 * 60_000,
  WEEKLY: 7 * 24 * 60 * 60_000,
}
/** Max answers regenerated in one sweep — caps wall-time + LLM spend per tick. */
const SWEEP_MAX_REGENS = Number(process.env.SWEEP_MAX_REGENS ?? 25)

export class CapReachedError extends Error {
  constructor() {
    super("Self-filling collection limit reached")
    this.name = "CapReachedError"
  }
}
export class ParallelNotConfiguredError extends Error {
  constructor() {
    super("Parallel API is not configured")
    this.name = "ParallelNotConfiguredError"
  }
}

/**
 * Create a self-filling collection (a "tracked question"). Mirrors the proven
 * feeds-POST pattern: cap-check → create the paid Parallel monitor → create the
 * backing hidden EVENT_TRIGGER feed + the collection in a transaction (with a
 * transactional cap re-check) → on ANY DB failure, roll the monitor back.
 */
export async function createTrackedQuestion(
  userId: string,
  role: string,
  input: { name: string; query: string; cadence: InterestCadence }
): Promise<{ id: string; name: string }> {
  const isAdmin = role === "ADMIN"

  // Cheap pre-check so we don't pay Parallel for a monitor we'll reject.
  if (!isAdmin) {
    const count = await db.collection.count({ where: { userId, query: { not: null } } })
    if (count >= SELF_FILLING_CAP) throw new CapReachedError()
  }

  const settings = await db.settings.findFirst({ select: { parallelApiKey: true } })
  if (!settings?.parallelApiKey) throw new ParallelNotConfiguredError()

  const monitorId = await createParallelMonitor(
    { query: input.query, cadence: input.cadence.toLowerCase() as "hourly" | "daily" | "weekly" },
    buildWebhookUrl()
  )

  try {
    return await db.$transaction(async (tx) => {
      // Cap re-check inside the transaction. A bare count() under READ COMMITTED
      // wouldn't close the concurrent-create race (neither in-flight INSERT is
      // visible to the other), so first take a per-user advisory lock — released
      // at transaction end — to serialize creates for this user. The second
      // racer then counts AFTER the first commits and is correctly rejected.
      if (!isAdmin) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`
        const count = await tx.collection.count({ where: { userId, query: { not: null } } })
        if (count >= SELF_FILLING_CAP) throw new CapReachedError()
      }
      const feed = await tx.feed.create({
        data: {
          userId,
          type: "EVENT_TRIGGER",
          url: `parallel://monitor/${monitorId}`,
          name: input.name,
          isActive: true,
          status: "ACTIVE",
          hidden: true,
          parallelMonitorId: monitorId,
          interestQuery: input.query,
          interestCadence: input.cadence,
        },
      })
      const col = await tx.collection.create({
        data: {
          userId,
          name: input.name,
          query: input.query,
          cadence: input.cadence,
          monitorFeedId: feed.id,
          trackRequestedAt: new Date(),
        },
        select: { id: true, name: true },
      })
      return col
    })
  } catch (err) {
    // Roll the paid monitor back on any DB failure (cap race, duplicate name…).
    try {
      await deleteParallelMonitor(monitorId)
    } catch (e) {
      console.error("[track] monitor rollback failed (orphan):", monitorId, e)
    }
    throw err
  }
}

/**
 * Delete a collection. If self-filling, clean up in order **monitor → feed →
 * collection**: delete the Parallel monitor (best-effort; flag for worker
 * reconcile on failure), delete the backing feed (cascades its materials), then
 * the collection (cascades manual saves/excerpts).
 */
export async function deleteTrackedCollection(userId: string, collectionId: string): Promise<boolean> {
  const collection = await db.collection.findFirst({
    where: { id: collectionId, userId },
    select: {
      id: true,
      monitorFeedId: true,
      monitorFeed: { select: { id: true, parallelMonitorId: true } },
    },
  })
  if (!collection) return false

  const monitorId = collection.monitorFeed?.parallelMonitorId ?? null
  let monitorGone = true
  if (monitorId) {
    try {
      await deleteParallelMonitor(monitorId)
    } catch (e) {
      monitorGone = false
      console.error("[track] monitor delete failed; keeping backing feed flagged for reconcile:", e)
    }
  }

  if (collection.monitorFeedId) {
    if (monitorGone) {
      // Monitor is gone (or never existed) — drop the backing feed; this cascades
      // its materials. Deleting the collection below is then a clean teardown.
      await db.feed
        .delete({ where: { id: collection.monitorFeedId } })
        .catch((e) => console.error("[track] backing feed delete failed:", e))
    } else {
      // The paid monitor delete failed. Do NOT delete the feed — that would wipe
      // the only record of the orphaned monitorId. Flag it instead so
      // reconcileOrphanMonitors retries the delete (and cleans up the now
      // collection-less feed) later. Deleting the collection detaches it via the
      // FK's ON DELETE SET NULL.
      await db.feed
        .update({ where: { id: collection.monitorFeedId }, data: { monitorDeletePending: true } })
        .catch((e) => console.error("[track] flagging backing feed for reconcile failed:", e))
    }
  }
  await db.collection.delete({ where: { id: collectionId } })
  return true
}

/**
 * Worker sweep — a true trailing-edge debounce. `autoSynthAt` is the
 * "new material since" marker the webhook bumps on every new APPROVED batch.
 * We regenerate the living answer only once arrivals have settled for
 * SYNTH_DEBOUNCE_MS (so a burst coalesces into a single paid synthesis), then
 * clear the marker — guarding against a newer arrival that landed mid-synthesis
 * so we don't drop its signal. Runs in the long-running worker, OFF the request
 * path.
 */
export async function sweepDueCollections(
  now: number = Date.now(),
  { includeFloor = true }: { includeFloor?: boolean } = {}
): Promise<{ regenerated: number; considered: number }> {
  const tracked = await db.collection.findMany({
    where: { query: { not: null } },
    select: { id: true, userId: true, autoSynthAt: true, synthesisUpdatedAt: true, cadence: true, monitorFeedId: true },
  })
  let regenerated = 0
  let failed = 0
  // RAD-323: the sweep has no session — resolve each owner's access once from the
  // DB and skip the paid regen when it has lapsed (cancelled plan, expired demo
  // window). Without this a throwaway account armed inside its 24h demo window
  // kept regenerating answers indefinitely.
  const accessByUser = new Map<string, boolean>()
  const ownerHasAccess = async (userId: string): Promise<boolean> => {
    let allowed = accessByUser.get(userId)
    if (allowed === undefined) {
      allowed = await hasAccessForUserId(userId)
      accessByUser.set(userId, allowed)
    }
    return allowed
  }
  for (const c of tracked) {
    // Bound one sweep's wall-time + LLM spend — defer the rest to the next sweep
    // (e.g. after a worker outage, when many questions are due at once).
    if (regenerated >= SWEEP_MAX_REGENS) {
      console.log(`[sweep] hit the per-sweep regen cap (${SWEEP_MAX_REGENS}) — deferring the rest to the next sweep`)
      break
    }

    if (!(await ownerHasAccess(c.userId))) continue

    // (1) Armed trailing-edge debounce — new material arrived (autoSynthAt) and
    //     arrivals have settled for the debounce window.
    const armed = c.autoSynthAt != null && now - c.autoSynthAt.getTime() >= SYNTH_DEBOUNCE_MS

    // (2) Cadence freshness floor — ONLY for collections with no pending arm (so
    //     we never pre-empt the debounce): the answer is older than the question's
    //     cadence AND there is material newer than it. A safety net for a missed
    //     autoSynthAt-arm (the webhook/routing bumps are best-effort, swallowed)
    //     and for the first synthesis of a never-generated question. The "newer
    //     material" check uses the SAME predicates the synthesis reads, so a
    //     successful regen always advances synthesisUpdatedAt and the floor backs
    //     off — no unchanged-answer regen, no re-fire loop.
    let due = armed
    if (!due && includeFloor && c.autoSynthAt == null) {
      const cadenceMs = CADENCE_MS[c.cadence ?? "DAILY"]
      const sinceSynth = c.synthesisUpdatedAt ? now - c.synthesisUpdatedAt.getTime() : Infinity
      if (sinceSynth >= cadenceMs && (await hasMaterialNewerThan(c, c.synthesisUpdatedAt ?? new Date(0)))) {
        due = true
      }
    }
    if (!due) continue

    try {
      const r = await regenerateSynthesis(c.userId, c.id)
      if (r.status === "ok") {
        regenerated++
        // Clear the arm marker only if it hasn't advanced since we read it (a
        // newer arrival mid-synthesis stays armed for the next sweep).
        if (c.autoSynthAt) {
          await db.collection
            .updateMany({ where: { id: c.id, autoSynthAt: c.autoSynthAt }, data: { autoSynthAt: null } })
            .catch(() => {})
        }
      }
    } catch (e) {
      failed++
      console.error("[sweep] regen failed for collection", c.id, e)
    }
  }
  // Aggregate signal so a systemic outage (AI key revoked, provider down for
  // every collection) is visible, not just a flood of per-collection errors.
  if (failed > 0) {
    console.error(`[sweep] ${failed}/${regenerated + failed} regen attempt(s) failed this sweep`)
  }
  return { regenerated, considered: tracked.length }
}

/**
 * Does this collection have any source material the SYNTHESIS would include,
 * created after `since`? (freshness-floor gate). Predicates MUST match what
 * regenerateSynthesis actually reads — otherwise the floor counts a source the
 * synthesis drops (e.g. a routed-but-DELETED material), gets `status: "empty"`,
 * never advances synthesisUpdatedAt, and re-fires every sweep forever.
 */
async function hasMaterialNewerThan(
  collection: { id: string; monitorFeedId: string | null },
  since: Date
): Promise<boolean> {
  const [backing, routed, saved] = await Promise.all([
    collection.monitorFeedId
      ? db.material.count({
          where: { sourceId: collection.monitorFeedId, aiEvaluation: "APPROVED", userStatus: { not: "DELETED" }, createdAt: { gt: since } },
        })
      : Promise.resolve(0),
    db.collectionMaterial.count({
      where: { collectionId: collection.id, createdAt: { gt: since }, material: { userStatus: { not: "DELETED" } } },
    }),
    db.savedItem.count({ where: { collectionId: collection.id, createdAt: { gt: since } } }),
  ])
  return backing + routed + saved > 0
}

/** Reconcile orphaned monitors whose delete failed earlier (worker). */
export async function reconcileOrphanMonitors(): Promise<{ reconciled: number }> {
  const pending = await db.feed.findMany({
    where: { monitorDeletePending: true, parallelMonitorId: { not: null } },
    select: { id: true, parallelMonitorId: true, backedCollection: { select: { id: true } } },
  })
  let reconciled = 0
  for (const f of pending) {
    try {
      await deleteParallelMonitor(f.parallelMonitorId!)
      if (f.backedCollection) {
        // Still backs a live collection (a mid-flight delete failed) — the
        // monitor is gone now, so just clear the flag.
        await db.feed.update({ where: { id: f.id }, data: { monitorDeletePending: false } }).catch(() => {})
      } else {
        // Left over from a deleted collection — now that the monitor is gone,
        // drop the orphaned backing feed too (cascades its materials).
        await db.feed.delete({ where: { id: f.id } }).catch(() => {})
      }
      reconciled++
    } catch {
      /* leave flagged; retry next sweep */
    }
  }
  return { reconciled }
}

/**
 * RAD-323: keep Parallel monitors aligned with their owner's access.
 *
 * The webhook and the routing/synthesis passes are gated at spend time, but a
 * monitor that keeps RUNNING for a lapsed owner (cancelled subscriber,
 * demo-expired throwaway) is itself a cost and a standing ingestion source.
 * This pass:
 *   - pauses (deletes the monitor of) every monitor-backed feed whose owner no
 *     longer has access, marking it `accessPaused` so recovery is possible;
 *   - re-arms only feeds the LAPSE paused (accessPaused) once their owner has
 *     access again — a user-initiated pause never sets the flag and is never
 *     auto-resumed.
 *
 * Access is resolved with the throwing variant so "could not check" (DB error)
 * never triggers a delete. Runs in the worker sweep, so it converges without a
 * Stripe-side hook and covers the demo-window expiry path too.
 */
/** Max monitor-backed feeds scanned per pass (the scan rotates via a cursor). */
const MONITOR_RECONCILE_SCAN_CAP = Math.max(1, Number(process.env.MONITOR_RECONCILE_SCAN_CAP ?? 500))
/** Max pause/re-arm actions per pass — each is a serial Parallel API call. */
const MONITOR_RECONCILE_ACTIONS = Math.max(1, Number(process.env.MONITOR_RECONCILE_ACTIONS ?? 25))
/** Rotating scan cursor so a deployment with >cap feeds still converges. */
let accessReconcileCursor: string | null = null

export async function reconcileMonitorsForAccess(): Promise<{ paused: number; resumed: number }> {
  const settings = await db.settings.findFirst({ select: { parallelApiKey: true } })
  if (!settings?.parallelApiKey) return { paused: 0, resumed: 0 }

  const feeds = await db.feed.findMany({
    where: { type: { in: ["EVENT_TRIGGER", "INTEREST"] }, interestQuery: { not: null } },
    select: {
      id: true,
      userId: true,
      isActive: true,
      hidden: true,
      parallelMonitorId: true,
      interestQuery: true,
      interestCadence: true,
      accessPaused: true,
      backedCollection: { select: { id: true } },
    },
    // Stable, rotating scan: with more feeds than the cap a fixed page would
    // starve the tail forever, so each tick resumes after the last id.
    orderBy: { id: "asc" },
    take: MONITOR_RECONCILE_SCAN_CAP,
    ...(accessReconcileCursor ? { cursor: { id: accessReconcileCursor }, skip: 1 } : {}),
  })
  accessReconcileCursor = feeds.length === MONITOR_RECONCILE_SCAN_CAP ? feeds[feeds.length - 1].id : null
  if (feeds.length === MONITOR_RECONCILE_SCAN_CAP) {
    console.log(`[access] reconcile hit the ${MONITOR_RECONCILE_SCAN_CAP}-feed scan cap — continuing from the cursor next sweep`)
  }

  // Tri-state per owner: a genuine LAPSE pauses monitors, and so does an
  // UNVERIFIED credential account — with `accessPaused` set, so verification
  // re-arms it automatically. This bounds Parallel-side cost for accounts that
  // never verify (paid or not) while keeping recovery automatic. "unknown"
  // (DB error) never acts.
  type OwnerAccess = "allowed" | "lapsed" | "unverified" | "unknown"
  const accessByUser = new Map<string, OwnerAccess>()
  const ownerAccess = async (userId: string): Promise<OwnerAccess> => {
    let state = accessByUser.get(userId)
    if (state === undefined) {
      try {
        const resolution = await resolveAccessWithReason(userId)
        state = resolution.allowed ? "allowed" : resolution.unverified ? "unverified" : "lapsed"
      } catch (err) {
        Sentry.captureException(err, { tags: { gate: "reconcileMonitorsForAccess" } })
        state = "unknown"
      }
      accessByUser.set(userId, state)
    }
    return state
  }

  let paused = 0
  let resumed = 0
  for (const f of feeds) {
    // Bound the pass: every action is a serial Parallel API call, and an
    // overrunning tick starves the routing/sweep sub-passes behind it.
    if (paused + resumed >= MONITOR_RECONCILE_ACTIONS) {
      console.log(`[access] hit the per-pass action cap (${MONITOR_RECONCILE_ACTIONS}) — deferring the rest`)
      break
    }

    // Feed.userId is nullable (system feeds have no owner) — nothing to gate on.
    const userId = f.userId
    if (!userId) continue
    const monitorId = f.parallelMonitorId

    if (monitorId) {
      // Any monitor whose owner cannot access it is paused — a lapse OR an
      // unverified account (recoverable: `accessPaused` re-arms on verify).
      // Includes feeds already inactive with a stale monitor id. Unknown never acts.
      const state = await ownerAccess(userId)
      if (state === "allowed" || state === "unknown") continue
      try {
        await deleteParallelMonitor(monitorId)
        await db.feed.update({
          where: { id: f.id },
          // accessPaused only for a feed that was ACTIVE when its owner lapsed:
          // an inactive feed with a stale monitor id is a user pause whose delete
          // previously failed — clean the monitor up, but never auto-resume it.
          data: { parallelMonitorId: null, isActive: false, accessPaused: f.isActive },
        })
        paused++
      } catch (e) {
        // Leave the feed untouched so the next sweep retries the delete. The
        // webhook's access gate still blocks any processing in the meantime.
        console.error("[access] monitor pause failed — retrying next sweep:", monitorId, e)
      }
      continue
    }

    // Re-arm a LAPSE-paused feed (never a user pause) once access is back. A
    // hidden feed only re-arms while it still backs a live collection — an
    // orphaned backing feed must not get a new paid monitor.
    const query = f.interestQuery
    const cadence = f.interestCadence
    const reArmable = !f.hidden || f.backedCollection !== null
    if (f.accessPaused && query && cadence && reArmable) {
      const state = await ownerAccess(userId)
      if (state !== "allowed") continue
      let newMonitorId: string
      try {
        newMonitorId = await createParallelMonitor(
          { query, cadence: cadence.toLowerCase() as "hourly" | "daily" | "weekly" },
          buildWebhookUrl()
        )
      } catch (e) {
        console.error("[access] monitor re-arm failed — retrying next sweep:", f.id, e)
        continue
      }
      try {
        // Compare-and-swap: only arm a feed that is still un-armed, so a second
        // worker (deploy overlap) or a concurrent user action can't double-create.
        const { count } = await db.feed.updateMany({
          where: { id: f.id, parallelMonitorId: null, accessPaused: true },
          data: { parallelMonitorId: newMonitorId, isActive: true, accessPaused: false },
        })
        if (count === 0) throw new Error("feed was re-armed or removed concurrently")
        resumed++
      } catch (e) {
        // Never leave a paid monitor with no DB record — roll it back, and make
        // a failed rollback (Parallel down) discoverable rather than just a log.
        await deleteParallelMonitor(newMonitorId).catch((delErr) => {
          Sentry.captureException(delErr, { extra: { monitorId: newMonitorId, feedId: f.id } })
          console.error("[access] re-arm rollback failed (orphan monitor):", newMonitorId, delErr)
        })
        console.error("[access] monitor re-arm failed — monitor rolled back:", f.id, e)
      }
    }
  }
  return { paused, resumed }
}
