import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { sourceSchema, vetTelegramFeedInput } from "@/lib/validations/feed"
import { resolveYouTubeChannel, YouTubeResolveError } from "@/lib/youtube"
import { buildTwitterSourceUrl, type TwitterSourceConfig } from "@/lib/parsers/twitter"
import { createParallelMonitor, deleteParallelMonitor, buildWebhookUrl } from "@/lib/parsers/interest"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { saveSourceCover } from "@/lib/feed-cover"
import { saveSourceFavicon } from "@/lib/feed-favicon"
import {
  validateRssSource,
  validateTelegramSource,
  TELEGRAM_REJECT_MESSAGES,
  RSS_REJECT_MESSAGES,
} from "@/lib/feed-validation"

// GET /api/feeds - Get all feeds for current user
// Query params: ?active=true - returns only active feeds with minimal fields (id, name)
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get('active') === 'true'

    if (activeOnly) {
      // Return only active feeds with minimal fields for chunking
      const sources = await db.feed.findMany({
        where: {
          userId,
          isActive: true,
          status: "ACTIVE",
          hidden: false,
        },
        select: {
          id: true,
          name: true,
        },
        orderBy: { createdAt: "desc" },
      })
      return NextResponse.json(sources)
    }

    // Return all feeds with full details for feeds page. Backing monitor feeds
    // for self-filling collections are hidden — the user manages them as
    // collections, not feeds.
    const sources = await db.feed.findMany({
      where: { userId, hidden: false },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { materials: true },
        },
      },
    })

    return NextResponse.json(sources)
  } catch (error) {
    console.error("Error fetching feeds:", error)
    return NextResponse.json(
      { error: "Failed to fetch feeds" },
      { status: 500 }
    )
  }
}

