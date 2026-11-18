import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// GET /api/feeds/[id]/feedback — List feedback with stats
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
    })

    if (!source) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    const [feedbacks, statGroups] = await Promise.all([
      db.aIFeedback.findMany({
        where: { sourceId: id, userId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      db.aIFeedback.groupBy({
        by: ["feedbackType"],
        where: { sourceId: id, userId },
        _count: true,
      }),
    ])

    const likes = statGroups.find((g) => g.feedbackType === "LIKE")?._count ?? 0
    const dislikes = statGroups.find((g) => g.feedbackType === "DISLIKE")?._count ?? 0
    const stats = { likes, dislikes, total: likes + dislikes }

    return NextResponse.json({ feedbacks, stats })
  } catch (error) {
    console.error("Error fetching feed feedback:", error)
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 }
    )
  }
}

// DELETE /api/feeds/[id]/feedback — Bulk reset all feedback for a feed
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

    const source = await db.feed.findUnique({
      where: { id, userId },
    })

    if (!source) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    const result = await db.aIFeedback.deleteMany({
      where: { sourceId: id, userId },
    })

    return NextResponse.json({ deleted: result.count })
  } catch (error) {
    console.error("Error resetting feed feedback:", error)
    return NextResponse.json(
      { error: "Failed to reset feedback" },
      { status: 500 }
    )
  }
}
