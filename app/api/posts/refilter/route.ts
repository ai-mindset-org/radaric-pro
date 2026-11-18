import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { hasActiveAccess } from "@/lib/subscription"
import { refilterMaterials, EXCLUDED_STATUSES } from "@/lib/refilter-materials"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { SSE_HEADERS, startHeartbeat, streamableRefusal } from "@/lib/sse"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function sseMessage(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/**
 * GET /api/posts/refilter
 * Re-evaluate all eligible materials using current AI rules.
 * Streams per-material progress via SSE.
 * Aborts cleanly when the client disconnects (page reload, navigation).
 */
export async function GET(request: NextRequest) {
  // Auth + rate limit run BEFORE the stream is built (RAD-296): a blocked caller
  // gets a real HTTP status instead of a 200 stream with an in-band error.
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) {
    // RAD-406: an EventSource caller cannot read a 401, so it gets a frame.
    return streamableRefusal(request, NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
  }
  const { userId, role } = authResult
  const limited = checkUserRateLimit("refilter", userId, role, RATE_LIMITS.refilter)
  // RAD-326: an EventSource caller gets the refusal as a readable SSE frame.
  if (limited) return streamableRefusal(request, limited)

  // RAD-297: unverified accounts get the demo, not paid AI work. RAD-406: as a
  // readable frame for an EventSource, the real 403 for everyone else.
  const emailGate = await requireVerifiedEmail(userId, role)
  if (emailGate) return streamableRefusal(request, emailGate)

  const encoder = new TextEncoder()
  const abortController = new AbortController()

  // Abort processing when client disconnects
  request.signal.addEventListener("abort", () => {
    abortController.abort()
  })

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        try {
          controller.enqueue(encoder.encode(sseMessage(data)))
        } catch {
          // Stream already closed — client disconnected
          abortController.abort()
        }
      }

      const stopHeartbeat = startHeartbeat(controller, encoder)

      try {

        // Optional feedId / folderId scope — when called from /feeds/[id] the AI
        // Rules button re-filters only that feed's materials; /folders/[id]
        // scopes to the folder's visible member sources (RAD-393).
        const { searchParams } = new URL(request.url)
        const feedId = searchParams.get("feedId") || undefined
        const folderId = searchParams.get("folderId") || undefined

        const { db } = await import("@/lib/db")
        const { evaluateMaterial } = await import("@/lib/ai")

        // Resolve folder members once. An empty folder is an empty run, never
        // an accidental account-wide one.
        let folderSourceIds: string[] | undefined
        if (folderId) {
          const members = await db.feed.findMany({
            where: { userId, folderId, hidden: false, isActive: true },
            select: { id: true },
          })
          folderSourceIds = members.map(m => m.id)
        }

        // Subscription gate (SSE: inline check so we can send an error event)
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

        // Quick count for the "start" event
        const eligibleCount = await db.material.count({
          where: {
            // hidden:false — keep self-filling monitor materials out of refilter
            // (matches refilterMaterials in lib/refilter-materials.ts).
            feed: { userId, hidden: false },
            userStatus: { notIn: [...EXCLUDED_STATUSES] },
            ...(folderSourceIds
              ? { sourceId: { in: folderSourceIds } }
              : feedId
                ? { sourceId: feedId }
                : {}),
          },
        })

        if (eligibleCount === 0) {
          send({ type: "complete", current: 0, total: 0, flippedToApproved: 0, flippedToFiltered: 0, unchanged: 0, errors: 0 })
          controller.close()
          return
        }

        send({ type: "start", total: eligibleCount })

        const result = await refilterMaterials(userId, {
          db: {
            material: {
              findMany: (args) => db.material.findMany(args as never) as never,
              update: (args) => db.material.update(args as never),
            },
          },
          evaluateMaterial,
        }, {
          feedId,
          sourceIds: folderSourceIds,
          signal: abortController.signal,
          onProgress: (current, _total, partialResult) => {
            send({
              type: "progress",
              current,
              total: partialResult.total,
              flippedToApproved: partialResult.flippedToApproved,
              flippedToFiltered: partialResult.flippedToFiltered,
              unchanged: partialResult.unchanged,
              errors: partialResult.errors,
            })
          },
        })

        send({ type: "complete", current: result.total, ...result })
        controller.close()
      } catch (error) {
        if (abortController.signal.aborted) {
          // Client disconnected — close quietly
          try { controller.close() } catch { /* already closed */ }
          return
        }
        const msg = error instanceof Error ? error.message : String(error)
        console.error("[refilter-stream] Error:", msg)
        send({ type: "error", message: "Re-filtering failed" })
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
