import { NextRequest, NextResponse } from "next/server"
import { sendMaterialToNotion } from "@/lib/notion"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

// POST /api/materials/[id]/notion - Send material to Notion
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
    console.log("[API] Sending material to Notion, materialId:", id, "userId:", userId)

    // Verify ownership through source
    const material = await db.material.findUnique({
      where: { id },
      include: { feed: true },
    })

    if (!material || material.feed.userId !== userId) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    const result = await sendMaterialToNotion(id, userId)

    console.log("[API] Successfully sent to Notion:", result)
    return NextResponse.json(result)
  } catch (error: any) {
    console.error("[API] Error sending to Notion:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
      fullError: error,
    })
    return NextResponse.json(
      {
        error: error.message || "Failed to send to Notion",
        code: error.code,
      },
      { status: 500 }
    )
  }
}
