import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"

export type FilterCounts = {
  INBOX: number
  APPROVED: number
  FILTERED: number
  SENT_TO_NOTION: number
  ARCHIVED: number
  ALL: number
}

export type SourceTypeCounts = {
  ALL: number
  RSS: number
  TELEGRAM: number
  TWITTER: number
  YOUTUBE: number
  EVENT_TRIGGER: number
}

/**
 * The posts toolbar's counts, computed in one place for both callers that need
 * them: the page itself (SSR) and `GET /api/posts/counts` — the live refresh
 * the toolbar subscribes to (RAD-343). Split out so the two can never drift; a
 * heading that disagrees with its own grid is worse than a stale one.
 *
 * `sourceId` scopes every count to one source (the `/feeds/[id]` page).
 * `folderId` scopes to a folder's visible, active member sources (RAD-393) —
 * the same tree the sidebar shows.
 * The account-wide scope also excludes hidden backing feeds (self-filling
 * collections), exactly as the sidebar and the posts page do.
 *
 * Predicate notes, preserved verbatim from the page:
 *   - `INBOX` and `APPROVED` are the same number — both tabs read approved,
 *     not-archived, not-deleted.
 *   - The view labelled "Sent to Notion" counts `SENT_TO_STORIES`.
 *   - `sourceType` is computed for the account-wide and folder scopes; the
 *     per-source page hides that filter (one source = one type).
 */
export async function countMaterialsForScope(params: {
  userId: string
  sourceId?: string | null
  folderId?: string | null
}): Promise<{ filter: FilterCounts; sourceType?: SourceTypeCounts }> {
  const { userId, sourceId, folderId } = params
  const feedScope: Prisma.FeedWhereInput = sourceId
    ? folderId
      ? // Both scopes intersect, exactly as /api/posts does.
        { userId, id: sourceId, folderId, hidden: false, isActive: true }
      : { userId, id: sourceId }
    : folderId
      ? { userId, folderId, hidden: false, isActive: true }
      : { userId, hidden: false }
  const baseWhere: Prisma.MaterialWhereInput = {
    feed: feedScope,
    userStatus: { not: "DELETED" },
  }

  const [filterCounts, typeCounts] = await Promise.all([
    Promise.all([
      db.material.count({ where: baseWhere }),
      db.material.count({
        where: { ...baseWhere, aiEvaluation: "APPROVED", userStatus: { notIn: ["DELETED", "ARCHIVED"] } },
      }),
      db.material.count({ where: { ...baseWhere, aiEvaluation: "FILTERED" } }),
      db.material.count({ where: { feed: feedScope, userStatus: "SENT_TO_STORIES" } }),
      db.material.count({ where: { feed: feedScope, userStatus: "ARCHIVED" } }),
    ]),
    // Issued in the same tick as the filter batch (one concurrent round trip):
    // this runs on every posts-page render and on every live-counts poll.
    sourceId
      ? null
      : Promise.all([
          db.material.count({ where: { ...baseWhere, feed: { ...feedScope, type: "RSS" } } }),
          db.material.count({ where: { ...baseWhere, feed: { ...feedScope, type: "TELEGRAM" } } }),
          db.material.count({ where: { ...baseWhere, feed: { ...feedScope, type: "TWITTER" } } }),
          // .catch(0) mirrors the EVENT_TRIGGER fallback below: a DB whose enum
          // hasn't been migrated yet must not fail the whole count.
          db.material
            .count({ where: { ...baseWhere, feed: { ...feedScope, type: "YOUTUBE" } } })
            .catch(() => 0),
          db.material
            .count({ where: { ...baseWhere, feed: { ...feedScope, type: { in: ["INTEREST", "EVENT_TRIGGER"] } } } })
            .catch(() => db.material.count({ where: { ...baseWhere, feed: { ...feedScope, type: "INTEREST" } } })),
        ]),
  ])

  const [total, approved, filtered, sentToStories, archived] = filterCounts
  const filter: FilterCounts = {
    INBOX: approved,
    APPROVED: approved,
    FILTERED: filtered,
    SENT_TO_NOTION: sentToStories,
    ARCHIVED: archived,
    ALL: total,
  }

  if (!typeCounts) return { filter }

  const [rss, telegram, twitter, youtube, eventTrigger] = typeCounts
  return {
    filter,
    sourceType: {
      ALL: total,
      RSS: rss,
      TELEGRAM: telegram,
      TWITTER: twitter,
      YOUTUBE: youtube,
      EVENT_TRIGGER: eventTrigger,
    },
  }
}
