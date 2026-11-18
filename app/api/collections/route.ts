import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { createCollectionSchema } from "@/lib/validations/saved"
import { getCollectionsWithCounts } from "@/lib/saved/queries"

// GET /api/collections — list the user's collections with counts
export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const collections = await getCollectionsWithCounts(authResult.userId)
    return NextResponse.json({ collections })
  } catch (error) {
    console.error("Error listing collections:", error)
    return NextResponse.json({ error: "Failed to list collections" }, { status: 500 })
  }
}

// POST /api/collections — create (or get) a topic-collection by name
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const parsed = createCollectionSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    // Idempotent: upsert on the (userId, name) unique so a duplicate name
    // returns the existing collection instead of erroring.
    const collection = await db.collection.upsert({
      where: { userId_name: { userId, name: parsed.data.name } },
      update: {},
      create: { userId, name: parsed.data.name },
    })

    return NextResponse.json({
      id: collection.id,
      name: collection.name,
      isSystem: collection.isSystem,
    })
  } catch (error) {
    console.error("Error creating collection:", error)
    return NextResponse.json({ error: "Failed to create collection" }, { status: 500 })
  }
}
