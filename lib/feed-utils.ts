/**
 * Feed utilities — pure data transformations for the unified posts+stories feed.
 * Extracted from materials-list.tsx to enable testing and remove the showStoriesOnly toggle.
 *
 * RAD-140: Stories are just grouped posts in a single feed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterType = "ALL" | "INBOX" | "APPROVED" | "FILTERED" | "SENT_TO_NOTION" | "ARCHIVED"
export type SourceTypeFilter = "ALL" | "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "EVENT_TRIGGER"

export interface FeedMaterial {
  id: string
  title: string
  url: string
  content: string
  contentEntities?: any[] | null
  thumbnailUrl?: string | null
  mediaUrls?: string[]
  aiEvaluation: "APPROVED" | "FILTERED"
  aiConfidence: number
  aiReasoning: string | null
  createdAt: string
  publishedAt: Date | null
  userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
  feed: {
    id: string
    name: string
    type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
  }
  feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
  storyId?: string | null
  story?: {
    id: string
    title: string
    summary: string
    rubrics: string[]
    sourceUrls: string[]
    status: string
    version: number
    createdAt: string
    _count: { materials: number; inboxItems: number }
  } | null
}

export type StoryGroup = {
  story: NonNullable<FeedMaterial["story"]>
  materials: FeedMaterial[]
}

export type RenderItem =
  | { type: "story"; key: string; story: StoryGroup; date: number }
  | { type: "material"; key: string; material: FeedMaterial; date: number }

// ---------------------------------------------------------------------------
// getFilterPredicate
// ---------------------------------------------------------------------------

export function getFilterPredicate(filter: FilterType): (m: FeedMaterial) => boolean {
  switch (filter) {
    case "INBOX":
      return (m) =>
        m.userStatus !== "DELETED" &&
        m.userStatus !== "ARCHIVED" &&
        m.aiEvaluation === "APPROVED"
    case "APPROVED":
      return (m) => m.userStatus !== "DELETED" && m.userStatus !== "ARCHIVED" && m.aiEvaluation === "APPROVED"
    case "FILTERED":
      return (m) => m.userStatus !== "DELETED" && m.aiEvaluation === "FILTERED"
    case "SENT_TO_NOTION":
      return (m) => m.userStatus === "SENT_TO_STORIES"
    case "ARCHIVED":
      return (m) => m.userStatus === "ARCHIVED"
    case "ALL":
    default:
      return (m) => m.userStatus !== "DELETED"
  }
}

// ---------------------------------------------------------------------------
// buildRenderItems
// ---------------------------------------------------------------------------

/** Check if a material matches a set of source type filters. */
export function matchesSourceTypes(m: FeedMaterial, sourceTypes: SourceTypeFilter | SourceTypeFilter[]): boolean {
  const types = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes]
  if (types.length === 0 || types.includes("ALL")) return true
  return types.some((st) => {
    if (st === "EVENT_TRIGGER") return m.feed.type === "EVENT_TRIGGER" || m.feed.type === "INTEREST"
    return m.feed.type === st
  })
}

export function buildRenderItems(
  materials: FeedMaterial[],
  filter: FilterType,
  sourceTypeFilter: SourceTypeFilter | SourceTypeFilter[]
): RenderItem[] {
  // 1. Apply filter predicate
  const predicate = getFilterPredicate(filter)
  let filtered = materials.filter(predicate)

  // 2. Apply source type filter (supports multi-select)
  filtered = filtered.filter((m) => matchesSourceTypes(m, sourceTypeFilter))

  // 3. Group by storyId
  const storyGroups = new Map<string, StoryGroup>()
  const standalone: FeedMaterial[] = []

  for (const material of filtered) {
    if (material.storyId && material.story) {
      const existing = storyGroups.get(material.storyId)
      if (existing) {
        existing.materials.push(material)
      } else {
        storyGroups.set(material.storyId, {
          story: material.story,
          materials: [material],
        })
      }
    } else {
      standalone.push(material)
    }
  }

  // 4. Build unified render list
  const items: RenderItem[] = []

  for (const group of storyGroups.values()) {
    items.push({
      type: "story",
      key: `story-${group.story.id}`,
      story: group,
      date: Math.max(...group.materials.map((m) => new Date(m.createdAt).getTime())),
    })
  }

  for (const material of standalone) {
    items.push({
      type: "material",
      key: material.id,
      material,
      date: new Date(material.createdAt).getTime(),
    })
  }

  // 5. Sort by date descending
  items.sort((a, b) => b.date - a.date)

  return items
}
