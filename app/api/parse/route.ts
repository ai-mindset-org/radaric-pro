import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { AIEvaluation, MaterialStatus } from "@prisma/client"
import { db } from "@/lib/db"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { knownMaterialKeys } from "@/lib/materials/known-keys"
import { parseTelegramChannel } from "@/lib/parsers/telegram"
import { parseTwitterSource, parseSourceUrlToConfig } from "@/lib/parsers/twitter"
import { parseYouTubeChannel } from "@/lib/parsers/youtube"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { formatSourceError, truncateErrorMessage } from "@/lib/feed-error"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { computeMediaBackfill } from "@/lib/story-aggregator/media-backfill"

export const maxDuration = 120

// POST /api/parse - Parse all active sources for current user and evaluate materials
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    // RAD-296: bounded per-user spend — this route drives AI evaluation.
    const limited = checkUserRateLimit("parse", userId, role, RATE_LIMITS.parse)
    if (limited) return limited

    // RAD-297: unverified accounts get the demo, not paid AI work.
    const emailGate = await requireVerifiedEmail(userId, role)
    if (emailGate) return emailGate

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    console.log("[PARSE] Starting parse request for user:", userId)
    const { sourceIds } = await request.json().catch(() => ({}))
    console.log("[PARSE] Source IDs filter:", sourceIds)

    // Twitter/X parsing is Pro-only — exclude X feeds for non-Pro users (kept in
    // the DB, locked in the UI, never fetched). requireActiveSubscription above
    // returns only a gate response, so resolve the entitlement separately.
    const { includesTwitter } = await getTwitterEntitlement(userId, role)

    // Get sources to parse (only user's sources)
    const sources = await db.feed.findMany({
      // hidden:false excludes self-filling collections' backing monitor feeds —
      // they're webhook-driven, not polled (see parse-stream for the rationale).
      where: {
        ...(sourceIds ? { id: { in: sourceIds } } : {}),
        userId,
        isActive: true,
        hidden: false,
        ...(includesTwitter ? {} : { type: { not: "TWITTER" } }),
      },
    })
    console.log(`[PARSE] Found ${sources.length} active sources`)

    if (sources.length === 0) {
      console.log("[PARSE] No active feeds found")
      return NextResponse.json(
        { message: "No active feeds to parse", sources: [] },
        { status: 200 }
      )
    }

    const results = {
      parsed: 0,
      evaluated: 0,
      approved: 0,
      filtered: 0,
      errors: [] as string[],
    }

    // Parse each source
    for (const source of sources) {
      try {
        console.log(`[PARSE] Processing source: ${source.name} (${source.type})`)

        if (source.type === "RSS") {
          // Parse RSS feed
          console.log(`[PARSE] Fetching RSS feed: ${source.url}`)
          const items = await parseRSSFeed(source.url, { knownItems: knownMaterialKeys(source.id) })
          console.log(`[PARSE] Parsed ${items.length} items from ${source.name}`)
          results.parsed += items.length

          if (items.length === 0) {
            console.log(`[PARSE] No items found for ${source.name}, skipping`)
            await db.feed.update({
              where: { id: source.id },
              data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
            })
            continue
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
            select: {
              url: true,
              externalId: true
            }
          })

          // Filter out items that already exist in database
          const newItems = items.filter(item =>
            !existingMaterials.some(existing =>
              (item.url && existing.url === item.url) ||
              (item.externalId && existing.externalId === item.externalId)
            )
          )

          console.log(`[PARSE] Found ${newItems.length} new items out of ${items.length} total (${items.length - newItems.length} duplicates skipped)`)

          if (newItems.length === 0) {
            console.log(`[PARSE] No new items for ${source.name}, skipping AI evaluation`)
            // Still update lastParsedAt to track that we checked this source
            await db.feed.update({
              where: { id: source.id },
              data: {
                lastParsedAt: new Date(),
                status: "ACTIVE",
                errorMessage: null,
              },
            })
            continue
          }

          // Evaluate only NEW materials with AI
          console.log(`[PARSE] Evaluating ${newItems.length} new items with AI`)
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

          // Save materials to database (RSS)
          const materialsToCreate = newItems.map((item, index) => ({
            sourceId: source.id,
            title: item.title,
            url: item.url,
            externalId: item.externalId,
            content: item.content,
            // RSS doesn't have entities, omit field (will be null in DB)
            publishedAt: item.publishedAt,
            thumbnailUrl: item.thumbnailUrl,
            mediaUrls: item.mediaUrls,
            aiEvaluation: evaluations[index].relevant ? AIEvaluation.APPROVED : AIEvaluation.FILTERED,
            aiConfidence: evaluations[index].confidence,
            aiReasoning: evaluations[index].reasoning,
            userStatus: MaterialStatus.NEW,
          }))

          await db.material.createMany({
            data: materialsToCreate,
            skipDuplicates: true,
          })

          // Count approved/filtered
          evaluations.forEach((e) => {
            if (e.relevant) {
              results.approved++
            } else {
              results.filtered++
            }
          })

          // Update source last parsed time
          await db.feed.update({
            where: { id: source.id },
            data: {
              lastParsedAt: new Date(),
              status: "ACTIVE",
              errorMessage: null,
            },
          })
        } else if (source.type === "YOUTUBE") {
          // Parse YouTube channel. This route only serves the one-shot onboarding
          // first parse, where every video is new — so no knownExternalIds
          // optimization here (intentional asymmetry with parse-stream).
          console.log(`[PARSE] Fetching YouTube channel: ${source.url}`)
          const items = await parseYouTubeChannel(source.url)
          console.log(`[PARSE] Parsed ${items.length} videos from ${source.name}`)
          results.parsed += items.length

          if (items.length === 0) {
            console.log(`[PARSE] No items found for ${source.name}, skipping`)
            await db.feed.update({
              where: { id: source.id },
              data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
            })
            continue
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
            select: {
              url: true,
              externalId: true
            }
          })

          const newItems = items.filter(item =>
            !existingMaterials.some(existing =>
              (item.url && existing.url === item.url) ||
              (item.externalId && existing.externalId === item.externalId)
            )
          )

          console.log(`[PARSE] Found ${newItems.length} new items out of ${items.length} total (${items.length - newItems.length} duplicates skipped)`)

          if (newItems.length === 0) {
            console.log(`[PARSE] No new items for ${source.name}, skipping AI evaluation`)
            await db.feed.update({
              where: { id: source.id },
              data: {
                lastParsedAt: new Date(),
                status: "ACTIVE",
                errorMessage: null,
              },
            })
            continue
          }

          console.log(`[PARSE] Evaluating ${newItems.length} new items with AI`)
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

          // Save materials to database (YouTube)
          const materialsToCreate = newItems.map((item, index) => ({
            sourceId: source.id,
            title: item.title,
            url: item.url,
            externalId: item.externalId,
            content: item.content,
            publishedAt: item.publishedAt,
            thumbnailUrl: item.thumbnailUrl,
            mediaUrls: item.mediaUrls,
            aiEvaluation: evaluations[index].relevant ? AIEvaluation.APPROVED : AIEvaluation.FILTERED,
            aiConfidence: evaluations[index].confidence,
            aiReasoning: evaluations[index].reasoning,
            userStatus: MaterialStatus.NEW,
          }))

          await db.material.createMany({
            data: materialsToCreate,
            skipDuplicates: true,
          })

          evaluations.forEach((e) => {
            if (e.relevant) {
              results.approved++
            } else {
              results.filtered++
            }
          })

          await db.feed.update({
            where: { id: source.id },
            data: {
              lastParsedAt: new Date(),
              status: "ACTIVE",
              errorMessage: null,
            },
          })
        } else if (source.type === "TELEGRAM") {
          // Parse Telegram channel
          console.log(`[PARSE] Fetching Telegram channel: ${source.url}`)
          const items = await parseTelegramChannel(source.url, 20)
          console.log(`[PARSE] Parsed ${items.length} messages from ${source.name}`)
          results.parsed += items.length

          if (items.length === 0) {
            console.log(`[PARSE] No items found for ${source.name}, skipping`)
            await db.feed.update({
              where: { id: source.id },
              data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
            })
            continue
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
            select: {
              id: true,
              url: true,
              externalId: true,
              mediaUrls: true,
              thumbnailUrl: true,
              content: true
            }
          })

          // Filter out items that already exist in database
          const newItems = items.filter(item =>
            !existingMaterials.some(existing =>
              (item.url && existing.url === item.url) ||
              (item.externalId && existing.externalId === item.externalId)
            )
          )

          console.log(`[PARSE] Found ${newItems.length} new items out of ${items.length} total (${items.length - newItems.length} duplicates skipped)`)

          // RAD-359: backfill media on pre-feature Telegram rows BEFORE the
          // all-duplicates early return. Media/content only, no AI re-run.
          {
            const reconciled = new Set<string>()
            for (const item of items) {
              for (const stored of existingMaterials) {
                if (reconciled.has(stored.id)) continue
                const matches =
                  (!!item.url && stored.url === item.url) ||
                  (!!item.externalId && stored.externalId === item.externalId)
                if (!matches) continue

                // First fresh item matching this stored row wins.
                reconciled.add(stored.id)

                const payload = computeMediaBackfill(stored, item)
                if (!payload) break // media already mirrored

                try {
                  await db.material.update({ where: { id: stored.id }, data: payload })
                } catch (error) {
                  // ERR-1: a rejected backfill must not fail the source.
                  console.error(`[PARSE] Media backfill failed for material ${stored.id}:`, error)
                }
                break
              }
            }
          }

          if (newItems.length === 0) {
            console.log(`[PARSE] No new items for ${source.name}, skipping AI evaluation`)
            // Still update lastParsedAt to track that we checked this source
            await db.feed.update({
              where: { id: source.id },
              data: {
                lastParsedAt: new Date(),
                status: "ACTIVE",
                errorMessage: null,
              },
            })
            continue
          }

          // Evaluate only NEW materials with AI
          console.log(`[PARSE] Evaluating ${newItems.length} new items with AI`)
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

          // Save materials to database (Telegram)
          const materialsToCreate = newItems.map((item, index) => ({
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
            aiEvaluation: evaluations[index].relevant ? AIEvaluation.APPROVED : AIEvaluation.FILTERED,
            aiConfidence: evaluations[index].confidence,
            aiReasoning: evaluations[index].reasoning,
            userStatus: MaterialStatus.NEW,
          }))

          await db.material.createMany({
            data: materialsToCreate,
            skipDuplicates: true,
          })

          // Count approved/filtered
          evaluations.forEach((e) => {
            if (e.relevant) {
              results.approved++
            } else {
              results.filtered++
            }
          })

          // Update source last parsed time
          await db.feed.update({
            where: { id: source.id },
            data: {
              lastParsedAt: new Date(),
              status: "ACTIVE",
              errorMessage: null,
            },
          })
        } else if (source.type === "TWITTER") {
          // Parse Twitter via TwitterAPI.io
          console.log(`[PARSE] Fetching Twitter source: ${source.url}`)

          const config = parseSourceUrlToConfig(source.url)
          if (!config) {
            throw new Error(`Invalid Twitter source URL: ${source.url}`)
          }

          const items = await parseTwitterSource(config, undefined, { includeRetweets: source.includeRetweets })
          console.log(`[PARSE] Parsed ${items.length} tweets from ${source.name}`)
          results.parsed += items.length

          if (items.length === 0) {
            console.log(`[PARSE] No items found for ${source.name}, skipping`)
            await db.feed.update({
              where: { id: source.id },
              data: { lastParsedAt: new Date(), status: "ACTIVE", errorMessage: null },
            })
            continue
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
            select: {
              url: true,
              externalId: true
            }
          })

          // Filter out items that already exist in database
          const newItems = items.filter(item =>
            !existingMaterials.some(existing =>
              (item.url && existing.url === item.url) ||
              (item.externalId && existing.externalId === item.externalId)
            )
          )

          console.log(`[PARSE] Found ${newItems.length} new tweets out of ${items.length} total (${items.length - newItems.length} duplicates skipped)`)

          if (newItems.length === 0) {
            console.log(`[PARSE] No new items for ${source.name}, skipping AI evaluation`)
            await db.feed.update({
              where: { id: source.id },
              data: {
                lastParsedAt: new Date(),
                status: "ACTIVE",
                errorMessage: null,
              },
            })
            continue
          }

          // Evaluate only NEW materials with AI
          console.log(`[PARSE] Evaluating ${newItems.length} new tweets with AI`)
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

          // Save materials to database (Twitter)
          const materialsToCreate = newItems.map((item, index) => ({
            sourceId: source.id,
            title: item.title,
            url: item.url,
            externalId: item.externalId,
            content: item.content,
            publishedAt: item.publishedAt,
            thumbnailUrl: item.thumbnailUrl,
            mediaUrls: item.mediaUrls,
            aiEvaluation: evaluations[index].relevant ? AIEvaluation.APPROVED : AIEvaluation.FILTERED,
            aiConfidence: evaluations[index].confidence,
            aiReasoning: evaluations[index].reasoning,
            userStatus: MaterialStatus.NEW,
          }))

          await db.material.createMany({
            data: materialsToCreate,
            skipDuplicates: true,
          })

          // Count approved/filtered
          evaluations.forEach((e) => {
            if (e.relevant) {
              results.approved++
            } else {
              results.filtered++
            }
          })

          // Update source last parsed time
          await db.feed.update({
            where: { id: source.id },
            data: {
              lastParsedAt: new Date(),
              status: "ACTIVE",
              errorMessage: null,
            },
          })
        }
      } catch (error) {
        const rawMessage = formatSourceError(source.type, source.name, error)
        const persistedMessage = truncateErrorMessage(rawMessage)
        console.error(`[PARSE ERROR] ${rawMessage}`)
        console.error(`[PARSE ERROR] Stack:`, error instanceof Error ? error.stack : 'No stack trace')
        results.errors.push(persistedMessage)

        // Update source status to ERROR with informative message
        await db.feed.update({
          where: { id: source.id },
          data: { status: "ERROR", errorMessage: persistedMessage },
        })
      }
    }

    // Invalidate Next.js cache for materials page
    revalidatePath("/posts")
    revalidatePath("/")

    return NextResponse.json({
      success: true,
      message: "Parsing completed",
      results,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : 'No stack trace'

    console.error("[PARSE FATAL ERROR]:", error)
    console.error("[PARSE FATAL ERROR] Message:", errorMessage)
    console.error("[PARSE FATAL ERROR] Stack:", errorStack)

    return NextResponse.json(
      {
        error: "Failed to parse feeds",
        details: errorMessage,
        stack: process.env.NODE_ENV === 'development' ? errorStack : undefined
      },
      { status: 500 }
    )
  }
}
