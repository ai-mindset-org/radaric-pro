import { db } from "@/lib/db"
import type { KnownItems } from "@/lib/parsers/rss"

/**
 * The `knownItems` callback for `parseRSSFeed`: which candidates this source
 * already stores, by url or externalId, so their article pages are not
 * fetched again on every parse. (RAD-395)
 */
export function knownMaterialKeys(sourceId: string): KnownItems {
  return async (candidates) => {
    const rows = await db.material.findMany({
      where: {
        sourceId,
        OR: [
          { url: { in: candidates.map((c) => c.url) } },
          { externalId: { in: candidates.map((c) => c.externalId) } },
        ],
      },
      select: { url: true, externalId: true },
    })
    const known = new Set<string>()
    for (const row of rows) {
      if (row.url) known.add(row.url)
      if (row.externalId) known.add(row.externalId)
    }
    return known
  }
}
