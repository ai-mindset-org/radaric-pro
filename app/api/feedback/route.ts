import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const feedbacks = await db.aIFeedback.findMany({
      where: { userId },
      include: {
        feed: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    })

    return NextResponse.json(feedbacks)
  } catch (error) {
    console.error("Error fetching feedback:", error)
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 }
    )
  }
}
