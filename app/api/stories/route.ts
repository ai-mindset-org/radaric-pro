import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { listStories, type StoriesApiDeps } from "@/lib/story-aggregator/stories-api"

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

export async function GET(request: NextRequest) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  const url = new URL(request.url)
  const status = url.searchParams.get("status") ?? undefined
  const page = Number(url.searchParams.get("page") ?? 1)
  const limit = Number(url.searchParams.get("limit") ?? 20)

  const deps = buildDeps()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [result, pendingCount, errorCount, processedToday] = await Promise.all([
    listStories(userId, { status, page, limit }, deps),
    db.inboxItem.count({ where: { userId, status: "PENDING" } }),
    db.inboxItem.count({ where: { userId, status: "ERROR" } }),
    db.inboxItem.count({
      where: { userId, status: "PROCESSED", processedAt: { gte: todayStart } },
    }),
  ])

  return NextResponse.json({
    ...result,
    pendingCount,
    errorCount,
    processedToday,
  })
}
