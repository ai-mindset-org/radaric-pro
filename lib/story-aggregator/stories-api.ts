/**
 * Stories API handlers for Story Aggregator
 * Business logic for story-related API routes, separated from Next.js route handlers.
 * Uses dependency injection for testability.
 *
 * Exported functions:
 *   pollStories(userId, deps) — process PENDING/ERROR inbox items
 *   listStories(userId, filters, deps) — list stories with pagination/filters
 *   getStoryById(storyId, userId, deps) — get single story with inbox items
 *
 * Spec: the Story Aggregator specification, sections 4.1, 5.2
 */

// Items created before this date are ignored by pollStories and retry daemon.
// Prevents reprocessing of legacy inbox items after system changes.
// Safe to remove once all pre-March 2026 PENDING/ERROR items are archived.
export const INBOX_CUTOFF_DATE = new Date("2026-03-01T00:00:00Z")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxItemRecord {
  id: string
  status: string
}

interface StoryRecord {
  id: string
  userId: string
  title: string
  summary: string
  body: string
  status: string
  createdAt: Date
  inboxItems?: unknown[]
  [key: string]: unknown
}

export interface StoriesApiDeps {
  db: {
    inboxItem: {
      findMany: (args: Record<string, unknown>) => Promise<InboxItemRecord[]>
      count: (args: Record<string, unknown>) => Promise<number>
    }
    story: {
      findMany: (args: Record<string, unknown>) => Promise<StoryRecord[]>
      findUnique: (args: Record<string, unknown>) => Promise<StoryRecord | null>
      count: (args: Record<string, unknown>) => Promise<number>
    }
    userSettings: {
      findUnique: (args: { where: { userId: string } }) => Promise<Record<string, unknown> | null>
    }
  }
  processItem: (itemId: string) => Promise<unknown>
}

export interface ListStoriesFilters {
  status?: string
  page?: number
  limit?: number
}

interface PollResult {
  processed: number
  errors: number
  total: number
}

interface ListResult {
  stories: StoryRecord[]
  total: number
  page: number
  limit: number
}

// ---------------------------------------------------------------------------
// pollStories
// ---------------------------------------------------------------------------

const MAX_POLL_ITEMS = 50

/**
 * Process PENDING and ERROR inbox items for the given user.
 * Fetches up to 50 items and processes each through the pipeline.
 * Continues even if individual items fail.
 */
export async function pollStories(
  userId: string,
  deps: StoriesApiDeps
): Promise<PollResult> {
  const items = await deps.db.inboxItem.findMany({
    where: {
      userId,
      status: { in: ["PENDING", "ERROR"] },
      createdAt: { gte: INBOX_CUTOFF_DATE },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_POLL_ITEMS,
  })

  let processed = 0
  let errors = 0

  for (const item of items) {
    try {
      await deps.processItem(item.id)
      processed++
    } catch {
      errors++
    }
  }

  return {
    processed,
    errors,
    total: items.length,
  }
}

// ---------------------------------------------------------------------------
// listStories
// ---------------------------------------------------------------------------

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 20

/**
 * List stories for the given user with optional filters and pagination.
 * Returns stories ordered by createdAt desc (newest first).
 */
export async function listStories(
  userId: string,
  filters: ListStoriesFilters,
  deps: StoriesApiDeps
): Promise<ListResult> {
  const page = filters.page ?? DEFAULT_PAGE
  const limit = filters.limit ?? DEFAULT_LIMIT
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = { userId }
  if (filters.status) {
    where.status = filters.status
  }

  const [stories, total] = await Promise.all([
    deps.db.story.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        _count: { select: { inboxItems: true } },
        inboxItems: {
          select: { thumbnailUrl: true, mediaUrls: true },
          take: 1,
          orderBy: { createdAt: "asc" as const },
        },
      },
    }),
    deps.db.story.count({ where }),
  ])

  return {
    stories,
    total,
    page,
    limit,
  }
}

// ---------------------------------------------------------------------------
// getStoryById
// ---------------------------------------------------------------------------

/**
 * Fetch a single story with its inbox items and constituent materials.
 *
 * The materials block mirrors `/stories/[id]`'s own select (RAD-345: the side
 * peek renders the same reading body as the page, so the two payloads must not
 * drift), plus each material's feedback for the requesting user only.
 * Returns null if the story doesn't exist or belongs to a different user.
 */
export async function getStoryById(
  storyId: string,
  userId: string,
  deps: StoriesApiDeps
): Promise<StoryRecord | null> {
  const story = await deps.db.story.findUnique({
    where: { id: storyId },
    include: {
      inboxItems: {
        orderBy: { createdAt: "asc" },
      },
      materials: {
        select: {
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
          feed: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          feedbacks: {
            where: { userId },
            select: { feedbackType: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  })

  if (!story) return null
  if (story.userId !== userId) return null

  return story
}
