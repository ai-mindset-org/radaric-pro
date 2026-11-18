import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params

    // Check ownership before deleting
    const item = await db.blacklistItem.findUnique({
      where: { id, userId },
    })

    if (!item) {
      return NextResponse.json(
        { error: "Blacklist item not found" },
        { status: 404 }
      )
    }

    await db.blacklistItem.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting blacklist item:", error)
    return NextResponse.json(
      { error: "Failed to delete blacklist item" },
      { status: 500 }
    )
  }
}
