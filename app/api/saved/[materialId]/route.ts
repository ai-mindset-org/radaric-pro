import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { moveSavedSchema } from "@/lib/validations/saved"
import { resolveTargetCollectionId } from "@/lib/saved/collections"

// DELETE /api/saved/[materialId] — unsave a whole material
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { materialId } = await params

    const existing = await db.savedItem.findUnique({
      where: { userId_materialId: { userId, materialId } },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: true, deleted: false })
    }

    await db.savedItem.delete({ where: { id: existing.id } })
    return NextResponse.json({ ok: true, deleted: true })
  } catch (error) {
    console.error("Error unsaving material:", error)
    return NextResponse.json({ error: "Failed to unsave material" }, { status: 500 })
  }
}

// PATCH /api/saved/[materialId] — re-file a saved item into another collection
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { materialId } = await params

    const parsed = moveSavedSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const existing = await db.savedItem.findUnique({
      where: { userId_materialId: { userId, materialId } },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: "Saved item not found" }, { status: 404 })
    }

    const targetCollectionId = await resolveTargetCollectionId(userId, parsed.data)
    if (!targetCollectionId) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }

    const updated = await db.savedItem.update({
      where: { id: existing.id },
      data: { collectionId: targetCollectionId },
      select: { id: true, collection: { select: { id: true, name: true } } },
    })

    return NextResponse.json({ id: updated.id, collection: updated.collection })
  } catch (error) {
    console.error("Error moving saved item:", error)
    return NextResponse.json({ error: "Failed to move saved item" }, { status: 500 })
  }
}
