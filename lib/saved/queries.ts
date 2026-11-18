import { db } from "@/lib/db"

export type CollectionWithCounts = {
  id: string
  name: string
  isSystem: boolean
  itemCount: number
  excerptCount: number
  updatedAt: Date
  /** Self-filling collections carry the tracked query + cadence; null for manual ones. */
  query: string | null
  cadence: "HOURLY" | "DAILY" | "WEEKLY" | null
}

/** All of the user's collections with item + excerpt counts, system bucket last. */
export async function getCollectionsWithCounts(userId: string): Promise<CollectionWithCounts[]> {
  const collections = await db.collection.findMany({
    where: { userId },
    orderBy: [{ isSystem: "asc" }, { updatedAt: "desc" }],
    include: { _count: { select: { savedItems: true, savedExcerpts: true } } },
  })

  // Self-filling collections hold their material in the backing monitor feed
  // (not savedItems), so count those APPROVED materials in one grouped query.
  const monitorFeedIds = collections.map((c) => c.monitorFeedId).filter((id): id is string => Boolean(id))
  const trackedIds = collections.filter((c) => c.query != null).map((c) => c.id)
  const [autoGrouped, routedGrouped] = await Promise.all([
    monitorFeedIds.length > 0
      ? db.material.groupBy({
          by: ["sourceId"],
          where: { sourceId: { in: monitorFeedIds }, aiEvaluation: "APPROVED", userStatus: { not: "DELETED" } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    trackedIds.length > 0
      ? db.collectionMaterial.groupBy({
          by: ["collectionId"],
          where: { collectionId: { in: trackedIds }, material: { userStatus: { not: "DELETED" } } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ])
  const autoCounts = new Map<string, number>()
  for (const g of autoGrouped) autoCounts.set(g.sourceId, g._count._all)
  const routedCounts = new Map<string, number>()
  for (const g of routedGrouped) routedCounts.set(g.collectionId, g._count._all)

  return collections.map((c) => ({
    id: c.id,
    name: c.name,
    isSystem: c.isSystem,
    itemCount:
      c._count.savedItems +
      (c.monitorFeedId ? autoCounts.get(c.monitorFeedId) ?? 0 : 0) +
      (routedCounts.get(c.id) ?? 0),
    excerptCount: c._count.savedExcerpts,
    updatedAt: c.updatedAt,
    query: c.query,
    cadence: c.cadence,
  }))
}

/** Totals across all collections — drives the Library "All" tile + empty state. */
export async function getSavedTotals(userId: string): Promise<{ items: number; excerpts: number }> {
  const [items, excerpts] = await Promise.all([
    db.savedItem.count({ where: { userId } }),
    db.savedExcerpt.count({ where: { userId } }),
  ])
  return { items, excerpts }
}

export async function getCollection(userId: string, collectionId: string) {
  return db.collection.findFirst({ where: { id: collectionId, userId } })
}

const savedMaterialSelect = {
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
  feed: { select: { id: true, name: true, type: true } },
  feedbacks: { where: {}, select: { feedbackType: true }, take: 1 },
} as const

/** Saved whole-materials in a collection, newest first, shaped like the feed. */
export async function getSavedItemsForCollection(userId: string, collectionId: string) {
  const items = await db.savedItem.findMany({
    where: { userId, collectionId },
    orderBy: { createdAt: "desc" },
    include: {
      material: {
        select: {
          ...savedMaterialSelect,
          feedbacks: { where: { userId }, select: { feedbackType: true }, take: 1 },
        },
      },
    },
  })
  return items.map((s) => ({ savedId: s.id, savedAt: s.createdAt, material: s.material }))
}

/**
 * Auto-collected materials for a self-filling collection — the backing monitor
 * feed's APPROVED items (Slice 1) ∪ materials routed in from the user's normal
 * feeds (Slice 2), shaped like getSavedItemsForCollection so the same grid
 * renders them. Deduped by material id. Returns [] for a manual collection.
 */
export async function getAutoMaterialsForCollection(
  userId: string,
  collectionId: string,
  monitorFeedId: string | null
) {
  const [backing, routed] = await Promise.all([
    monitorFeedId
      ? db.material.findMany({
          where: { sourceId: monitorFeedId, aiEvaluation: "APPROVED", userStatus: { not: "DELETED" } },
          orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
          select: { ...savedMaterialSelect, feedbacks: { where: { userId }, select: { feedbackType: true }, take: 1 } },
        })
      : Promise.resolve([]),
    db.collectionMaterial.findMany({
      where: { collectionId, material: { userStatus: { not: "DELETED" } } },
      orderBy: { createdAt: "desc" },
      select: {
        material: { select: { ...savedMaterialSelect, feedbacks: { where: { userId }, select: { feedbackType: true }, take: 1 } } },
      },
    }),
  ])

  // Dedup by URL (same key the synthesis source list uses) so a single article
  // that arrived via BOTH the monitor and a normal feed shows once in the grid
  // and matches the answer's citations.
  const seen = new Set<string>()
  const out: Array<{ savedId: string; savedAt: Date; material: (typeof backing)[number] }> = []
  for (const m of [...backing, ...routed.map((r) => r.material)]) {
    if (seen.has(m.url)) continue
    seen.add(m.url)
    out.push({ savedId: `auto-${m.id}`, savedAt: m.createdAt, material: m })
  }
  return out
}

/** Saved excerpts in a collection, newest first, with their source material. */
export async function getSavedExcerptsForCollection(userId: string, collectionId: string) {
  return db.savedExcerpt.findMany({
    where: { userId, collectionId },
    orderBy: { createdAt: "desc" },
    include: {
      material: { select: { id: true, title: true, url: true, feed: { select: { id: true, name: true } } } },
    },
  })
}
