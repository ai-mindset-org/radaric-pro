import { NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

  const { id } = await params

  const item = await db.inboxItem.findUnique({ where: { id } })
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (item.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  await db.inboxItem.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
