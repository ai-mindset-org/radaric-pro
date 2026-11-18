import { NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { openNotionToken } from "@/lib/notion-token"
import { processInboxItem } from "@/lib/story-aggregator/pipeline"
import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  // RAD-296: each retry drives a paid pipeline run.
  const limited = checkUserRateLimit("inbox-retry", userId, role, RATE_LIMITS.inboxRetry)
  if (limited) return limited

  // RAD-297: unverified accounts get the demo, not paid AI work.
  const emailGate = await requireVerifiedEmail(userId, role)
  if (emailGate) return emailGate

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

  // Only allow retrying ERROR items
  if (item.status !== "ERROR") {
    return NextResponse.json(
      { error: "Item is not in ERROR state" },
      { status: 409 }
    )
  }

  const userSettings = await db.userSettings.findUnique({ where: { userId } })
  if (!userSettings?.notionToken) {
    return NextResponse.json(
      { success: false, error: "Notion token not configured" },
      { status: 422 }
    )
  }
  // RAD-221: open the sealed token before touching the item, so a token this
  // server cannot read leaves the item in ERROR instead of half-retried.
  let notionToken: string
  try {
    notionToken = openNotionToken(userSettings.notionToken, userId)
  } catch (error) {
    console.error("[InboxRetry] Notion token unavailable:", (error as Error).message)
    return NextResponse.json(
      { success: false, error: "The saved Notion token cannot be read. Save it again in Settings." },
      { status: 422 }
    )
  }

  // Reset status to PENDING so processInboxItem doesn't skip it
  // Don't increment retryCount here — pipeline increments on failure
  await db.inboxItem.update({
    where: { id },
    data: {
      status: "PENDING",
      errorMessage: null,
    },
  })

  try {
    const deps = await buildPipelineDeps(userId, notionToken)
    const result = await processInboxItem(id, deps)

    if (result.success) {
      return NextResponse.json({ success: true, storyId: result.storyId })
    } else {
      return NextResponse.json({ success: false, error: result.error }, { status: 422 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
