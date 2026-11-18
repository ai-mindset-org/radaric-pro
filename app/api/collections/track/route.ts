import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { trackQuestionSchema } from "@/lib/validations/saved"
import {
  createTrackedQuestion,
  CapReachedError,
  ParallelNotConfiguredError,
} from "@/lib/saved/subscription"

// POST /api/collections/track — create a self-filling collection (a "tracked
// question"): a NL query + cadence that spins up a backing Parallel monitor and
// maintains a living, cited answer. Distinct from /collections/[id]/track,
// which only records intent on an existing manual collection.
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    // RAD-297: spinning up a tracked question pays for a Parallel monitor —
    // the demo may manage existing feeds but must not start new paid monitors.
    const emailGate = await requireVerifiedEmail(userId, role)
    if (emailGate) return emailGate

    const parsed = trackQuestionSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const collection = await createTrackedQuestion(userId, role, parsed.data)
    return NextResponse.json({ id: collection.id, name: collection.name }, { status: 201 })
  } catch (error) {
    if (error instanceof CapReachedError) {
      return NextResponse.json({ error: error.message, code: "CAP_REACHED" }, { status: 403 })
    }
    if (error instanceof ParallelNotConfiguredError) {
      return NextResponse.json({ error: error.message, code: "PARALLEL_NOT_CONFIGURED" }, { status: 503 })
    }
    // Duplicate (userId, name) collection — the backing monitor is rolled back
    // inside createTrackedQuestion before this surfaces.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "A collection with that name already exists" }, { status: 409 })
    }
    console.error("Error creating tracked question:", error)
    return NextResponse.json({ error: "Failed to create tracked question" }, { status: 500 })
  }
}
