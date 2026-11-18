import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// POST /api/collections/[id]/track — record the user's intent to have a
// maintained "living answer" for this collection (the Phase-2 demand sensor).
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

    const { id } = await params

    const collection = await db.collection.findFirst({
      where: { id, userId },
      select: { id: true, trackRequestedAt: true },
    })
    if (!collection) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }

    // Set-once: preserve the FIRST request timestamp as the signal; repeat
    // clicks are idempotent no-ops.
    const trackRequestedAt = collection.trackRequestedAt ?? new Date()
    if (!collection.trackRequestedAt) {
      await db.collection.update({ where: { id }, data: { trackRequestedAt } })
    }

    return NextResponse.json({ id, trackRequestedAt })
  } catch (error) {
    console.error("Error recording track intent:", error)
    return NextResponse.json({ error: "Failed to record intent" }, { status: 500 })
  }
}
