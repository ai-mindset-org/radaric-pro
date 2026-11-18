import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { openNotionTokenOrEmpty } from "@/lib/notion-token"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { stripHtml } from "@/lib/sanitize"
import { processInboxItem } from "@/lib/story-aggregator/pipeline"
import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"

// POST /api/materials/[id]/stories — Send material to Story Aggregator pipeline
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    // RAD-296: sending a material to the pipeline is a paid run.
    const limited = checkUserRateLimit("post-stories", userId, role, RATE_LIMITS.postStories)
    if (limited) return limited

    // RAD-297: unverified accounts get the demo, not paid AI work.
    const emailGate = await requireVerifiedEmail(userId, role)
    if (emailGate) return emailGate

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params

    // Load material with source, verify ownership
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

    // Guard: already sent
    if (material.userStatus === "SENT_TO_STORIES") {
      return NextResponse.json(
        { error: "Material already sent to stories" },
        { status: 400 }
      )
    }

    // Dedup: check if InboxItem with this externalId already exists
    const externalId = `material:${material.id}`
    const existing = await db.inboxItem.findFirst({
      where: { externalId, userId },
    })

    if (existing) {
      return NextResponse.json(
        { error: "Material already queued for story processing" },
        { status: 400 }
      )
    }

    // Get user's Notion token
    const userSettings = await db.userSettings.findUnique({
      where: { userId },
    })
    // RAD-221: sealed at rest; a token that does not open means no Notion export, not a failed run.
    const notionToken = openNotionTokenOrEmpty(userSettings?.notionToken, userId, "SendToStories")

    // Strip HTML from content for rawText
    const rawText = stripHtml(material.content)

    // Create InboxItem for the pipeline
    const inboxItem = await db.inboxItem.create({
      data: {
        externalId,
        messageId: 0,
        rawText,
        extractedUrl: material.url,
        mediaUrls: material.mediaUrls || [],
        thumbnailUrl: material.thumbnailUrl,
        sourceChannel: material.feed.name,
        status: "PENDING",
        userId,
      },
    })

    // Update material status
    await db.material.update({
      where: { id },
      data: { userStatus: "SENT_TO_STORIES" },
    })

    // Fire-and-forget: process in background
    buildPipelineDeps(userId, notionToken)
      .then((deps) => processInboxItem(inboxItem.id, deps))
      .catch((err) => console.error(`[SendToStories] Pipeline error for material ${id}:`, err))

    return NextResponse.json({
      success: true,
      inboxItemId: inboxItem.id,
    })
  } catch (error) {
    console.error("Error sending material to stories:", error)
    return NextResponse.json(
      { error: "Failed to send material to stories" },
      { status: 500 }
    )
  }
}
