import { db } from "@/lib/db"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { hasAccessForUserId } from "@/lib/subscription"

/**
 * Self-filling Slice 2 — route relevant materials from the user's NORMAL feeds
 * into matching tracked questions.
 *
 * Runs as a worker pass (off the request path). Each material is "considered for
 * routing" exactly once: the `Material.routedAt` watermark is advanced only after
 * a clean run, so overflow beyond the per-run batch — AND a whole batch caught by
 * a transient AI failure — is deferred to the next sweep (never silently dropped).
 * Cost is bounded by (a) only processing users who HAVE tracked questions, (b) a
 * cheap whole-word keyword pre-filter before any AI call, (c) a per-run batch cap,
 * (d) a per-user/run eval cap, and (e) a per-user/24h routed-in budget.
 *
 * Known limitation: during a deploy drain two worker instances can briefly both
 * fetch the same unrouted rows and double-pay an AI eval (skipDuplicates prevents
 * double links). It's transient and cheap; a FOR-UPDATE-SKIP-LOCKED claim would
 * close it if it ever matters.
 */

/** Max unrouted materials considered per user per run (overflow → next run). */
export const ROUTING_BATCH_LIMIT = Number(process.env.ROUTING_BATCH_LIMIT ?? 60)
/** Max materials routed into a user's tracked questions per rolling 24h. */
export const ROUTING_USER_DAILY_CAP = Number(process.env.ROUTING_USER_DAILY_CAP ?? 200)
/** Max tracked questions AI-evaluated per user per run (bounds eval cost). */
export const ROUTING_USER_RUN_EVAL_CAP = Number(process.env.ROUTING_USER_RUN_EVAL_CAP ?? 8)
/** Shortest token treated as a keyword in the pre-filter. */
const MIN_KEYWORD_LEN = 3
/** Tokenize at most this many chars of content (bounds cost on long articles). */
const MAX_TOKENIZE_CHARS = 4000

// Compact English + Russian stopword set — the keyword pre-filter is permissive
// by design (favor recall; the AI eval is the real filter), so this only trims
// the highest-frequency noise that would gate in nearly every material.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "has", "had", "was", "were",
  "with", "this", "that", "from", "they", "have", "what", "when", "your", "will", "would", "there",
  "their", "about", "which", "into", "than", "then", "them", "these", "those", "been", "more", "most",
  "его", "это", "как", "что", "для", "или", "под", "над", "при", "без", "она", "они", "был", "была",
  "так", "уже", "все", "году", "если", "там", "вот", "быть", "этот",
])

function tokenSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, " ").split(/\s+/)) {
    if (w.length >= MIN_KEYWORD_LEN && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

type RoutingMaterial = { id: string; title: string; content: string; url: string; sourceId: string }

export type RoutingResult = { considered: number; routed: number; evaluated: number; cappedUsers: number }

const EMPTY_SET: ReadonlySet<string> = new Set()

export async function routeRecentMaterials(now: number = Date.now()): Promise<RoutingResult> {
  // Only users who actually have a tracked question can receive routed material.
  const tracked = await db.collection.findMany({
    where: { query: { not: null } },
    select: { id: true, userId: true, query: true },
  })
  if (tracked.length === 0) return { considered: 0, routed: 0, evaluated: 0, cappedUsers: 0 }

  const byUser = new Map<string, Array<{ id: string; query: string }>>()
  for (const c of tracked) {
    if (!c.query) continue
    const list = byUser.get(c.userId) ?? []
    list.push({ id: c.id, query: c.query })
    byUser.set(c.userId, list)
  }

  let considered = 0
  let routed = 0
  let evaluated = 0
  let cappedUsers = 0

  for (const [userId, collections] of byUser) {
    // RAD-323: never spend on an owner whose access has lapsed — the batch eval
    // below is paid. Fail-closed: an unresolvable lookup skips the user.
    if (!(await hasAccessForUserId(userId))) continue

    // Per-user/24h budget — if exhausted, leave this user's materials unrouted
    // (routedAt stays null) so they're retried next run once the window rolls.
    const since = new Date(now - 24 * 60 * 60 * 1000)
    const routedRecently = await db.collectionMaterial.count({
      where: { collection: { userId }, createdAt: { gte: since } },
    })
    const budget = ROUTING_USER_DAILY_CAP - routedRecently
    if (budget <= 0) {
      cappedUsers++
      console.log(`[Routing] user ${userId} at daily cap (${routedRecently}/${ROUTING_USER_DAILY_CAP}) — deferring`)
      continue
    }

    const materials: RoutingMaterial[] = await db.material.findMany({
      where: {
        routedAt: null,
        aiEvaluation: "APPROVED",
        userStatus: { not: "DELETED" },
        feed: { userId, hidden: false }, // never route from a tracked question's own (hidden) backing feed
      },
      orderBy: { createdAt: "asc" }, // oldest first → stable watermark progress
      take: ROUTING_BATCH_LIMIT,
      select: { id: true, title: true, content: true, url: true, sourceId: true },
    })
    if (materials.length === 0) continue
    considered += materials.length
    if (materials.length === ROUTING_BATCH_LIMIT) {
      console.log(`[Routing] user ${userId} hit the per-run batch cap (${ROUTING_BATCH_LIMIT}) — more may remain for next run`)
    }

    // A material manually saved into a collection must not ALSO be auto-routed
    // into it (would double-count + double-render). Fetch the existing saves for
    // this batch across the user's tracked collections.
    const savedRows = await db.savedItem.findMany({
      where: { userId, collectionId: { in: collections.map((c) => c.id) }, materialId: { in: materials.map((m) => m.id) } },
      select: { collectionId: true, materialId: true },
    })
    const savedByCollection = new Map<string, Set<string>>()
    for (const s of savedRows) {
      const set = savedByCollection.get(s.collectionId) ?? new Set<string>()
      set.add(s.materialId)
      savedByCollection.set(s.collectionId, set)
    }

    // Tokenize each material once (not per collection).
    const tokens = new Map<string, Set<string>>()
    for (const m of materials) {
      tokens.set(m.id, tokenSet(`${m.title} ${m.content.slice(0, MAX_TOKENIZE_CHARS)}`))
    }

    let userFailed = false
    let routedThisUser = 0
    let evalsThisUser = 0

    for (const col of collections) {
      if (routedThisUser >= budget || evalsThisUser >= ROUTING_USER_RUN_EVAL_CAP) break
      const keywords = [...tokenSet(col.query)]
      if (keywords.length === 0) continue
      const alreadySaved = savedByCollection.get(col.id) ?? EMPTY_SET
      const candidates = materials.filter((m) => {
        if (alreadySaved.has(m.id)) return false
        const t = tokens.get(m.id)!
        return keywords.some((k) => t.has(k))
      })
      if (candidates.length === 0) continue

      let evals
      try {
        evals = await evaluateMaterialsBatch({
          materials: candidates.map((m) => ({ title: m.title, content: m.content, url: m.url })),
          sourceId: candidates[0].sourceId, // ignored when criteria is set
          userId,
          criteria: col.query,
        })
      } catch (err) {
        console.error(`[Routing] eval failed for collection ${col.id} — will retry next run:`, err)
        userFailed = true
        continue
      }
      evalsThisUser++
      evaluated += candidates.length

      let matched = candidates.filter((_, i) => evals[i]?.relevant)
      const remaining = budget - routedThisUser
      if (matched.length > remaining) matched = matched.slice(0, remaining) // respect the 24h budget
      if (matched.length === 0) continue

      try {
        const { count } = await db.collectionMaterial.createMany({
          data: matched.map((m) => ({ collectionId: col.id, materialId: m.id })),
          skipDuplicates: true,
        })
        if (count > 0) {
          // Arm the trailing-edge synthesis debounce (same marker the webhook uses).
          await db.collection.update({ where: { id: col.id }, data: { autoSynthAt: new Date(now) } })
          routedThisUser += count
          routed += count
        }
      } catch (err) {
        // e.g. the collection was deleted concurrently → FK violation. Don't
        // advance the watermark so the batch retries cleanly next run.
        console.error(`[Routing] link failed for collection ${col.id} — will retry next run:`, err)
        userFailed = true
        continue
      }
    }

    // Advance the watermark ONLY on a clean run. A transient eval/link failure
    // leaves the whole batch at routedAt=null so it's reconsidered next run
    // (already-created links are idempotent via skipDuplicates).
    if (!userFailed) {
      await db.material.updateMany({
        where: { id: { in: materials.map((m) => m.id) } },
        data: { routedAt: new Date(now) },
      })
    }
  }

  if (routed > 0 || cappedUsers > 0) {
    console.log(`[Routing] considered=${considered} evaluated=${evaluated} routed=${routed} cappedUsers=${cappedUsers}`)
  }
  return { considered, routed, evaluated, cappedUsers }
}
