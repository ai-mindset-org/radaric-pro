import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { updateFeedbackSchema } from "@/lib/validations/feedback"

// PATCH /api/feedback/[id] — Edit feedback comment or type
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

    const parsed = updateFeedbackSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const existing = await db.aIFeedback.findUnique({ where: { id } })
    if (!existing || existing.userId !== userId) {
      return NextResponse.json({ error: "Feedback not found" }, { status: 404 })
    }

    const updated = await db.aIFeedback.update({
      where: { id },
      data: {
        ...(parsed.data.feedbackType && { feedbackType: parsed.data.feedbackType }),
        ...(parsed.data.comment !== undefined && { commentText: parsed.data.comment }),
      },
    })

    return NextResponse.json(updated)
  } catch (error) {
    console.error("Error updating feedback:", error)
    return NextResponse.json(
      { error: "Failed to update feedback" },
      { status: 500 }
    )
  }
}

// DELETE /api/feedback/[id] — Remove individual feedback
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

    const existing = await db.aIFeedback.findUnique({ where: { id } })
    if (!existing || existing.userId !== userId) {
      return NextResponse.json({ error: "Feedback not found" }, { status: 404 })
    }

    await db.aIFeedback.delete({ where: { id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting feedback:", error)
    return NextResponse.json(
      { error: "Failed to delete feedback" },
      { status: 500 }
    )
  }
}
