import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { LIKED_CATEGORIES, DISLIKED_CATEGORIES } from "@/lib/content-categories"

const LIKED_SET = new Set<string>(LIKED_CATEGORIES)
const DISLIKED_SET = new Set<string>(DISLIKED_CATEGORIES)

// GET /api/categories/custom — Aggregate custom categories across all user's sources
export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const sources = await db.feed.findMany({
      // hidden:false: a self-filling collection's backing feed isn't a user-
      // managed source, so its category prefs shouldn't surface here.
      where: { userId, hidden: false },
      select: {
        likedCategories: true,
        dislikedCategories: true,
      },
    })

    const liked = new Set<string>()
    const disliked = new Set<string>()

    for (const source of sources) {
      for (const cat of source.likedCategories) {
        if (!LIKED_SET.has(cat)) liked.add(cat)
      }
      for (const cat of source.dislikedCategories) {
        if (!DISLIKED_SET.has(cat)) disliked.add(cat)
      }
    }

    return NextResponse.json({
      liked: Array.from(liked),
      disliked: Array.from(disliked),
    })
  } catch (error) {
    console.error("Error fetching custom categories:", error)
    return NextResponse.json(
      { error: "Failed to fetch custom categories" },
      { status: 500 }
    )
  }
}
