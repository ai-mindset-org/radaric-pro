import type { Prisma } from "@prisma/client"
import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import {
  countMaterialsForScope,
  type FilterCounts,
  type SourceTypeCounts,
} from "@/lib/materials/material-counts"

export type { FilterCounts, SourceTypeCounts }

export type ServerCountsAll = {
  filter: FilterCounts
  sourceType: SourceTypeCounts
}

export type ServerCountsPerSource = {
  filter: FilterCounts
}

export type FetchMaterialsPageResultAll = {
  materials: unknown[]
  total: number
  serverCounts: ServerCountsAll
}

export type FetchMaterialsPageResultPerSource = {
  materials: unknown[]
  total: number
  serverCounts: ServerCountsPerSource
}

export type FetchMaterialsPageResult =
  | FetchMaterialsPageResultAll
  | FetchMaterialsPageResultPerSource

export type UserOnboardedSettings = {
  onboardingCompleted: boolean
  onboardingBannerDismissed: boolean
  notionToken: string | null
  notionDatabaseId: string | null
  /** The story database — stories carry their own Notion target (RAD-345). */
  storyNotionDatabaseId: string | null
}

export class FeedNotFoundOrForbiddenError extends Error {
  constructor(feedId: string) {
    super(`Feed ${feedId} not found or not accessible by the current user`)
    this.name = "FeedNotFoundOrForbiddenError"
  }
}

export class FolderNotFoundOrForbiddenError extends Error {
  constructor(folderId: string) {
    super(`Folder ${folderId} not found or not accessible by the current user`)
    this.name = "FolderNotFoundOrForbiddenError"
  }
}

export async function requireOnboarded(userId: string): Promise<UserOnboardedSettings> {
  const initial = await db.userSettings.findUnique({
    where: { userId },
    select: {
      onboardingCompleted: true,
      onboardingBannerDismissed: true,
      notionToken: true,
      notionDatabaseId: true,
      storyNotionDatabaseId: true,
    },
  })

  if (initial?.onboardingCompleted) {
    return initial
  }

  const feedCount = await db.feed.count({ where: { userId } })
  if (feedCount === 0) {
    redirect("/onboarding/feeds")
  }

  await db.userSettings.upsert({
    where: { userId },
    update: { onboardingCompleted: true },
    create: { userId, onboardingCompleted: true },
  })

  return {
    onboardingCompleted: true,
    onboardingBannerDismissed: initial?.onboardingBannerDismissed ?? false,
    notionToken: initial?.notionToken ?? null,
    notionDatabaseId: initial?.notionDatabaseId ?? null,
    storyNotionDatabaseId: initial?.storyNotionDatabaseId ?? null,
  }
}

export function fetchMaterialsPage(params: {
  userId: string
  feedId: string
  pageSize?: number
}): Promise<FetchMaterialsPageResultPerSource>
export function fetchMaterialsPage(params: {
  userId: string
  folderId: string
  pageSize?: number
}): Promise<FetchMaterialsPageResultAll>
export function fetchMaterialsPage(params: {
  userId: string
  feedId?: undefined
  folderId?: undefined
  pageSize?: number
}): Promise<FetchMaterialsPageResultAll>
export async function fetchMaterialsPage(params: {
  userId: string
  feedId?: string
  folderId?: string
  pageSize?: number
}): Promise<FetchMaterialsPageResult> {
  const { userId, feedId, folderId, pageSize = 96 } = params

  if (feedId) {
    const owned = await db.feed.findFirst({
      where: { id: feedId, userId },
      select: { id: true },
    })
    if (!owned) {
      throw new FeedNotFoundOrForbiddenError(feedId)
    }
  }

  if (folderId) {
    const owned = await db.folder.findFirst({
      where: { id: folderId, userId },
      select: { id: true },
    })
    if (!owned) {
      throw new FolderNotFoundOrForbiddenError(folderId)
    }
  }

  // Self-filling collections' backing monitor feeds are hidden from the global
  // feed — their material belongs to the tracked-question answer, not the triage
  // stream. When viewing one feed the user chose it explicitly, so scope to its id.
  // A folder (RAD-393) scopes to its visible, active members — the tree the
  // sidebar shows is the tree the folder view reflects.
  const feedScope: Prisma.FeedWhereInput = feedId
    ? { userId, id: feedId }
    : folderId
      ? { userId, folderId, hidden: false, isActive: true }
      : { userId, hidden: false }

  const baseWhere: Prisma.MaterialWhereInput = { feed: feedScope, userStatus: { not: "DELETED" } }

  const materialSelect = {
    id: true,
    title: true,
    url: true,
    content: true,
    contentEntities: true,
    publishedAt: true,
    thumbnailUrl: true,
    mediaUrls: true,
    aiEvaluation: true,
    aiConfidence: true,
    aiReasoning: true,
    userStatus: true,
    createdAt: true,
    updatedAt: true,
    feed: {
      select: {
        id: true,
        name: true,
        type: true,
      },
    },
    storyId: true,
    story: {
      select: {
        id: true,
        title: true,
        summary: true,
        rubrics: true,
        sourceUrls: true,
        status: true,
        version: true,
        createdAt: true,
        _count: {
          select: { materials: true, inboxItems: true },
        },
      },
    },
    feedbacks: {
      where: { userId },
      select: { feedbackType: true },
      take: 1,
    },
    savedItems: {
      where: { userId },
      select: { id: true },
      take: 1,
    },
  } satisfies Prisma.MaterialSelect

  const findMaterialsQuery = db.material.findMany({
    where: baseWhere,
    select: materialSelect,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: pageSize,
  })

  // The counts live in one shared helper so this page and the toolbar's live
  // refresh (`/api/posts/counts`) can never disagree (RAD-343). `total` is the
  // helper's ALL — same predicate this function used to run separately.
  if (feedId) {
    const [materials, counts] = await Promise.all([
      findMaterialsQuery,
      countMaterialsForScope({ userId, sourceId: feedId }),
    ])

    return {
      materials,
      total: counts.filter.ALL,
      serverCounts: { filter: counts.filter },
    }
  }

  const [materials, counts] = await Promise.all([
    findMaterialsQuery,
    countMaterialsForScope(folderId ? { userId, folderId } : { userId }),
  ])

  return {
    materials,
    total: counts.filter.ALL,
    serverCounts: {
      filter: counts.filter,
      sourceType: counts.sourceType!,
    },
  }
}
