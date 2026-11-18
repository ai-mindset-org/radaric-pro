import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { regenerateSynthesis } from "@/lib/saved/synthesis"

// POST /api/collections/[id]/synthesis — (re)generate the collection's living
// answer (an LLM-maintained, cited markdown wiki page). Gated (AI call).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth()
    if (isErrorResponse(auth)) return auth

    const gate = await requireActiveSubscription(auth.userId, auth.role)
    if (gate) return gate

    // RAD-297: unverified accounts get the demo, not paid AI work.
    const emailGate = await requireVerifiedEmail(auth.userId, auth.role)
    if (emailGate) return emailGate

    const { id } = await params
    const result = await regenerateSynthesis(auth.userId, id)

    if (result.status === "not_found") {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }
    if (result.status === "empty") {
      return NextResponse.json({ error: "Nothing saved yet to synthesize" }, { status: 422 })
    }
    if (result.status === "cooldown") {
      return NextResponse.json({ error: "Please wait a moment before regenerating" }, { status: 429 })
    }

    return NextResponse.json({
      synthesis: result.synthesis,
      synthesisDelta: result.synthesisDelta,
      synthesisUpdatedAt: result.synthesisUpdatedAt,
      sourceCount: result.sourceCount,
    })
  } catch (error) {
    console.error("Error generating synthesis:", error)
    return NextResponse.json({ error: "Failed to generate answer" }, { status: 500 })
  }
}
