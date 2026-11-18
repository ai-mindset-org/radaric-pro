/**
 * Smart-default collection resolution (lib/saved/collections.ts)
 *
 * The load-bearing behavior of Phase 0: a save into a NAMED collection is the
 * clean signal; a bare save lands in a smart default (most-recent → Unsorted),
 * never a void. These tests lock that resolution order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    collection: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
    savedItem: {
      findFirst: vi.fn(),
    },
  },
}))

import { db } from "@/lib/db"
import {
  resolveTargetCollectionId,
  resolveDefaultCollectionId,
} from "@/lib/saved/collections"

const mockDb = db as unknown as {
  collection: { upsert: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  savedItem: { findFirst: ReturnType<typeof vi.fn> }
}

const USER = "user-1"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveTargetCollectionId", () => {
  it("get-or-creates the named collection when collectionName is given", async () => {
    mockDb.collection.upsert.mockResolvedValue({ id: "col-new" })

    const id = await resolveTargetCollectionId(USER, { collectionName: "EU AI regulation" })

    expect(id).toBe("col-new")
    expect(mockDb.collection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_name: { userId: USER, name: "EU AI regulation" } },
        create: { userId: USER, name: "EU AI regulation" },
      })
    )
    // A named save must NOT consult the smart default.
    expect(mockDb.savedItem.findFirst).not.toHaveBeenCalled()
  })

  it("uses an explicit collectionId only when the user owns it", async () => {
    mockDb.collection.findFirst.mockResolvedValue({ id: "col-owned" })
    const id = await resolveTargetCollectionId(USER, { collectionId: "col-owned" })
    expect(id).toBe("col-owned")
    expect(mockDb.collection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "col-owned", userId: USER } })
    )
  })

  it("returns null for a collectionId the user does not own (forbidden)", async () => {
    mockDb.collection.findFirst.mockResolvedValue(null)
    const id = await resolveTargetCollectionId(USER, { collectionId: "col-someone-else" })
    expect(id).toBeNull()
  })

  it("falls back to the most-recent collection when neither is given (session-sticky)", async () => {
    mockDb.savedItem.findFirst.mockResolvedValue({ collectionId: "col-recent" })
    const id = await resolveTargetCollectionId(USER, {})
    expect(id).toBe("col-recent")
    // Did NOT need to create Unsorted because a recent save existed.
    expect(mockDb.collection.upsert).not.toHaveBeenCalled()
  })

  it("falls back to a get-or-created Unsorted when there is no prior save", async () => {
    mockDb.savedItem.findFirst.mockResolvedValue(null)
    mockDb.collection.upsert.mockResolvedValue({ id: "col-unsorted" })
    const id = await resolveTargetCollectionId(USER, {})
    expect(id).toBe("col-unsorted")
    expect(mockDb.collection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_name: { userId: USER, name: "Unsorted" } },
        create: { userId: USER, name: "Unsorted", isSystem: true },
      })
    )
  })
})

describe("resolveDefaultCollectionId", () => {
  it("prefers the most-recent save's collection", async () => {
    mockDb.savedItem.findFirst.mockResolvedValue({ collectionId: "col-recent" })
    expect(await resolveDefaultCollectionId(USER)).toBe("col-recent")
  })

  it("creates Unsorted on a first-ever save", async () => {
    mockDb.savedItem.findFirst.mockResolvedValue(null)
    mockDb.collection.upsert.mockResolvedValue({ id: "col-unsorted" })
    expect(await resolveDefaultCollectionId(USER)).toBe("col-unsorted")
  })
})
