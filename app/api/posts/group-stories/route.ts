import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription, hasActiveAccess } from "@/lib/subscription"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { buildMaterialStoryDeps } from "@/lib/story-aggregator/pipeline-deps"
import { SSE_HEADERS, startHeartbeat, streamableRefusal } from "@/lib/sse"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function sseMessage(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/**
 * POST /api/posts/group-stories
 * Trigger story matching/grouping for APPROVED materials.
 * Returns JSON result (non-streaming).
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    // RAD-296: bounded per-user spend — grouping runs AI story-matching.
    const limited = checkUserRateLimit("group-stories", userId, role, RATE_LIMITS.groupStories)
    if (limited) return limited

    // RAD-297: unverified accounts get the demo, not paid AI work.
    const emailGate = await requireVerifiedEmail(userId, role)
    if (emailGate) return emailGate

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const body = await request.json().catch(() => ({}))
    const materialIds: string[] = body.materialIds ?? []

    // Optional folderId scope (RAD-393) — mirrors the GET handler's predicate
    // so the two handlers in this route can never disagree about what a folder
    // means. Without it the fallback pool is account-wide, as before.
    const { searchParams } = new URL(request.url)
    const folderId = searchParams.get("folderId") || undefined

    const { processApprovedMaterials } = await import(
      "@/lib/story-aggregator/material-story-pipeline"
    )

    let idsToProcess = materialIds
    if (idsToProcess.length === 0) {
      const { db } = await import("@/lib/db")
      const ungrouped = await db.material.findMany({
        where: {
          // hidden:false — self-filling monitor materials belong to the
          // tracked-question answer, not the global stories clustering.
          feed: folderId
            ? { userId, hidden: false, isActive: true, folderId }
            : { userId, hidden: false },
          aiEvaluation: "APPROVED",
          storyId: null,
          userStatus: { notIn: ["DELETED", "ARCHIVED"] },
        },
        select: { id: true },
      })
      idsToProcess = ungrouped.map((m: { id: string }) => m.id)
    }

    if (idsToProcess.length === 0) {
      return NextResponse.json({
        storiesCreated: 0,
        storiesUpdated: 0,
        materialsProcessed: 0,
        materialsSkipped: 0,
      })
    }

    const deps = await buildMaterialStoryDeps(userId)
    const result = await processApprovedMaterials(idsToProcess, userId, deps)

    return NextResponse.json(result)
  } catch (error) {
    console.error("[group-stories] Error:", error)
    return NextResponse.json(
      { error: "Failed to group materials into stories" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/posts/group-stories
 * Stream story grouping progress via SSE.
 * Processes each material one by one, sending progress events.
 */
export async function GET(request: NextRequest) {
  // Auth + rate limit run BEFORE the stream is built (RAD-296): a blocked caller
  // gets a real HTTP status instead of a 200 stream with an in-band error. The
  // UI calls THIS handler (EventSource), not POST — the limit must live here.
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) {
    // RAD-406: an EventSource caller cannot read a 401, so it gets a frame.
    return streamableRefusal(request, NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
  }
  const { userId, role } = authResult
  const limited = checkUserRateLimit("group-stories", userId, role, RATE_LIMITS.groupStories)
  // RAD-326: an EventSource caller gets the refusal as a readable SSE frame.
  if (limited) return streamableRefusal(request, limited)

  // RAD-297: unverified accounts get the demo, not paid AI work. RAD-406: as a
  // readable frame for an EventSource, the real 403 for everyone else.
  const emailGate = await requireVerifiedEmail(userId, role)
  if (emailGate) return streamableRefusal(request, emailGate)

  const encoder = new TextEncoder()
  const abortController = new AbortController()

  request.signal.addEventListener("abort", () => {
    abortController.abort()
  })

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        try {
          controller.enqueue(encoder.encode(sseMessage(data)))
        } catch {
          abortController.abort()
        }
      }

      const stopHeartbeat = startHeartbeat(controller, encoder)

      try {

        // Optional feedId / folderId scope — when called from /feeds/[id] or
        // /folders/[id] the Group Stories button only groups materials from
        // the current source or the folder's visible member sources.
        const { searchParams } = new URL(request.url)
        const feedId = searchParams.get("feedId") || undefined
        const folderId = searchParams.get("folderId") || undefined

        const { db } = await import("@/lib/db")

        // Subscription gate (SSE inline check)
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
          send({ type: "error", message: "Subscription required" })
          controller.close()
          return
        }

        const ungrouped = await db.material.findMany({
          where: {
            // hidden:false — self-filling monitor materials belong to the
            // tracked-question answer, not the global stories clustering.
            feed: folderId
              ? { userId, hidden: false, isActive: true, folderId }
              : { userId, hidden: false },
            aiEvaluation: "APPROVED",
            storyId: null,
            userStatus: { notIn: ["DELETED", "ARCHIVED"] },
            ...(feedId ? { sourceId: feedId } : {}),
          },
          select: { id: true },
        })

        const total = ungrouped.length
        if (total === 0) {
          send({ type: "complete", current: 0, total: 0, storiesCreated: 0, storiesUpdated: 0 })
          controller.close()
          return
        }

        send({ type: "start", total })

        const { processApprovedMaterials } = await import(
          "@/lib/story-aggregator/material-story-pipeline"
        )
        const deps = await buildMaterialStoryDeps(userId)

        // Process one material at a time for real progress
        let storiesCreated = 0
        let storiesUpdated = 0
        let materialsProcessed = 0

        for (let i = 0; i < ungrouped.length; i++) {
          if (abortController.signal.aborted) break

          const result = await processApprovedMaterials(
            [ungrouped[i].id],
            userId,
            deps
          )

          storiesCreated += result.storiesCreated
          storiesUpdated += result.storiesUpdated
          materialsProcessed += result.materialsProcessed

          send({
            type: "progress",
            current: i + 1,
            total,
            storiesCreated,
            storiesUpdated,
          })
        }

        send({
          type: "complete",
          current: total,
          total,
          storiesCreated,
          storiesUpdated,
          materialsProcessed,
        })

        controller.close()
      } catch (error) {
        if (abortController.signal.aborted) {
          try { controller.close() } catch { /* already closed */ }
          return
        }
        const msg = error instanceof Error ? error.message : String(error)
        console.error("[group-stories-stream] Error:", msg)
        send({ type: "error", message: "Story grouping failed" })
        try { controller.close() } catch { /* already closed */ }
      } finally {
        // Every exit path — completion, early return, abort, fatal error —
        // must clear the interval, or it keeps firing against a closed
        // controller for the life of the process.
        stopHeartbeat()
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
