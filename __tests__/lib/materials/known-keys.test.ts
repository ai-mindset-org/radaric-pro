/**
 * RAD-395 — `knownMaterialKeys(sourceId)` builds the `knownItems` callback the
 * routes hand to `parseRSSFeed`, so stored items skip their article-page fetch.
 *
 * The returned function queries `db.material.findMany` for THIS source,
 * restricted to the candidates' urls/externalIds, and resolves to every stored
 * url and externalId (null/empty ignored). `@/lib/db` is mocked; the mock does
 * not apply the `where`, so the query shape is asserted separately from the
 * returned set.
 *
 * RED: `lib/materials/known-keys.ts` does not exist yet — the suite fails at import.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    material: {
      findMany: vi.fn(),
    },
  },
}))

import { db } from "@/lib/db"
import { knownMaterialKeys } from "@/lib/materials/known-keys"

const CANDIDATES = [
  { url: "https://www.behance.net/gallery/1/a", externalId: "https://www.behance.net/gallery/1/a" },
  { url: "https://news.example.test/b", externalId: "guid-b" },
  { url: "https://news.example.test/c", externalId: "guid-c" },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe("knownMaterialKeys", () => {
  it("AC-4: resolves to every stored url and externalId, ignoring null and empty values", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([
      { url: "https://www.behance.net/gallery/1/a", externalId: null },
      { url: "", externalId: "guid-b" },
      { url: "https://news.example.test/legacy", externalId: "" },
    ] as never)

    const known = await knownMaterialKeys("src-1")(CANDIDATES)

    expect(known).toBeInstanceOf(Set)
    expect([...known].sort()).toEqual(
      ["https://news.example.test/legacy", "https://www.behance.net/gallery/1/a", "guid-b"].sort()
    )
  })

  it("AC-4: queries findMany once, scoped to the source and to the candidates' urls and externalIds", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)

    const known = await knownMaterialKeys("src-42")(CANDIDATES)

    expect(known.size).toBe(0)
    expect(db.material.findMany).toHaveBeenCalledTimes(1)
    const args = vi.mocked(db.material.findMany).mock.calls[0][0] as { where: Record<string, unknown> }
    expect(args.where.sourceId).toBe("src-42")
    const where = JSON.stringify(args.where)
    for (const c of CANDIDATES) {
      expect(where).toContain(JSON.stringify(c.url))
      expect(where).toContain(JSON.stringify(c.externalId))
    }
    // Restricted to the candidates: a key not among them is not queried.
    expect(where).not.toContain("legacy")
  })
})
