import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { computeAccuracyMetrics } from "@/lib/accuracy"

// GET /api/analytics/accuracy?days=30 — compute AI filtering accuracy metrics
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    // Default to last 30 days, max 365
    const daysParam = request.nextUrl.searchParams.get("days")
    const days = Math.min(Math.max(parseInt(daysParam || "30", 10) || 30, 1), 365)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const materials = await db.material.findMany({
      where: {
        // hidden:false — accuracy is about the user's curation feeds, not the
        // autonomous self-filling monitors.
        feed: { userId, hidden: false },
        userStatus: { notIn: ["NEW", "READ"] },
        updatedAt: { gte: since },
      },
      select: {
        aiEvaluation: true,
        userStatus: true,
        sourceId: true,
      },
    })

    const metrics = computeAccuracyMetrics(materials)

    return NextResponse.json({ ...metrics, days })
  } catch (error) {
    console.error("Error computing accuracy metrics:", error)
    return NextResponse.json(
      { error: "Failed to compute accuracy metrics" },
      { status: 500 }
    )
  }
}
