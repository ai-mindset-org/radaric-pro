import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { saveItemSchema } from "@/lib/validations/saved"
import { resolveTargetCollectionId } from "@/lib/saved/collections"

// GET /api/saved — list the user's saved items (optionally ?collectionId=)
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const collectionId = request.nextUrl.searchParams.get("collectionId") ?? undefined

    const saved = await db.savedItem.findMany({
      where: { userId, ...(collectionId ? { collectionId } : {}) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        materialId: true,
        collectionId: true,
        createdAt: true,
        collection: { select: { id: true, name: true } },
      },
    })

    return NextResponse.json({ saved })
  } catch (error) {
    console.error("Error listing saved items:", error)
    return NextResponse.json({ error: "Failed to list saved items" }, { status: 500 })
  }
}

// POST /api/saved — save a whole material (idempotent per user+material)
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const parsed = saveItemSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { materialId, collectionId, collectionName } = parsed.data

    // Ownership: the material must belong to one of the user's sources.
    const material = await db.material.findUnique({
      where: { id: materialId },
      select: { id: true, feed: { select: { userId: true } } },
    })
    if (!material || material.feed.userId !== userId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 })
    }

    // If already saved, keep its current collection (don't silently re-file).
    const existing = await db.savedItem.findUnique({
      where: { userId_materialId: { userId, materialId } },
      select: { id: true, collection: { select: { id: true, name: true } } },
    })
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        materialId,
        created: false,
        collection: existing.collection,
      })
    }

    const targetCollectionId = await resolveTargetCollectionId(userId, {
      collectionId,
      collectionName,
    })
    if (!targetCollectionId) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    }

    let saved
    try {
      saved = await db.savedItem.create({
        data: { userId, materialId, collectionId: targetCollectionId },
        select: { id: true, collection: { select: { id: true, name: true } } },
      })
    } catch (e) {
      // Concurrent save (two tabs, or undo→re-save) loses the find-then-create
      // race and hits the (userId, materialId) unique. Treat as idempotent
      // success — return the existing save, never a 500.
      if ((e as { code?: string }).code === "P2002") {
        const existing2 = await db.savedItem.findUnique({
          where: { userId_materialId: { userId, materialId } },
          select: { id: true, collection: { select: { id: true, name: true } } },
        })
        if (existing2) {
          return NextResponse.json({
            id: existing2.id,
            materialId,
            created: false,
            collection: existing2.collection,
          })
        }
      }
      throw e
    }

    // Best-effort: touch the collection so it sorts to the top of the Library.
    // A failure here must NOT fail an already-persisted save.
    try {
      await db.collection.update({
        where: { id: targetCollectionId },
        data: { updatedAt: new Date() },
      })
    } catch {
      /* sort-order touch is non-critical */
    }

    return NextResponse.json({
      id: saved.id,
      materialId,
      created: true,
      collection: saved.collection,
    })
  } catch (error) {
    console.error("Error saving material:", error)
    return NextResponse.json({ error: "Failed to save material" }, { status: 500 })
  }
}
