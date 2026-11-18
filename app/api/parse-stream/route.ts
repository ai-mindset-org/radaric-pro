import { NextRequest, NextResponse } from "next/server"
import { AIEvaluation, MaterialStatus } from "@prisma/client"
import pLimit from "p-limit"
import { db } from "@/lib/db"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { knownMaterialKeys } from "@/lib/materials/known-keys"
import type { ParsedItem } from "@/lib/parsers/rss"
import { parseTelegramChannel } from "@/lib/parsers/telegram"
import { parseTwitterSource, parseSourceUrlToConfig } from "@/lib/parsers/twitter"
import { parseYouTubeChannel } from "@/lib/parsers/youtube"
import { parseInterestSource } from "@/lib/parsers/interest"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { auth } from "@/lib/auth"
import { hasActiveAccess } from "@/lib/subscription"
import { subscriptionIncludesTwitter } from "@/lib/entitlements"
import { formatSourceError, truncateErrorMessage } from "@/lib/feed-error"
import { SSE_HEADERS, startHeartbeat, streamableRefusal } from "@/lib/sse"
import { beginParseRun, finishParseRun, isStopRequested, syncRunProgress } from "@/lib/parse-runs"
import type { ParseRunHandle } from "@/lib/parse-runs"
import { computeMediaBackfill } from "@/lib/story-aggregator/media-backfill"
import { parseableFeedWhere } from "@/lib/materials/parseable-feed-where"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
/**
 * Must exceed SOURCE_TIMEOUT_MS (180s) or the two numbers contradict each other:
 * the watchdog is allowed to wait three minutes on one source while the route
 * budget expires after one. Radaric deploys to Railway as a long-running Node
 * server, where this export is inert — but a 60 sitting next to a 180s watchdog
 * reads as a real limit to whoever touches this file next, and would become one
 * on any platform that enforces it. SOURCE_CONCURRENCY is 5, so the worst case
 * is ceil(sources/5) * 180s; 300 covers the common one-or-two-batch run.
 */
export const maxDuration = 300
export const SOURCE_CONCURRENCY = 5
export const MATERIAL_CREATE_CONCURRENCY = 10

/**
 * Per-source watchdog. No single source may block the whole stream: if one hangs,
 * Promise.allSettled never resolves and parse_complete is never sent, freezing the
 * UI mid-run (RAD-232). Generous enough for legitimate worst cases (Telegram worker
 * ~120s, RSS fetch + multi-chunk AI eval) while still capping a true hang. Inner
 * parsers/AI calls have their own timeouts; this is the belt-and-suspenders layer.
 */
export const SOURCE_TIMEOUT_MS = 180_000

class SourceTimeoutError extends Error {
  constructor(sourceName: string) {
    super(`Source timed out after ${Math.round(SOURCE_TIMEOUT_MS / 1000)}s: ${sourceName}`)
    this.name = "SourceTimeoutError"
  }
}