// POST /api/feeds - Create a new feed
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const body = await request.json()
    const validatedData = sourceSchema.parse(body)

    // Twitter/X parsing is a Pro-only capability. Gate before building the URL
    // or writing any row so a Lite user can't create an X feed.
    if (validatedData.type === "TWITTER") {
      const { includesTwitter } = await getTwitterEntitlement(userId, role)
      if (!includesTwitter) {
        return NextResponse.json(
          { error: "Twitter/X parsing requires Radaric Pro", code: "TWITTER_NOT_IN_PLAN" },
          { status: 402 }
        )
      }
    }

    // For Twitter sources, generate x.com URL from twitterType + twitterValue
    let url = validatedData.url || ""

    // Rides along on the 201 when the source was created but something about it
    // is worth telling the user (empty, or unverifiable). Both the Telegram and
    // the RSS block below can set it.
    let warning: "FEED_EMPTY" | "FEED_UNVERIFIED" | null = null

    // Canonicalize Telegram channel URLs (telegram.me / t.me/s/… / post links → https://t.me/<channel>)
    if (validatedData.type === "TELEGRAM" && url) {
      // Only a public channel username may be stored (RAD-364). Anything else —
      // "me", a phone number, a peer id — is resolved by the worker's GramJS
      // session against the OPERATOR's own account. A private invite link is
      // refused with its own code: the worker reads only public channels.
      const vetted = vetTelegramFeedInput(url)
      if (!vetted.ok) {
        return NextResponse.json(
          { error: TELEGRAM_REJECT_MESSAGES[vetted.code], code: vetted.code, url },
          { status: 400 }
        )
      }
      url = vetted.url

      // A re-add shouldn't pay for a probe first.
      const duplicate = await db.feed.findFirst({ where: { userId, url }, select: { id: true } })
      if (duplicate) {
        return NextResponse.json(
          { error: "This source is already in your feeds", code: "DUPLICATE_FEED" },
          { status: 409 }
        )
      }

      // Reject sources that can never yield a post. A bot or a personal account
      // resolves fine and parses to zero messages forever, which reads to the
      // user as "parsing is broken". Inconclusive probes fall through: never
      // block a real channel on a worker hiccup.
      const tg = await validateTelegramSource(url)
      if (tg.verdict === "reject") {
        // url is the canonicalized form — the client renders the handle from it.
        return NextResponse.json(
          { error: TELEGRAM_REJECT_MESSAGES[tg.code], code: tg.code, url },
          { status: 400 }
        )
      }
      // We created a source we could not check. Staying silent here is what
      // makes the reported bug reproduce whenever the worker is down: the user
      // adds a bot, sees a clean success, and waits forever for posts.
      if (tg.verdict === "unknown") warning = "FEED_UNVERIFIED"
    }

    // Reject a URL that is provably not a feed, and flag one we couldn't verify.
    // Until now RSS went straight to db.feed.create, so a typo'd domain or a
    // plain web page became a source that silently never produced material.
    if (validatedData.type === "RSS" && url) {
      const duplicate = await db.feed.findFirst({ where: { userId, url }, select: { id: true } })
      if (duplicate) {
        return NextResponse.json(
          { error: "This source is already in your feeds", code: "DUPLICATE_FEED" },
          { status: 409 }
        )
      }

      const rss = await validateRssSource(url)
      if (rss.ok === false) {
        return NextResponse.json(
          { error: RSS_REJECT_MESSAGES[rss.code], code: rss.code, url },
          { status: 400 }
        )
      }
      // A real feed with nothing in it — legitimate for a brand-new feed, but
      // the user needs to know why their inbox stays empty (the reported case:
      // an Atom feed for a repo that has never cut a release).
      if (rss.ok === true && rss.itemCount === 0) warning = "FEED_EMPTY"
      if (rss.ok === "unknown") warning = "FEED_UNVERIFIED"
    }

    // Canonicalize YouTube input (@handle / channel / video / feed-XML →
    // https://www.youtube.com/channel/UC…). Cross-form duplicate guard:
    // @@unique([userId, url]) only catches identical strings, so a channel
    // already added as a plain RSS feed-XML URL must be caught by channel id.
    let name = validatedData.name
    if (validatedData.type === "YOUTUBE" && url) {
      let resolved
      try {
        resolved = await resolveYouTubeChannel(url)
      } catch (error) {
        if (error instanceof YouTubeResolveError) {
          return NextResponse.json({ error: error.message }, { status: 400 })
        }
        throw error
      }

      const duplicate = await db.feed.findFirst({
        where: { userId, url: { contains: resolved.channelId } },
        select: { id: true },
      })
      if (duplicate) {
        return NextResponse.json(
          { error: "This channel is already in your feeds", code: "DUPLICATE_FEED" },
          { status: 409 }
        )
      }

      // Prefer the real channel title when the given name is just the pasted
      // handle/URL echoed back rather than a deliberate custom name.
      const bareName = name.trim().toLowerCase().replace(/^@/, "")
      const rawInput = url.trim().toLowerCase()
      if (resolved.title && (rawInput === name.trim().toLowerCase() || rawInput.includes(`@${bareName}`))) {
        name = resolved.title
      }

      url = resolved.channelUrl
    }
    let parallelMonitorId: string | null = null
    let interestQuery: string | null = null
    let interestCadence: "HOURLY" | "DAILY" | "WEEKLY" | null = null

    if (
      validatedData.type === "TWITTER" &&
      validatedData.twitterType &&
      validatedData.twitterValue
    ) {
      // Search type is not supported
      if (validatedData.twitterType === "SEARCH") {
        return NextResponse.json(
          { error: "Twitter search is not supported. Use specific accounts." },
          { status: 400 }
        )
      }
      const config: TwitterSourceConfig = {
        type: validatedData.twitterType,
        value: validatedData.twitterValue,
      }
      url = buildTwitterSourceUrl(config)
      console.log(`[Feeds API] Generated Twitter URL: ${url}`)
    }

    // For Interest sources, create Parallel Monitor
    if (
      (validatedData.type === "INTEREST" || validatedData.type === "EVENT_TRIGGER") &&
      validatedData.interestQuery &&
      validatedData.interestCadence
    ) {
      // RAD-297: a monitor is a paid Parallel resource — an unverified demo
      // account may add plain feeds but must not start monitors.
      const emailGate = await requireVerifiedEmail(userId, role)
      if (emailGate) return emailGate

      // Check if Parallel API is configured
      const settings = await db.settings.findFirst()
      if (!settings?.parallelApiKey) {
        return NextResponse.json(
          { error: "Parallel API is not configured. Add the API key in settings." },
          { status: 400 }
        )
      }

      try {
        const webhookUrl = buildWebhookUrl()
        parallelMonitorId = await createParallelMonitor(
          {
            query: validatedData.interestQuery,
            cadence: validatedData.interestCadence.toLowerCase() as "hourly" | "daily" | "weekly",
          },
          webhookUrl
        )
        interestQuery = validatedData.interestQuery
        interestCadence = validatedData.interestCadence
        url = `parallel://monitor/${parallelMonitorId}`
        console.log(`[Feeds API] Created Parallel monitor: ${parallelMonitorId}`)
      } catch (monitorError) {
        console.error("[Feeds API] Failed to create Parallel monitor:", monitorError)
        return NextResponse.json(
          { error: `Failed to create monitor: ${monitorError instanceof Error ? monitorError.message : "Unknown error"}` },
          { status: 500 }
        )
      }
    }

    // Create feed in DB with rollback if it fails
    let source
    try {
      source = await db.feed.create({
        data: {
          userId,
          url,
          type: validatedData.type,
          name,
          coverUrl: validatedData.coverUrl || null,
          customPrompt: validatedData.customPrompt || null,
          isActive: validatedData.isActive,
          includeRetweets: validatedData.includeRetweets ?? false,
          status: "ACTIVE",
          parallelMonitorId,
          interestQuery,
          interestCadence,
        },
      })
    } catch (dbError) {
      // Rollback: delete Parallel monitor if DB save failed
      if (parallelMonitorId) {
        console.error("[Feeds API] DB save failed, rolling back Parallel monitor:", parallelMonitorId)
        try {
          await deleteParallelMonitor(parallelMonitorId)
          console.log("[Feeds API] Rollback successful - monitor deleted")
        } catch (rollbackError) {
          console.error("[Feeds API] Rollback failed - orphan monitor:", parallelMonitorId, rollbackError)
        }
      }
      throw dbError
    }

    // Fire-and-forget: auto-fetch cover if not provided
    if (!source.coverUrl) {
      saveSourceCover(source.id, userId).catch((err) =>
        console.error(`[Feeds API] Background cover fetch failed for ${source.id}:`, err)
      )
    }

    // Fire-and-forget: auto-fetch favicon for the sidebar source list.
    // No-op for Telegram/Twitter (avatar coverUrl is the better icon) and
    // Parallel monitors (no website).
    saveSourceFavicon(source.id, userId).catch((err) =>
      console.error(`[Feeds API] Background favicon fetch failed for ${source.id}:`, err)
    )

    // Refresh the dashboard layout so the new source appears in the sidebar
    // without a hard reload (RAD-210).
    revalidatePath("/", "layout")

    return NextResponse.json(warning ? { ...source, warning } : source, { status: 201 })
  } catch (error) {
    console.error("Error creating feed:", error)

    if (error instanceof Error && error.name === "ZodError") {
      return NextResponse.json(
        { error: "Invalid input data", details: error },
        { status: 400 }
      )
    }

    // @@unique([userId, url]) — one-click brand presets make repeat adds easy
    // (e.g. the default Product Hunt feed), so answer with a friendly 409 (RAD-268)
    if (error && typeof error === "object" && (error as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "This source is already in your feeds", code: "DUPLICATE_FEED" },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { error: "Failed to create feed" },
      { status: 500 }
    )
  }
}
