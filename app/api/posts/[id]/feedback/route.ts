import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { feedbackSchema } from "@/lib/validations/feedback"

// POST /api/materials/[id]/feedback — Like/Dislike a material
export async function POST(
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

    const parsed = feedbackSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { feedbackType, comment } = parsed.data

    // Verify material exists and user owns it through source
    const material = await db.material.findUnique({
      where: { id },
      include: { feed: { select: { userId: true, id: true } } },
    })

    if (!material || material.feed.userId !== userId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 })
    }

    // Upsert: one feedback per (userId, materialId)
    const feedback = await db.aIFeedback.upsert({
      where: {
        userId_materialId: { userId, materialId: id },
      },
      create: {
        userId,
        materialId: id,
        sourceId: material.sourceId,
        feedbackType,
        commentText: comment ?? null,
        feedbackSource: "explicit",
        isGlobal: false,
      },
      update: {
        feedbackType,
        commentText: comment ?? null,
        feedbackSource: "explicit",
      },
    })

    return NextResponse.json({
      id: feedback.id,
      feedbackType: feedback.feedbackType,
      commentText: feedback.commentText,
      createdAt: feedback.createdAt,
    })
  } catch (error) {
    console.error("Error saving feedback:", error)
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 }
    )
  }
}
