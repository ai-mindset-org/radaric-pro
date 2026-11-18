import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { discoverSourcesForTopic, AiNotConfiguredError } from "@/lib/saved/discovery"

// Lightweight per-(user,collection) cooldown — discovery is a paid LLM call plus
// up to ~16 outbound fetches, so refuse a rapid re-fire (in-memory; resets on
// deploy, which is fine for cost control — it's not a security boundary).
const DISCOVER_COOLDOWN_MS = 20_000
const lastDiscover = new Map<string, number>()

// POST /api/collections/[id]/discover — LLM-suggest reputable sources for a
// tracked question's query, validated into real RSS feeds. Read-only (suggests;
// the client adds chosen feeds via POST /api/feeds). Gated; ownership-checked.
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
      select: { id: true, query: true },
    })
    if (!collection) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }
    if (!collection.query) {
      return NextResponse.json(
        { error: "Source discovery is only available for tracked questions" },
        { status: 400 }
      )
    }

    const key = `${userId}:${id}`
    const last = lastDiscover.get(key)
    if (last && Date.now() - last < DISCOVER_COOLDOWN_MS) {
      return NextResponse.json({ error: "Just a moment — try again shortly.", code: "COOLDOWN" }, { status: 429 })
    }
    lastDiscover.set(key, Date.now())

    const { sources, suggested } = await discoverSourcesForTopic(collection.query, userId)
    return NextResponse.json({ sources, suggested })
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return NextResponse.json(
        { error: "Source discovery needs an AI key — configure it in Settings.", code: "AI_NOT_CONFIGURED" },
        { status: 503 }
      )
    }
    console.error("Error discovering sources:", error)
    return NextResponse.json({ error: "Couldn’t discover sources — try again." }, { status: 500 })
  }
}
