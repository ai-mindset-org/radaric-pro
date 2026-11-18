import { NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { db } from "@/lib/db"
import { openNotionTokenOrEmpty } from "@/lib/notion-token"
import { pollStories, type StoriesApiDeps } from "@/lib/story-aggregator/stories-api"
import { processInboxItem, type PipelineDeps } from "@/lib/story-aggregator/pipeline"
import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"

function buildApiDeps(pipelineDeps: PipelineDeps): StoriesApiDeps {
  return {
    db: {
      inboxItem: {
        findMany: (args) => db.inboxItem.findMany(args as never),
        count: (args) => db.inboxItem.count(args as never),
      },
      story: {
        findMany: (args) => db.story.findMany(args as never),
        findUnique: (args) => db.story.findUnique(args as never) as never,
        count: (args) => db.story.count(args as never),
      },
      userSettings: {
        findUnique: (args) => db.userSettings.findUnique(args as never) as never,
      },
    },
    processItem: (itemId: string) => processInboxItem(itemId, pipelineDeps).then(() => {}),
  }
}

export async function POST() {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  // RAD-296: polling processes inbox items through the paid pipeline.
  const limited = checkUserRateLimit("stories-poll", userId, role, RATE_LIMITS.storiesPoll)
  if (limited) return limited

  // RAD-297: unverified accounts get the demo, not paid AI work.
  const emailGate = await requireVerifiedEmail(userId, role)
  if (emailGate) return emailGate

  const gate = await requireActiveSubscription(userId, role)
  if (gate) return gate

  const userSettings = await db.userSettings.findUnique({
    where: { userId },
  })

  // RAD-221: sealed at rest; a token that does not open means no Notion export, not a failed run.
  const notionToken = openNotionTokenOrEmpty(userSettings?.notionToken, userId, "StoriesPoll")
  const pipelineDeps = await buildPipelineDeps(userId, notionToken)
  const apiDeps = buildApiDeps(pipelineDeps)

  const result = await pollStories(userId, apiDeps)

  return NextResponse.json({
    success: true,
    ...result,
  })
}
