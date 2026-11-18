import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { AIEvaluation, MaterialStatus, type Prisma } from "@prisma/client"

// DELETE /api/materials/bulk-delete - Delete materials by filter for current user
export async function DELETE(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { searchParams } = new URL(request.url)
    const filter = searchParams.get("filter") as "FILTERED" | "APPROVED" | "NEW" | "ARCHIVED" | null

    if (!filter) {
      return NextResponse.json(
        { error: "Filter parameter is required" },
        { status: 400 }
      )
    }

    // Get user's sources first. hidden:false: a bulk clear of the triage feed
    // must not wipe a self-filling collection's monitor materials (delete the
    // collection instead).
    const userSources = await db.feed.findMany({
      where: { userId, hidden: false },
      select: { id: true },
    })

    const sourceIds = userSources.map((s) => s.id)

    if (sourceIds.length === 0) {
      return NextResponse.json({
        message: "No feeds found",
        count: 0,
      })
    }

    // Build where clause based on filter
    const whereClause: Prisma.MaterialWhereInput = {
      sourceId: { in: sourceIds },
      userStatus: { not: MaterialStatus.DELETED },
    }

    switch (filter) {
      case "FILTERED":
        whereClause.aiEvaluation = AIEvaluation.FILTERED
        break
      case "APPROVED":
        whereClause.aiEvaluation = AIEvaluation.APPROVED
        whereClause.userStatus = { notIn: [MaterialStatus.DELETED, MaterialStatus.ARCHIVED] }
        break
      case "NEW":
        whereClause.userStatus = MaterialStatus.NEW
        break
      case "ARCHIVED":
        whereClause.userStatus = MaterialStatus.ARCHIVED
        break
      default:
        return NextResponse.json(
          { error: "Invalid filter. Allowed: FILTERED, APPROVED, NEW, ARCHIVED" },
          { status: 400 }
        )
    }

    // Soft delete - set userStatus to DELETED
    const result = await db.material.updateMany({
      where: whereClause,
      data: { userStatus: MaterialStatus.DELETED },
    })

    // Invalidate Next.js cache
    revalidatePath("/posts")
    revalidatePath("/")

    return NextResponse.json({
      message: `${result.count} materials deleted`,
      count: result.count,
      filter,
    })
  } catch (error) {
    console.error("Error bulk deleting materials:", error)
    return NextResponse.json(
      { error: "Failed to delete materials" },
      { status: 500 }
    )
  }
}
