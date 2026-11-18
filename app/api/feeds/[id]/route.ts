import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { updateSourceSchema, vetTelegramFeedInput } from "@/lib/validations/feed"
import { resolveYouTubeChannel, YouTubeResolveError } from "@/lib/youtube"
import { deleteParallelMonitor, createParallelMonitor, buildWebhookUrl } from "@/lib/parsers/interest"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { validateTelegramSource, TELEGRAM_REJECT_MESSAGES } from "@/lib/feed-validation"

// GET /api/feeds/[id] - Get a single feed (only if owned by user)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { id } = await params
    const source = await db.feed.findUnique({
      where: { id, userId },
      include: {
        _count: {
          select: { materials: true, feedbacks: true },
        },
      },
    })

    if (!source) {
      return NextResponse.json(
        { error: "Feed not found" },
        { status: 404 }
      )
    }

    return NextResponse.json(source)
  } catch (error) {
    console.error("Error fetching feed:", error)
    return NextResponse.json(
      { error: "Failed to fetch feed" },
      { status: 500 }
    )
  }
}

// PATCH /api/feeds/[id] - Update a feed (only if owned by user)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params
    const body = await request.json()
    const validatedData = updateSourceSchema.parse({
      ...body,
      id,
    })

    // Get current feed to check for INTEREST type pause/resume
    const currentSource = await db.feed.findUnique({
      where: { id, userId },
    })

    if (!currentSource) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    // A self-filling collection's backing monitor feed is managed through the
    // collection, not as a feed. Editing it here (pause/resume/param change)
    // would swap or drop its Parallel monitor while Collection.monitorFeedId
    // still points at it — desyncing the tracked question. Block it.
    if (currentSource.hidden) {
      return NextResponse.json(
        { error: "This feed backs a tracked question. Manage it from the collection." },
        { status: 409 }
      )
    }

    let parallelMonitorId = currentSource.parallelMonitorId
    let newlyCreatedMonitorId: string | null = null // Track for rollback

    // Get effective Interest values (use new if provided, else keep current)
    const effectiveInterestQuery = validatedData.interestQuery ?? currentSource.interestQuery
    const effectiveInterestCadence = validatedData.interestCadence ?? currentSource.interestCadence

    // Handle INTEREST sources: pause/resume and parameter changes
    if (currentSource.type === "INTEREST" || currentSource.type === "EVENT_TRIGGER") {
      const isPausing = validatedData.isActive === false && currentSource.isActive === true
      const isResuming = validatedData.isActive === true && currentSource.isActive === false

      // Check if monitor parameters changed (query or cadence)
      const paramsChanged = currentSource.isActive && currentSource.parallelMonitorId && (
        (validatedData.interestQuery && validatedData.interestQuery !== currentSource.interestQuery) ||
        (validatedData.interestCadence && validatedData.interestCadence !== currentSource.interestCadence)
      )

      if (isPausing && currentSource.parallelMonitorId) {
        // Pausing - delete monitor
        try {
          await deleteParallelMonitor(currentSource.parallelMonitorId)
          parallelMonitorId = null
          console.log(`[Feeds API] Paused - deleted Parallel monitor: ${currentSource.parallelMonitorId}`)
        } catch (monitorError) {
          console.error("[Feeds API] Failed to delete Parallel monitor on pause:", monitorError)
        }
      } else if (paramsChanged && effectiveInterestQuery && effectiveInterestCadence) {
        // Parameters changed for active source - recreate monitor
        try {
          // Delete old monitor
          if (currentSource.parallelMonitorId) {
            await deleteParallelMonitor(currentSource.parallelMonitorId)
            console.log(`[Feeds API] Deleted old monitor for params update: ${currentSource.parallelMonitorId}`)
          }
          // Create new monitor with updated params
          const webhookUrl = buildWebhookUrl()
          newlyCreatedMonitorId = await createParallelMonitor(
            {
              query: effectiveInterestQuery,
              cadence: effectiveInterestCadence.toLowerCase() as "hourly" | "daily" | "weekly",
            },
            webhookUrl
          )
          parallelMonitorId = newlyCreatedMonitorId
          console.log(`[Feeds API] Created new monitor with updated params: ${parallelMonitorId}`)
        } catch (monitorError) {
          console.error("[Feeds API] Failed to update Parallel monitor:", monitorError)
          return NextResponse.json(
            { error: "Failed to update monitoring" },
            { status: 500 }
          )
        }
      } else if (isResuming && effectiveInterestQuery && effectiveInterestCadence) {
        // Resuming - recreate monitor
        try {
          const webhookUrl = buildWebhookUrl()
          newlyCreatedMonitorId = await createParallelMonitor(
            {
              query: effectiveInterestQuery,
              cadence: effectiveInterestCadence.toLowerCase() as "hourly" | "daily" | "weekly",
            },
            webhookUrl
          )
          parallelMonitorId = newlyCreatedMonitorId
          console.log(`[Feeds API] Resumed - created new Parallel monitor: ${parallelMonitorId}`)
        } catch (monitorError) {
          console.error("[Feeds API] Failed to create Parallel monitor on resume:", monitorError)
          return NextResponse.json(
            { error: "Failed to resume monitoring" },
            { status: 500 }
          )
        }
      }
    }

    // Telegram on edit gets the same gate as POST (RAD-364): only a public
    // channel username, stored canonical, and a URL that changes is probed. A
    // type switch to TELEGRAM vets — and canonicalizes — the URL the row holds.
    let warning: "FEED_UNVERIFIED" | null = null
    const becomesTelegram = validatedData.type === "TELEGRAM" && currentSource.type !== "TELEGRAM"
    if ((validatedData.url || becomesTelegram) && (validatedData.type ?? currentSource.type) === "TELEGRAM") {
      const candidate = validatedData.url || currentSource.url
      const vetted = vetTelegramFeedInput(candidate)
      if (!vetted.ok) {
        return NextResponse.json(
          { error: TELEGRAM_REJECT_MESSAGES[vetted.code], code: vetted.code, url: candidate },
          { status: 400 }
        )
      }
      if (vetted.url !== currentSource.url || becomesTelegram) {
        const duplicate = await db.feed.findFirst({
          where: { userId, url: vetted.url, NOT: { id } },
          select: { id: true },
        })
        if (duplicate) {
          return NextResponse.json(
            { error: "This source is already in your feeds", code: "DUPLICATE_FEED" },
            { status: 409 }
          )
        }
        const tg = await validateTelegramSource(vetted.url)
        if (tg.verdict === "reject") {
          return NextResponse.json(
            { error: TELEGRAM_REJECT_MESSAGES[tg.code], code: tg.code, url: vetted.url },
            { status: 400 }
          )
        }
        if (tg.verdict === "unknown") warning = "FEED_UNVERIFIED"
      }
      validatedData.url = vetted.url
    }

    // Canonicalize YouTube channel input on edit (same as POST); a URL the
    // resolver can't handle is rejected rather than silently stored. The
    // cross-form duplicate guard mirrors POST — @@unique([userId, url]) alone
    // misses a channel held by another feed in feed-XML form.
    if (
      validatedData.url &&
      (validatedData.type ?? currentSource.type) === "YOUTUBE" &&
      validatedData.url !== currentSource.url
    ) {
      try {
        const resolved = await resolveYouTubeChannel(validatedData.url)
        const duplicate = await db.feed.findFirst({
          where: { userId, url: { contains: resolved.channelId }, NOT: { id } },
          select: { id: true },
        })
        if (duplicate) {
          return NextResponse.json(
            { error: "This channel is already in your feeds", code: "DUPLICATE_FEED" },
            { status: 409 }
          )
        }
        validatedData.url = resolved.channelUrl
      } catch (error) {
        if (error instanceof YouTubeResolveError) {
          return NextResponse.json({ error: error.message }, { status: 400 })
        }
        throw error
      }
    }

    // Update feed in DB with rollback if it fails. Compare-and-swap on the
    // monitor id read at the top: the worker's access reconcile can re-arm a
    // lapse-paused feed concurrently, and an unconditional write would clobber
    // its monitor with ours (two live monitors, one unrecorded). — RAD-323
    let source
    try {
      const { count } = await db.feed.updateMany({
        where: { id, userId, parallelMonitorId: currentSource.parallelMonitorId ?? null },
        data: {
          url: validatedData.url,
          type: validatedData.type,
          name: validatedData.name,
          coverUrl: validatedData.coverUrl,
          customPrompt: validatedData.customPrompt,
          isActive: validatedData.isActive,
          parallelMonitorId,
          // Interest fields
          interestQuery: validatedData.interestQuery,
          interestCadence: validatedData.interestCadence,
          // Twitter: include retweets
          includeRetweets: validatedData.includeRetweets,
          // Content category preferences
          likedCategories: validatedData.likedCategories,
          dislikedCategories: validatedData.dislikedCategories,
          // Any user-initiated edit claims the feed back from the access
          // reconcile: clearing the lapse marker means it is never auto-resumed
          // behind the user's back (RAD-323).
          accessPaused: false,
        },
      })
      if (count === 0) {
        throw Object.assign(new Error("Feed changed concurrently"), { code: "STALE_FEED" })
      }
      source = await db.feed.findUnique({ where: { id, userId } })
    } catch (dbError) {
      // Rollback: delete newly created Parallel monitor if DB update failed
      if (newlyCreatedMonitorId) {
        console.error("[Feeds API] DB update failed, rolling back Parallel monitor:", newlyCreatedMonitorId)
        try {
          await deleteParallelMonitor(newlyCreatedMonitorId)
          console.log("[Feeds API] Rollback successful - monitor deleted")
        } catch (rollbackError) {
          console.error("[Feeds API] Rollback failed - orphan monitor:", newlyCreatedMonitorId, rollbackError)
        }
      }
      if ((dbError as { code?: string }).code === "STALE_FEED") {
        return NextResponse.json(
          { error: "This feed was updated elsewhere. Reload and try again.", code: "FEED_CHANGED" },
          { status: 409 }
        )
      }
      throw dbError
    }

    // Refresh the dashboard layout so sidebar picks up name/cover/isActive changes (RAD-210).
    revalidatePath("/", "layout")

    return NextResponse.json(warning ? { ...source, warning } : source)
  } catch (error) {
    console.error("Error updating feed:", error)

    if (error instanceof Error && error.name === "ZodError") {
      return NextResponse.json(
        { error: "Invalid input data", details: error },
        { status: 400 }
      )
    }

    // @@unique([userId, url]) — an edit that lands on another feed's URL is a
    // duplicate, not a server failure (same friendly 409 as POST)
    if (error && typeof error === "object" && (error as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "This source is already in your feeds", code: "DUPLICATE_FEED" },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { error: "Failed to update feed" },
      { status: 500 }
    )
  }
}

