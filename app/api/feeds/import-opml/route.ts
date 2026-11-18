import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { saveSourceCover } from "@/lib/feed-cover"
import { parseOpml, type OpmlFeed } from "@/lib/opml-parser"
import { extractChannelId, youtubeChannelUrl } from "@/lib/youtube"

// POST /api/feeds/import-opml - Import RSS feeds from OPML file
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const xmlText = await request.text()

    const MAX_OPML_SIZE = 2 * 1024 * 1024 // 2MB
    if (xmlText.length > MAX_OPML_SIZE) {
      return NextResponse.json(
        { error: "OPML file too large (max 2MB)" },
        { status: 413 }
      )
    }

    let feeds: OpmlFeed[]
    try {
      feeds = parseOpml(xmlText)
    } catch (err) {
      return NextResponse.json(
        { error: `Invalid OPML: ${err instanceof Error ? err.message : "parse error"}` },
        { status: 400 }
      )
    }

    // Separate feeds by category
    const feedlyFeeds = feeds.filter(f => f.isFeedlySpecific)
    const existingSources = await db.feed.findMany({
      where: { userId },
      select: { url: true },
    })
    const existingUrls = new Set(existingSources.map((s: { url: string }) => s.url))

    // YouTube channel feeds in the export (feeds/videos.xml?channel_id=UC…)
    // become native YOUTUBE sources: canonical /channel/UC… URL + transcripts.
    // Duplicate check covers both URL forms via the channel id.
    const withCanonical = feeds.map(f => {
      const channelId = extractChannelId(f.xmlUrl)
      return {
        ...f,
        canonicalUrl: channelId ? youtubeChannelUrl(channelId) : f.xmlUrl,
        sourceType: channelId ? ("YOUTUBE" as const) : ("RSS" as const),
        channelId,
      }
    })
    const existingList = [...existingUrls]
    const newFeeds = withCanonical.filter(f =>
      !f.isFeedlySpecific &&
      !existingUrls.has(f.xmlUrl) &&
      !existingUrls.has(f.canonicalUrl) &&
      !(f.channelId && existingList.some(u => u.includes(f.channelId!)))
    )
    const skippedDups = feeds.length - feedlyFeeds.length - newFeeds.length

    const groupSet = new Set<string>()
    for (const feed of newFeeds) {
      if (feed.group) groupSet.add(feed.group)
    }

    // Batch insert with skipDuplicates (single query instead of N+1)
    const { count: created } = await db.feed.createMany({
      data: newFeeds.map(feed => ({
        userId,
        url: feed.canonicalUrl,
        type: feed.sourceType,
        name: feed.name,
        isActive: true,
        status: "ACTIVE" as const,
        tags: feed.group ? [feed.group] : [],
      })),
      skipDuplicates: true,
    })

    // Fetch created source IDs for cover fetching
    const createdSources = await db.feed.findMany({
      where: { userId, url: { in: newFeeds.map(f => f.canonicalUrl) } },
      select: { id: true },
    })

    // Throttled cover fetching — 5 at a time to avoid connection pool exhaustion
    const COVER_BATCH = 5
    for (let i = 0; i < createdSources.length; i += COVER_BATCH) {
      const batch = createdSources.slice(i, i + COVER_BATCH)
      void Promise.allSettled(
        batch.map(s =>
          saveSourceCover(s.id, userId).catch((err: unknown) =>
            console.error(`[OPML Import] Cover fetch failed for ${s.id}:`, err)
          )
        )
      )
    }

    // Refresh the dashboard layout so newly imported sources appear in the sidebar (RAD-210).
    if (created > 0) {
      revalidatePath("/", "layout")
    }

    return NextResponse.json({
      created,
      skipped: skippedDups + feedlyFeeds.length,
      failed: newFeeds.length - created,
      feedlySpecific: feedlyFeeds.length,
      groups: Array.from(groupSet),
    })
  } catch (error) {
    console.error("[OPML Import] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to import OPML" },
      { status: 500 }
    )
  }
}
