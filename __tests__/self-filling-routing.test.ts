/**
 * Self-filling Slice 2 — routing existing-feed materials into tracked questions
 * (lib/saved/routing.ts).
 *
 * Load-bearing behaviors:
 *  - only candidates that pass the cheap whole-word keyword pre-filter reach the
 *    (paid) AI eval;
 *  - matched materials are linked + arm the synthesis debounce; rejects don't;
 *  - EVERY considered material gets its routedAt watermark set (so it's never
 *    re-evaluated; overflow stays null for the next run);
 *  - the per-user/24h cap defers a user without touching their materials.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    collection: { findMany: vi.fn(), update: vi.fn() },
    collectionMaterial: { count: vi.fn(), createMany: vi.fn() },
    material: { findMany: vi.fn(), updateMany: vi.fn() },
    savedItem: { findMany: vi.fn() },
  },
}))

vi.mock("@/lib/ai", () => ({
  evaluateMaterialsBatch: vi.fn(),
}))

// RAD-323: routing resolves owner access before any paid eval; default granted
// so the existing routing tests keep exercising the happy path.
vi.mock("@/lib/subscription", () => ({
  hasAccessForUserId: vi.fn(async () => true),
}))

import { db } from "@/lib/db"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { hasAccessForUserId } from "@/lib/subscription"
import { routeRecentMaterials, ROUTING_USER_DAILY_CAP } from "@/lib/saved/routing"

const mockDb = db as unknown as {
  collection: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  collectionMaterial: { count: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> }
  material: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
  savedItem: { findMany: ReturnType<typeof vi.fn> }
}
const evalBatch = evaluateMaterialsBatch as ReturnType<typeof vi.fn>
const accessCheck = hasAccessForUserId as ReturnType<typeof vi.fn>

const USER = "user-1"
const QUERY = "Enforcement actions and fines under the EU AI Act"

function material(id: string, title: string, content = "") {
  return { id, title, content, url: `https://x/${id}`, sourceId: "feed-rss" }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.collectionMaterial.count.mockResolvedValue(0)
  // createMany reports the number of rows actually inserted (no dupes in tests).
  mockDb.collectionMaterial.createMany.mockImplementation(async (arg: { data: unknown[] }) => ({ count: arg.data.length }))
  mockDb.collection.update.mockResolvedValue({})
  mockDb.material.updateMany.mockResolvedValue({ count: 0 })
  mockDb.savedItem.findMany.mockResolvedValue([])
})

it("no-ops when there are no tracked questions", async () => {
  mockDb.collection.findMany.mockResolvedValue([])
  const res = await routeRecentMaterials()
  expect(res).toEqual({ considered: 0, routed: 0, evaluated: 0, cappedUsers: 0 })
  expect(mockDb.material.findMany).not.toHaveBeenCalled()
})

it("skips a user whose access has lapsed — no material scan, no paid eval (RAD-323)", async () => {
  mockDb.collection.findMany.mockResolvedValue([{ id: "col-1", userId: USER, query: QUERY }])
  accessCheck.mockResolvedValueOnce(false)

  const res = await routeRecentMaterials()

  expect(res).toEqual({ considered: 0, routed: 0, evaluated: 0, cappedUsers: 0 })
  expect(mockDb.material.findMany).not.toHaveBeenCalled()
  expect(evalBatch).not.toHaveBeenCalled()
})

describe("keyword pre-filter + eval → link", () => {
  beforeEach(() => {
    mockDb.collection.findMany.mockResolvedValue([{ id: "col-1", userId: USER, query: QUERY }])
  })

  it("only sends keyword-matching candidates to the AI eval, then links the relevant ones", async () => {
    mockDb.material.findMany.mockResolvedValue([
      material("m1", "EU AI Act enforcement ramps up", "regulators issued new fines"), // matches
      material("m2", "A new pasta recipe for autumn", "cooking and food"), // no keyword overlap
    ])
    evalBatch.mockResolvedValue([{ relevant: true, confidence: 90, reasoning: "" }])

    const res = await routeRecentMaterials(1_000)

    // Only m1 passed the keyword gate → batch of exactly one candidate.
    expect(evalBatch).toHaveBeenCalledTimes(1)
    const arg = evalBatch.mock.calls[0][0]
    expect(arg.criteria).toBe(QUERY)
    expect(arg.materials).toHaveLength(1)
    expect(arg.materials[0].title).toContain("EU AI Act enforcement")

    // Relevant match → link + arm the debounce.
    expect(mockDb.collectionMaterial.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ collectionId: "col-1", materialId: "m1" }], skipDuplicates: true })
    )
    expect(mockDb.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "col-1" }, data: { autoSynthAt: expect.any(Date) } })
    )
    expect(res.routed).toBe(1)
    expect(res.evaluated).toBe(1)
    expect(res.considered).toBe(2)
  })

  it("links nothing when the AI rejects the keyword candidate", async () => {
    mockDb.material.findMany.mockResolvedValue([material("m1", "EU AI Act enforcement", "fines")])
    evalBatch.mockResolvedValue([{ relevant: false, confidence: 80, reasoning: "" }])

    const res = await routeRecentMaterials()
    expect(res.routed).toBe(0)
    expect(mockDb.collectionMaterial.createMany).not.toHaveBeenCalled()
    expect(mockDb.collection.update).not.toHaveBeenCalled()
  })

  it("skips the AI eval entirely when no material shares a query keyword", async () => {
    mockDb.material.findMany.mockResolvedValue([material("m2", "Pasta recipe", "food cooking")])
    const res = await routeRecentMaterials()
    expect(evalBatch).not.toHaveBeenCalled()
    expect(res.routed).toBe(0)
  })

  it("marks EVERY considered material routedAt (matched or not) — the watermark", async () => {
    mockDb.material.findMany.mockResolvedValue([
      material("m1", "EU AI Act enforcement", "fines"),
      material("m2", "Pasta recipe", "food"),
    ])
    evalBatch.mockResolvedValue([{ relevant: true, confidence: 90, reasoning: "" }])

    await routeRecentMaterials()

    expect(mockDb.material.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["m1", "m2"] } },
        data: { routedAt: expect.any(Date) },
      })
    )
  })
})

describe("per-user/24h cap", () => {
  it("defers a user at the cap without fetching or marking their materials", async () => {
    mockDb.collection.findMany.mockResolvedValue([{ id: "col-1", userId: USER, query: QUERY }])
    mockDb.collectionMaterial.count.mockResolvedValue(ROUTING_USER_DAILY_CAP)

    const res = await routeRecentMaterials()

    expect(res.cappedUsers).toBe(1)
    expect(mockDb.material.findMany).not.toHaveBeenCalled()
    expect(mockDb.material.updateMany).not.toHaveBeenCalled()
  })
})

describe("failure handling", () => {
  beforeEach(() => {
    mockDb.collection.findMany.mockResolvedValue([{ id: "col-1", userId: USER, query: QUERY }])
    mockDb.material.findMany.mockResolvedValue([material("m1", "EU AI Act enforcement", "fines")])
  })

  it("does NOT advance the watermark when an eval throws — the batch retries next run", async () => {
    evalBatch.mockRejectedValue(new Error("AI 529 overloaded"))

    const res = await routeRecentMaterials()

    expect(res.routed).toBe(0)
    // Critical: routedAt must NOT be stamped, or m1 is never re-evaluated.
    expect(mockDb.material.updateMany).not.toHaveBeenCalled()
  })

  it("advances the watermark on a clean run (no failure)", async () => {
    evalBatch.mockResolvedValue([{ relevant: false, confidence: 10, reasoning: "" }])
    await routeRecentMaterials()
    expect(mockDb.material.updateMany).toHaveBeenCalled()
  })
})

describe("manual-save exclusion", () => {
  it("does not auto-route a material the user already saved into that collection", async () => {
    mockDb.collection.findMany.mockResolvedValue([{ id: "col-1", userId: USER, query: QUERY }])
    mockDb.material.findMany.mockResolvedValue([material("m1", "EU AI Act enforcement", "fines")])
    // m1 is already a manual save in col-1.
    mockDb.savedItem.findMany.mockResolvedValue([{ collectionId: "col-1", materialId: "m1" }])

    const res = await routeRecentMaterials()

    expect(evalBatch).not.toHaveBeenCalled() // excluded before the eval
    expect(res.routed).toBe(0)
    expect(mockDb.collectionMaterial.createMany).not.toHaveBeenCalled()
  })
})

describe("multiple tracked questions per user", () => {
  it("routes one material into every question it matches", async () => {
    mockDb.collection.findMany.mockResolvedValue([
      { id: "col-ai", userId: USER, query: "EU AI Act enforcement fines" },
      { id: "col-energy", userId: USER, query: "solar energy battery storage" },
    ])
    mockDb.material.findMany.mockResolvedValue([
      material("m1", "EU AI Act enforcement and fines", "regulators"),
    ])
    evalBatch.mockResolvedValue([{ relevant: true, confidence: 90, reasoning: "" }])

    const res = await routeRecentMaterials()

    // m1 only shares keywords with col-ai → one eval, one link.
    expect(evalBatch).toHaveBeenCalledTimes(1)
    expect(mockDb.collectionMaterial.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ collectionId: "col-ai", materialId: "m1" }] })
    )
    expect(res.routed).toBe(1)
  })
})
