import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { openNotionToken } from "@/lib/notion-token"
import { publishToNotion } from "@/lib/story-aggregator/pipeline"
import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"

// POST /api/stories/[id]/notion — Send story to Notion
export async function POST(
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

    // Verify ownership
    const story = await db.story.findUnique({ where: { id } })
    if (!story || story.userId !== userId) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 })
    }

    // Get Notion token from user settings
    const userSettings = await db.userSettings.findUnique({
      where: { userId },
    })

    if (!userSettings?.notionToken || !userSettings?.storyNotionDatabaseId) {
      return NextResponse.json(
        { error: "Notion not configured. Set up Notion token and Story database ID in Settings." },
        { status: 400 }
      )
    }

    // Allow re-calls if story is already SENT_TO_NOTION — publishToNotion handles
    // update-vs-create gracefully, and we need retries in case the material update
    // failed on a previous call
    // RAD-221: the stored value is sealed; open it for this user.
    let notionToken: string
    try {
      notionToken = openNotionToken(userSettings.notionToken, userId)
    } catch (error) {
      console.error("[StoryNotion] Notion token unavailable:", (error as Error).message)
      return NextResponse.json(
        { error: "The saved Notion token cannot be read. Save it again in Settings." },
        { status: 400 }
      )
    }
    const deps = await buildPipelineDeps(userId, notionToken)
    const pageId = await publishToNotion(id, deps)

    if (!pageId) {
      return NextResponse.json(
        { error: "Failed to publish to Notion" },
        { status: 500 }
      )
    }

    // Mark all constituent materials as SENT_TO_NOTION to prevent individual exports
    // Include feed.userId for defense-in-depth data isolation
    await db.material.updateMany({
      where: { storyId: id, feed: { userId } },
      data: { userStatus: "SENT_TO_NOTION" },
    })

    // Construct URL from pageId to avoid extra DB query
    const notionUrl = story.notionUrl ?? `https://notion.so/${pageId.replace(/-/g, "")}`

    return NextResponse.json({
      notionPageId: pageId,
      notionUrl,
    })
  } catch (error: any) {
    console.error("[API] Error sending story to Notion:", error.message)
    return NextResponse.json(
      { error: "Failed to send to Notion" },
      { status: 500 }
    )
  }
}