// DELETE /api/feeds/[id] - Delete a feed (only if owned by user)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params

    // Get feed first to check for Parallel monitor
    const source = await db.feed.findUnique({
      where: { id, userId },
    })

    if (!source) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    // Backing monitor feeds for self-filling collections must be torn down via
    // the collection (monitor → feed → collection order). Deleting the feed
    // here would orphan the collection's monitorFeedId and skip the monitor
    // cleanup, leaking a paid Parallel monitor.
    if (source.hidden) {
      return NextResponse.json(
        { error: "This feed backs a tracked question. Delete the collection instead." },
        { status: 409 }
      )
    }

    // Delete Parallel monitor if exists
    if ((source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && source.parallelMonitorId) {
      try {
        await deleteParallelMonitor(source.parallelMonitorId)
        console.log(`[Feeds API] Deleted Parallel monitor: ${source.parallelMonitorId}`)
      } catch (monitorError) {
        console.error("[Feeds API] Failed to delete Parallel monitor:", monitorError)
        // Continue with deletion even if Parallel cleanup fails
      }
    }

    await db.feed.delete({
      where: { id },
    })

    // Refresh the dashboard layout so the deleted source disappears from the sidebar (RAD-210).
    revalidatePath("/", "layout")

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting feed:", error)
    return NextResponse.json(
      { error: "Failed to delete feed" },
      { status: 500 }
    )
  }
}
