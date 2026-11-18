import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { getStoryById, type StoriesApiDeps } from "@/lib/story-aggregator/stories-api"

function buildDeps(): StoriesApiDeps {
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
    processItem: async () => {},
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  const { id } = await params
  const deps = buildDeps()
  const story = await getStoryById(id, userId, deps)

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 })
  }

  return NextResponse.json(story)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

  const { id } = await params

  const story = await db.story.findUnique({ where: { id } })
  if (!story || story.userId !== userId) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 })
  }

  // Unlink inbox items (set them back to PENDING so they can be reprocessed)
  await db.inboxItem.updateMany({
    where: { storyId: id },
    data: { storyId: null, status: "PENDING" },
  })

  await db.story.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
