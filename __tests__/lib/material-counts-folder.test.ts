/**
 * RAD-393 — countMaterialsForScope folder scope.
 *
 * Folder scope covers the same visible, active member set as /api/posts and
 * the sidebar; the source-type breakdown is computed for it (a folder is a
 * multi-source scope), unlike the single-source page.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma where-builder mocks */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    material: { count: vi.fn() },
  },
}))

import { db } from "@/lib/db"
import { countMaterialsForScope } from "@/lib/materials/material-counts"

const USER_ID = "user-rad-393"
const FOLDER_ID = "folder-1"

beforeEach(() => {
  vi.clearAllMocks()
  // 5 filter counts, then 5 type counts.
  vi.mocked(db.material.count).mockResolvedValue(1 as never)
})

describe("countMaterialsForScope — folder", () => {
  it("scopes every count to the folder's visible, active members", async () => {
    await countMaterialsForScope({ userId: USER_ID, folderId: FOLDER_ID })

    const calls = vi.mocked(db.material.count).mock.calls
    expect(calls).toHaveLength(10)
    for (const [args] of calls) {
      expect((args as any).where.feed).toEqual(
        expect.objectContaining({
          userId: USER_ID,
          folderId: FOLDER_ID,
          hidden: false,
          isActive: true,
        })
      )
    }
  })

  it("computes the source-type breakdown for the folder scope", async () => {
    const counts = await countMaterialsForScope({ userId: USER_ID, folderId: FOLDER_ID })

    expect(counts.sourceType).toBeDefined()
    const typeCall = vi.mocked(db.material.count).mock.calls.find(
      ([args]) => (args as any).where.feed?.type === "RSS"
    )
    expect(typeCall).toBeDefined()
    expect((typeCall![0] as any).where.feed.folderId).toBe(FOLDER_ID)
  })

  it("omits the type breakdown for a single source, as before", async () => {
    const counts = await countMaterialsForScope({ userId: USER_ID, sourceId: "feed-1" })

    expect(counts.sourceType).toBeUndefined()
    expect(vi.mocked(db.material.count)).toHaveBeenCalledTimes(5)
  })

  it("intersects source and folder scopes when both are given", async () => {
    await countMaterialsForScope({ userId: USER_ID, sourceId: "feed-1", folderId: FOLDER_ID })

    const firstWhere = (vi.mocked(db.material.count).mock.calls[0][0] as any).where
    expect(firstWhere.feed).toEqual({
      userId: USER_ID,
      id: "feed-1",
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
  })
})