/** Reject if `work` doesn't settle within SOURCE_TIMEOUT_MS; always clears its timer. */
async function withSourceTimeout<T>(work: Promise<T>, sourceName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fuse = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceTimeoutError(sourceName)), SOURCE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, fuse])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Helper to encode SSE messages
function sseMessage(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

interface ParseResults {
  parsed: number
  evaluated: number
  approved: number
  filtered: number
  errors: string[]
  approvedMaterialIds: string[]
}

interface StreamContext {
  controller: ReadableStreamDefaultController
  encoder: TextEncoder
  /** The consumer is gone (CDN truncation, client cancel). Every write is a no-op. */
  closed: boolean
}

/**
 * Writing to a stream whose consumer has gone is a SILENT no-op (RAD-346).
 *
 * A CDN or reverse proxy in front of the app can cut this stream mid-run;
 * without this, the first enqueue after the truncation throws
 * `Invalid state: Controller is already closed` out of `processSourceItems`
 * and into the per-source catch, which records it as a fake source error,
 * persists the feed as ERROR and logs a bogus FATAL. A dead transport is not
 * the run's failure.
 */
function send(ctx: StreamContext, data: Record<string, unknown>) {
  if (ctx.closed) return
  let frame: Uint8Array
  try {
    frame = ctx.encoder.encode(sseMessage(data))
  } catch (error) {
    // A frame we cannot serialize is OUR bug, not a dead transport. Latching
    // `closed` on it would mute every later frame for a client that is still
    // connected — and `closeStream` would then never close the body either.
    console.error("[PARSE-STREAM] unserializable frame", error)
    return
  }
  try {
    ctx.controller.enqueue(frame)
  } catch {
    ctx.closed = true
  }
}

/** Close once, and never throw — a closed controller is already the goal state. */
function closeStream(ctx: StreamContext) {
  if (ctx.closed) return
  ctx.closed = true
  try {
    ctx.controller.close()
  } catch {
    // Already closed by the underlying source; nothing to do.
  }
}

const MATERIAL_SELECT = {
  id: true,
  title: true,
  url: true,
  content: true,
  contentEntities: true,
  publishedAt: true,
  thumbnailUrl: true,
  mediaUrls: true,
  aiEvaluation: true,
  aiConfidence: true,
  aiReasoning: true,
  userStatus: true,
  createdAt: true,
  updatedAt: true,
  feed: {
    select: {
      id: true,
      name: true,
      type: true,
    },
  },
} as const

/**
 * Shared pipeline: dedup → AI evaluate → create materials → stream to client.
 * Used by RSS, Telegram, Twitter, and YouTube source types.
 */
async function processSourceItems(
  source: { id: string; name: string; type: string },
  items: ParsedItem[],
  userId: string,
  results: ParseResults,
  ctx: StreamContext,
): Promise<void> {
  results.parsed += items.length

  send(ctx, {
    type: "items_fetched",
    sourceId: source.id,
    count: items.length,
  })

  if (items.length === 0) {
    console.log(`[PARSE-STREAM] No items found for ${source.name}, skipping`)
    await db.feed.update({
      where: { id: source.id },
      data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
    })
    send(ctx, {
      type: "source_complete",
      sourceId: source.id,
      sourceName: source.name,
      stats: { parsed: 0, new: 0, approved: 0, filtered: 0 },
    })
    return
  }

  // Check for existing materials to avoid duplicate AI evaluations
  const existingMaterials = await db.material.findMany({
    where: {
      sourceId: source.id,
      OR: [
        { url: { in: items.map(item => item.url).filter(Boolean) } },
        { externalId: { in: items.map(item => item.externalId).filter(Boolean) } }
      ]
    },
    select: { id: true, url: true, externalId: true, mediaUrls: true, thumbnailUrl: true, content: true }
  })

  const newItems = items.filter(item =>
    !existingMaterials.some(existing =>
      (item.url && existing.url === item.url) ||
      (item.externalId && existing.externalId === item.externalId)
    )
  )

  console.log(`[PARSE-STREAM] Found ${newItems.length} new items out of ${items.length} total (${items.length - newItems.length} duplicates skipped)`)

  // RAD-359: posts stored before the media mirror existed have no media and are
  // dropped by dedup forever. Reconcile them — media/content only — BEFORE the
  // all-duplicates early return, so a re-parse of an old post still backfills.
  // TELEGRAM only: the fresh media mirror exists nowhere else.
  if (source.type === "TELEGRAM" && existingMaterials.length > 0) {
    const reconciled = new Set<string>()
    for (const item of items) {
      for (const stored of existingMaterials) {
        if (reconciled.has(stored.id)) continue
        const matches =
          (!!item.url && stored.url === item.url) ||
          (!!item.externalId && stored.externalId === item.externalId)
        if (!matches) continue

        // First fresh item matching this stored row wins — at most one
        // reconciliation per row per parse.
        reconciled.add(stored.id)

        const payload = computeMediaBackfill(stored, item)
        if (!payload) break // media already mirrored; nothing to announce

        try {
          await db.material.update({ where: { id: stored.id }, data: payload })
          send(ctx, { type: "material_updated", material: { id: stored.id, ...payload } })
        } catch (error) {
          // ERR-1: a rejected backfill must not fail the source.
          console.error(`[PARSE-STREAM] Media backfill failed for material ${stored.id}:`, error)
        }
        break
      }
    }
  }

  if (newItems.length === 0) {
    console.log(`[PARSE-STREAM] No new items for ${source.name}, skipping AI evaluation`)
    await db.feed.update({
      where: { id: source.id },
      data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
    })

    send(ctx, {
      type: "source_complete",
      sourceId: source.id,
      sourceName: source.name,
      stats: { parsed: items.length, new: 0, approved: 0, filtered: 0 },
    })
    return
  }

  // Evaluate only NEW materials with AI
  console.log(`[PARSE-STREAM] Evaluating ${newItems.length} new items with AI`)
  const evaluations = await evaluateMaterialsBatch({
    materials: newItems.map((item) => ({
      title: item.title,
      content: item.content,
      url: item.url,
    })),
    sourceId: source.id,
    userId,
  })

  results.evaluated += evaluations.length

  const materialLimit = pLimit(MATERIAL_CREATE_CONCURRENCY)

  const createPromises = newItems.map((item, i) => materialLimit(async () => {
    const evaluation = evaluations[i]
    const aiEval = evaluation.relevant ? AIEvaluation.APPROVED : AIEvaluation.FILTERED

    try {
      const createdMaterial = await db.material.create({
        data: {
          sourceId: source.id,
          title: item.title,
          url: item.url,
          externalId: item.externalId,
          content: item.content,
          ...(item.contentEntities && item.contentEntities.length > 0
            ? { contentEntities: item.contentEntities }
            : {}),
          publishedAt: item.publishedAt,
          thumbnailUrl: item.thumbnailUrl,
          mediaUrls: item.mediaUrls,
          aiEvaluation: aiEval,
          aiConfidence: evaluation.confidence,
          aiReasoning: evaluation.reasoning,
          userStatus: MaterialStatus.NEW,
        },
        select: MATERIAL_SELECT,
      })
      return { status: 'created' as const, material: createdMaterial, evaluation, index: i }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2002') {
        console.log(`[PARSE-STREAM] Skipping duplicate material: ${item.title}`)
        return { status: 'duplicate' as const, index: i }
      }
      throw error // non-P2002 errors propagate to Promise.allSettled as rejected
    }
  }))

  const settled = await Promise.allSettled(createPromises)

  let sourceApproved = 0
  let sourceFiltered = 0
  let actuallyCreated = 0

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const value = result.value
      if (value.status === 'created') {
        actuallyCreated++
        if (value.evaluation.relevant) {
          results.approved++
          results.approvedMaterialIds.push(value.material.id)
          sourceApproved++
        } else {
          results.filtered++
          sourceFiltered++
        }
        send(ctx, {
          type: "material_created",
          material: value.material,
          sourceId: source.id,
          progress: { current: actuallyCreated, total: newItems.length },
        })
        console.log(`[PARSE-STREAM] Streamed material ${actuallyCreated}/${newItems.length}: ${value.material.title}`)
      }
      // duplicate: do nothing (already logged)
    }
    // rejected (non-P2002): already handled by Promise.allSettled, item is lost but others succeed
  }

  await db.feed.update({
    where: { id: source.id },
    data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
  })

  send(ctx, {
    type: "source_complete",
    sourceId: source.id,
    sourceName: source.name,
    stats: {
      parsed: items.length,
      new: actuallyCreated,
      approved: sourceApproved,
      filtered: sourceFiltered,
    },
  })
}

