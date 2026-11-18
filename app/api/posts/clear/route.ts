import { NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// DELETE /api/materials/clear - Delete all materials for current user (keep sources)
export async function DELETE() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    // Get user's sources first. hidden:false: "clear all" targets the triage
    // feed, not the self-filling monitors backing tracked questions (delete the
    // collection to remove those).
    const userSources = await db.feed.findMany({
      where: { userId, hidden: false },
      select: { id: true },
    })

    const sourceIds = userSources.map((s) => s.id)

    // Delete only materials from user's sources
    const result = await db.material.deleteMany({
      where: {
        sourceId: { in: sourceIds },
      },
    })

    // Invalidate Next.js cache for materials page
    revalidatePath("/posts")
    revalidatePath("/")

    return NextResponse.json({
      message: "All your materials deleted successfully",
      count: result.count,
    })
  } catch (error) {
    console.error("Error deleting materials:", error)
    return NextResponse.json(
      { error: "Failed to delete materials" },
      { status: 500 }
    )
  }
}
