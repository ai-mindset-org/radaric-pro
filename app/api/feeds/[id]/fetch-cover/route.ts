import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { fetchSourceCover } from "@/lib/feed-cover"

// POST /api/feeds/[id]/fetch-cover - Manually fetch/refresh cover image
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
    const source = await db.feed.findUnique({
      where: { id, userId },
    })

    if (!source) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    const coverUrl = await fetchSourceCover({ type: source.type, url: source.url })
    if (!coverUrl) {
      return NextResponse.json({ coverUrl: null, message: "No cover image found" })
    }

    await db.feed.update({
      where: { id, userId },
      data: { coverUrl },
    })

    // Refresh the dashboard layout so the sidebar picks up the new cover (RAD-210).
    revalidatePath("/", "layout")

    return NextResponse.json({ coverUrl })
  } catch (error) {
    console.error("Error fetching feed cover:", error)
    return NextResponse.json(
      { error: "Failed to fetch cover" },
      { status: 500 }
    )
  }
}