// GET /api/parse-stream - Parse all active sources and stream materials in real-time
export async function GET(request: NextRequest) {
  // Auth + rate limit run BEFORE the stream is built so a blocked caller gets a
  // real HTTP status (RAD-296) instead of a 200 stream with an in-band error.
  // An EventSource caller cannot read a status, so every refusal below reaches
  // it as one readable SSE frame instead (RAD-326, RAD-406).
  const session = await auth()
  if (!session?.user?.id) {
    return streamableRefusal(request, NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
  }
  const userId = session.user.id
  const role = session.user.role || "USER"
  const limited = checkUserRateLimit("parse-stream", userId, role, RATE_LIMITS.parseStream)
  if (limited) return streamableRefusal(request, limited)

  // RAD-297: unverified accounts get the demo, not paid AI work.
  const emailGate = await requireVerifiedEmail(userId, role)
  if (emailGate) return streamableRefusal(request, emailGate)

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const ctx: StreamContext = { controller, encoder, closed: false }
      // A source can legitimately emit nothing for up to SOURCE_TIMEOUT_MS.
      // Keep the connection provably alive through the CDN in the meantime.
      const stopHeartbeat = startHeartbeat(controller, encoder)

      // Settled in `finally` as a backstop: `finishParseRun` no-ops unless the
      // run is still `running`, so the normal path's call and this one cannot
      // double-settle — and a throw between the claim and the end can no longer
      // leave the entry `running` forever, which would refuse every later run
      // ("A parse is already running") until the process recycled.
      let run: ParseRunHandle | null = null
      let runResults: ParseResults | null = null
      let skippedByStop = false

      try {
        // (auth resolved above, before the stream was constructed)

        // Subscription gate (admin bypass in helper)
        const gateUser = await db.user.findUnique({
          where: { id: userId },
          include: { userSettings: true, subscription: true },
        })
        const allowed = hasActiveAccess({
          role,
          onboardingCompleted: gateUser?.userSettings?.onboardingCompleted ?? true,
          subscription: gateUser?.subscription
            ? {
                status: gateUser.subscription.status,
                currentPeriodEnd: gateUser.subscription.currentPeriodEnd,
                cancelAtPeriodEnd: gateUser.subscription.cancelAtPeriodEnd,
              }
            : null,
          complimentaryAccessUntil: gateUser?.complimentaryAccessUntil ?? null,
          accountCreatedAt: gateUser?.createdAt ?? new Date(0),
          now: new Date(),
        })
        if (!allowed) {
          send(ctx, { type: "error", error: "Subscription required" })
          closeStream(ctx)
          return
        }

        // Twitter/X parsing is Pro-only. Lite users keep their X feeds but they
        // are excluded from the parse set (the source-type filter below), so a
        // retained X feed is never fetched.
        const includesTwitter = subscriptionIncludesTwitter({
          role,
          onboardingCompleted: gateUser?.userSettings?.onboardingCompleted ?? true,
          subscription: gateUser?.subscription
            ? {
                status: gateUser.subscription.status,
                stripePriceId: gateUser.subscription.stripePriceId,
                currentPeriodEnd: gateUser.subscription.currentPeriodEnd,
                cancelAtPeriodEnd: gateUser.subscription.cancelAtPeriodEnd,
              }
            : null,
          accountCreatedAt: gateUser?.createdAt ?? new Date(0),
          now: new Date(),
        })

        console.log("[PARSE-STREAM] Starting parse request for user:", userId)

        // Get sourceIds from query params
        const searchParams = request.nextUrl.searchParams
        const sourceIdsParam = searchParams.get("sourceIds")
        const sourceIds = sourceIdsParam ? sourceIdsParam.split(",") : undefined

        console.log("[PARSE-STREAM] Source IDs filter:", sourceIds)

        // Get sources to parse (only user's sources)
        const sources = await db.feed.findMany({
          // hidden:false keeps self-filling collections' backing monitor feeds
          // out of the polling path — they're driven by the Parallel webhook on
          // their own cadence; re-parsing them here would re-pay Parallel and
          // double-ingest off-schedule.
          where: parseableFeedWhere({ userId, includesTwitter, sourceIds }),
        })
        console.log(`[PARSE-STREAM] Found ${sources.length} active sources`)

        // The eligible-source manifest, and the only trustworthy denominator
        // for progress: it is emitted after ownership, isActive, hidden and the
        // non-Pro Twitter exclusion have all been applied. Additive: clients
        // that do not know this event ignore it.
        const manifest = {
          type: "parse_start",
          sourceCount: sources.length,
          sources: sources.map(s => ({ id: s.id, name: s.name })),
        }

        if (sources.length === 0) {
          // A run with no eligible sources still has to tell the client its
          // denominator is 0, rather than leaving the card to infer one. There
          // is nothing to claim: no source will ever settle.
          send(ctx, manifest)
          send(ctx, {
            type: "parse_complete",
            results: { parsed: 0, evaluated: 0, approved: 0, filtered: 0, errors: [] },
          })
          closeStream(ctx)
          return
        }

        // The run is the server's from here on, and it is claimed BEFORE the
        // manifest goes out: a second tab (or a retry) must get the run-level
        // error and nothing else, not a `parse_start` its card would then wait
        // on forever.
        const claimedRun = beginParseRun(userId, sources.length)
        if (!claimedRun) {
          // Both keys: the wire has carried run-level errors under `error`
          // (Subscription required) while the card's reducer normalizes either.
          const message = "A parse is already running. Wait for it to finish, then try again."
          send(ctx, { type: "error", error: message, message })
          closeStream(ctx)
          return
        }
        run = claimedRun

        // The run id lets a card that loses this stream follow THIS run, not
        // whichever run the per-user registry holds when it asks (RAD-407).
        send(ctx, { ...manifest, runId: claimedRun.id })

        const results: ParseResults = {
          parsed: 0,
          evaluated: 0,
          approved: 0,
          filtered: 0,
          errors: [],
          approvedMaterialIds: [],
        }
        runResults = results

        // Parse sources concurrently with p-limit
        const sourceLimit = pLimit(SOURCE_CONCURRENCY)
        // What the client polls: how many sources have settled, and the running
        // totals. Kept beside `results` because the registry takes absolute
        // values — a second terminal event can never double a source.
        let settledSources = 0
        const tasks = sources.map(source => sourceLimit(async () => {
          // Only an explicit stop skips a source now. A dropped transport used
          // to reach here as `request.signal.aborted` and skip everything not
          // yet started, which is the bug RAD-346 exists to fix.
          if (isStopRequested(claimedRun)) {
            skippedByStop = true
            console.log("[PARSE-STREAM] Run stopped, skipping source:", source.name)
            return
          }

          try {
            send(ctx, {
              type: "source_start",
              sourceId: source.id,
              sourceName: source.name,
            })

            console.log(`[PARSE-STREAM] Processing source: ${source.name} (${source.type})`)

            // Watchdog: a single hung source must never block Promise.allSettled (RAD-232).
            await withSourceTimeout((async () => {
            if (source.type === "RSS") {
              console.log(`[PARSE-STREAM] Fetching RSS feed: ${source.url}`)
              const items = await parseRSSFeed(source.url, { knownItems: knownMaterialKeys(source.id) })
              console.log(`[PARSE-STREAM] Parsed ${items.length} items from ${source.name}`)
              await processSourceItems(source, items, userId, results, ctx)
            } else if (source.type === "TELEGRAM") {
              console.log(`[PARSE-STREAM] Fetching Telegram channel: ${source.url}`)
              const items = await parseTelegramChannel(source.url, 10)
              console.log(`[PARSE-STREAM] Parsed ${items.length} messages from ${source.name}`)
              await processSourceItems(source, items, userId, results, ctx)
            } else if (source.type === "TWITTER") {
              console.log(`[PARSE-STREAM] Fetching Twitter source: ${source.url}`)
              const config = parseSourceUrlToConfig(source.url)
              if (!config) {
                throw new Error(`Invalid Twitter source URL: ${source.url}`)
              }
              // Find the latest tweet ID we already have for incremental fetching
              // Order by createdAt (DB insertion time) and pick the max numeric ID
              const recentMaterials = await db.material.findMany({
                where: { sourceId: source.id, externalId: { startsWith: "twitter:" } },
                orderBy: { createdAt: "desc" },
                take: 10,
                select: { externalId: true },
              })
              const sinceId = recentMaterials.length > 0
                ? recentMaterials
                    .map(m => m.externalId?.replace("twitter:", "") || "0")
                    .sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))[0]
                : undefined
              const items = await parseTwitterSource(config, sinceId, { includeRetweets: source.includeRetweets })
              console.log(`[PARSE-STREAM] Parsed ${items.length} tweets from ${source.name}`)
              await processSourceItems(source, items, userId, results, ctx)
            } else if (source.type === "YOUTUBE") {
              console.log(`[PARSE-STREAM] Fetching YouTube channel: ${source.url}`)
              // Transcripts are fetched only for videos we haven't ingested yet —
              // known ids come back shallow and are dropped by dedup anyway.
              const existing = await db.material.findMany({
                where: { sourceId: source.id, externalId: { startsWith: "youtube:" } },
                select: { externalId: true },
              })
              const knownExternalIds = new Set(
                existing.map((m) => m.externalId).filter((id): id is string => !!id)
              )
              const items = await parseYouTubeChannel(source.url, { knownExternalIds })
              console.log(`[PARSE-STREAM] Parsed ${items.length} videos from ${source.name}`)
              await processSourceItems(source, items, userId, results, ctx)
            } else if (source.type === "INTEREST" || source.type === "EVENT_TRIGGER") {
              console.log(`[PARSE-STREAM] Fetching Interest events for: ${source.name}`)

              if (!source.parallelMonitorId) {
                console.log(`[PARSE-STREAM] No monitor ID for ${source.name}, skipping`)
                send(ctx, {
                  type: "source_complete",
                  sourceId: source.id,
                  sourceName: source.name,
                  stats: { parsed: 0, new: 0, approved: 0, filtered: 0 },
                })
                return
              }

              const parseResult = await parseInterestSource(source.id, userId, "7d")

              // The parser stores a real evaluation on every material it
              // creates, so the interest path must count like every other
              // source type does. Counting `created` as approved sent the
              // card's "AI approved" number above what the INBOX grid gained
              // at parse_complete, and fired the auto-group gate on runs where
              // every material had been filtered out (RAD-333).
              const sourceApproved = parseResult.materials.filter(
                (m) => m.aiEvaluation === AIEvaluation.APPROVED
              ).length
              const sourceFiltered = parseResult.created - sourceApproved

              results.parsed += parseResult.total
              results.evaluated += parseResult.created
              results.approved += sourceApproved
              results.filtered += sourceFiltered

              send(ctx, {
                type: "items_fetched",
                sourceId: source.id,
                count: parseResult.total,
              })

              if (parseResult.materials && parseResult.materials.length > 0) {
                for (let i = 0; i < parseResult.materials.length; i++) {
                  send(ctx, {
                    type: "material_created",
                    sourceId: source.id,
                    material: parseResult.materials[i],
                    progress: {
                      current: i + 1,
                      total: parseResult.materials.length,
                    },
                  })
                }
              }

              send(ctx, {
                type: "source_complete",
                sourceId: source.id,
                sourceName: source.name,
                stats: {
                  parsed: parseResult.total,
                  new: parseResult.created,
                  approved: sourceApproved,
                  filtered: sourceFiltered,
                },
              })

              await db.feed.update({
                where: { id: source.id },
                data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
              })

              console.log(`[PARSE-STREAM] Interest source ${source.name}: ${parseResult.created} new, ${parseResult.skipped} skipped`)
            }
            })(), source.name)
          } catch (error) {
            const rawMessage = formatSourceError(source.type, source.name, error)
            const persistedMessage = truncateErrorMessage(rawMessage)
            console.error(`[PARSE-STREAM ERROR] ${rawMessage}`)
            results.errors.push(persistedMessage)

            send(ctx, {
              type: "error",
              sourceId: source.id,
              sourceName: source.name,
              message: persistedMessage,
            })

            await db.feed.update({
              where: { id: source.id },
              data: { status: "ERROR", errorMessage: persistedMessage },
            })
          } finally {
            settledSources++
            syncRunProgress(claimedRun, {
              processed: settledSources,
              approved: results.approved,
              filtered: results.filtered,
            })
          }
        }))

        await Promise.allSettled(tasks)

        // The transport no longer decides the outcome: the run reports what it
        // actually did. Only a stop that genuinely kept a source from running
        // suppresses `parse_complete` — a stop landing after the last source
        // settled describes a run that produced everything.
        const stopped = isStopRequested(claimedRun) && skippedByStop
        finishParseRun(claimedRun, { status: stopped ? "stopped" : "done", results })
        console.log(`[PARSE-STREAM] Parsing ${stopped ? "stopped" : "completed"}, closing stream`)

        if (!stopped) {
          send(ctx, { type: "parse_complete", results })
        }

        closeStream(ctx)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        // Reaching here is a genuine run failure, not a dead client: every write
        // to a closed stream no-ops above, so a lost transport cannot log FATAL.
        console.error("[PARSE-STREAM FATAL ERROR]:", error)

        send(ctx, { type: "error", message: errorMessage })

        closeStream(ctx)
      } finally {
        // Every exit path — completion, early return, abort, fatal error —
        // must clear the interval, or it keeps firing against a closed
        // controller for the life of the process.
        stopHeartbeat()
        // Backstop for a path that threw before the settle above (see the
        // hoisted `run`). Idempotent: the normal path already finished it.
        if (run && runResults) {
          finishParseRun(run, {
            status: isStopRequested(run) && skippedByStop ? "stopped" : "done",
            results: runResults,
          })
        }
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
