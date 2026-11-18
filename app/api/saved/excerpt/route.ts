import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { saveExcerptSchema } from "@/lib/validations/saved"
import { resolveTargetCollectionId } from "@/lib/saved/collections"

// POST /api/saved/excerpt — save a highlighted passage as a citation
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const parsed = saveExcerptSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { materialId, text, offsetStart, offsetEnd, collectionId, collectionName } = parsed.data

    // Ownership via source.
    const material = await db.material.findUnique({
      where: { id: materialId },
      select: { id: true, feed: { select: { userId: true } } },
    })
    if (!material || material.feed.userId !== userId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 })
    }

    const targetCollectionId = await resolveTargetCollectionId(userId, { collectionId, collectionName })
    if (!targetCollectionId) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }

    const excerpt = await db.savedExcerpt.create({
      data: { userId, materialId, collectionId: targetCollectionId, text, offsetStart, offsetEnd },
      select: { id: true, offsetStart: true, offsetEnd: true, collection: { select: { id: true, name: true } } },
    })
    // Best-effort sort-order touch — must not fail an already-persisted excerpt.
    try {
      await db.collection.update({ where: { id: targetCollectionId }, data: { updatedAt: new Date() } })
    } catch {
      /* non-critical */
    }

    return NextResponse.json({
      id: excerpt.id,
      offsetStart: excerpt.offsetStart,
      offsetEnd: excerpt.offsetEnd,
      collection: excerpt.collection,
    })
  } catch (error) {
    console.error("Error saving excerpt:", error)
    return NextResponse.json({ error: "Failed to save excerpt" }, { status: 500 })
  }
}
