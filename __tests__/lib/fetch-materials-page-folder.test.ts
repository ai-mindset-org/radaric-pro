/**
 * RAD-393 — fetchMaterialsPage folder mode.
 *
 * Ownership is checked against `folder.findFirst({ id, userId })` (a foreign
 * folder must throw like a missing one, never render another account's rows),
 * the material scope is the folder's visible, active members, and the result
 * carries both filter and source-type counts (the folder page keeps the type
 * filter visible).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma where-builder mocks */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    folder: { findFirst: vi.fn() },
    material: { findMany: vi.fn(), count: vi.fn() },
  },
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}))

import { db } from "@/lib/db"
import {
  fetchMaterialsPage,
  FolderNotFoundOrForbiddenError,
} from "@/lib/materials/fetch-materials-page"

const USER_ID = "user-rad-393"
const FOLDER_ID = "folder-1"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(db.material.count).mockResolvedValue(0 as never)
})

describe("fetchMaterialsPage — folder mode", () => {
  it("throws FolderNotFoundOrForbiddenError for a foreign folder and reads nothing", async () => {
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)

    await expect(fetchMaterialsPage({ userId: USER_ID, folderId: FOLDER_ID })).rejects.toBeInstanceOf(
      FolderNotFoundOrForbiddenError
    )

    expect(db.folder.findFirst).toHaveBeenCalledWith({
      where: { id: FOLDER_ID, userId: USER_ID },
      select: { id: true },
    })
    expect(db.material.findMany).not.toHaveBeenCalled()
  })

  it("scopes materials to the folder's visible, active members", async () => {
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: FOLDER_ID } as never)

    await fetchMaterialsPage({ userId: USER_ID, folderId: FOLDER_ID })

    const where = vi.mocked(db.material.findMany).mock.calls[0][0]?.where as any
    expect(where.feed).toEqual({
      userId: USER_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
  })

  it("returns filter and source-type counts (the account-wide shape)", async () => {
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: FOLDER_ID } as never)
    vi.mocked(db.material.count).mockResolvedValue(3 as never)

    const result = await fetchMaterialsPage({ userId: USER_ID, folderId: FOLDER_ID })

    expect(result.serverCounts.filter).toBeDefined()
    expect((result.serverCounts as { sourceType?: unknown }).sourceType).toBeDefined()
  })
})
