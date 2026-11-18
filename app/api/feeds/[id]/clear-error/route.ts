import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// POST /api/feeds/[id]/clear-error - Reset feed error state
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

    const source = await db.feed.update({
      where: { id, userId },
      data: {
        status: "ACTIVE",
        errorMessage: null,
      },
    })

    // Refresh the dashboard layout so the sidebar reflects isActive/status (RAD-210).
    revalidatePath("/", "layout")

    return NextResponse.json(source)
  } catch (error) {
    console.error("Error clearing feed error:", error)
    return NextResponse.json(
      { error: "Failed to clear error" },
      { status: 500 }
    )
  }
}
