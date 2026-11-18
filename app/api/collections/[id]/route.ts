import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { deleteTrackedCollection } from "@/lib/saved/subscription"

// DELETE /api/collections/[id] — delete a collection. If self-filling, this also
// tears down the backing Parallel monitor and its hidden feed (monitor → feed →
// collection order; see deleteTrackedCollection). Manual collections just cascade
// their saves/excerpts.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { id } = await params
    const deleted = await deleteTrackedCollection(userId, id)
    if (!deleted) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("Error deleting collection:", error)
    return NextResponse.json({ error: "Failed to delete collection" }, { status: 500 })
  }
}
