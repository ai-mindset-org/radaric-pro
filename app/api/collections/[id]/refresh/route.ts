import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { parseInterestSource } from "@/lib/parsers/interest"
import { regenerateSynthesis } from "@/lib/saved/synthesis"

// In-memory per-(user,collection) cooldown — a manual refresh is a paid Parallel
// fetch (plus a possible AI eval + LLM synthesis), so refuse a rapid re-fire.
// Resets on deploy, which is fine: this is cost control, not a security boundary.
const REFRESH_COOLDOWN_MS = 30_000
const COOLDOWN_MAP_CAP = 5_000
const lastRefresh = new Map<string, number>()

// POST /api/collections/[id]/refresh — on-demand "check for updates" for a
// tracked question: pull the backing monitor's latest events from Parallel,
// ingest + evaluate any new material, then regenerate the living answer when
// something changed (or it was never generated). The autonomous path is
// cadence-push only (Parallel → webhook → processParallelEvent); this is the
// manual pull, so a user can verify on demand instead of waiting for a push.
// Self-filling collections only; gated; ownership-checked.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    // RAD-297: unverified accounts get the demo, not paid AI work.
    const emailGate = await requireVerifiedEmail(userId, role)
    if (emailGate) return emailGate

    const { id } = await params
    const collection = await db.collection.findFirst({
      where: { id, userId },
      select: { id: true, monitorFeedId: true, synthesisUpdatedAt: true },
    })
    if (!collection) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }
    if (!collection.monitorFeedId) {
      return NextResponse.json(
        { error: "Updates are only available for tracked questions" },
        { status: 400 }
      )
    }

    const key = `${userId}:${id}`
    const now = Date.now()
    const last = lastRefresh.get(key)
    if (last && now - last < REFRESH_COOLDOWN_MS) {
      return NextResponse.json(
        { error: "Just a moment — try again shortly.", code: "COOLDOWN" },
        { status: 429 }
      )
    }
    // Set the gate before the paid work (closes the concurrent double-fire race),
    // but evict stale entries first so the Map can't grow without bound on the
    // long-lived Railway process.
    if (lastRefresh.size > COOLDOWN_MAP_CAP) {
      for (const [k, t] of lastRefresh) {
        if (now - t >= REFRESH_COOLDOWN_MS) lastRefresh.delete(k)
      }
    }
    lastRefresh.set(key, now)

    // Pull + ingest the monitor's latest events (dedups against existing
    // material, so only genuinely new items are AI-evaluated). A failed paid
    // attempt must not burn the cooldown window — release the gate so the user
    // can retry once the underlying issue (Parallel down, monitor torn down) clears.
    let result
    try {
      result = await parseInterestSource(collection.monitorFeedId, userId)
    } catch (parseError) {
      lastRefresh.delete(key)
      throw parseError
    }

    // Regenerate the answer when there's something new to say — or when the
    // question has never produced an answer yet (first-pull bootstrap).
    let synthesisStatus: string | null = null
    if (result.created > 0 || collection.synthesisUpdatedAt == null) {
      const synth = await regenerateSynthesis(userId, id)
      synthesisStatus = synth.status
    }

    return NextResponse.json({
      fetched: result.total,
      created: result.created,
      skipped: result.skipped,
      synthesisStatus,
    })
  } catch (error) {
    console.error("Error refreshing tracked question:", error)
    return NextResponse.json(
      { error: "Couldn’t check for updates — try again." },
      { status: 500 }
    )
  }
}
