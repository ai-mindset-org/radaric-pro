import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// DELETE /api/saved/excerpt/[id] — remove a saved excerpt
export async function DELETE(
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
    const existing = await db.savedExcerpt.findFirst({
      where: { id, userId },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: true, deleted: false })
    }

    await db.savedExcerpt.delete({ where: { id: existing.id } })
    return NextResponse.json({ ok: true, deleted: true })
  } catch (error) {
    console.error("Error deleting excerpt:", error)
    return NextResponse.json({ error: "Failed to delete excerpt" }, { status: 500 })
  }
}
