/**
 * Self-filling collections — the "tracked question" lifecycle (lib/saved/subscription.ts)
 *
 * Load-bearing behaviors locked here:
 *  - createTrackedQuestion: cap pre-check, the per-user advisory lock that
 *    serializes concurrent creates, Parallel-not-configured guard, and the
 *    paid-monitor rollback on any DB failure (so we never leak a monitor).
 *  - sweepDueCollections: a true trailing-edge debounce on material arrival —
 *    regenerate only once arrivals settle, then clear the dirty marker race-safely.
 *  - deleteTrackedCollection / reconcileOrphanMonitors: monitor cleanup that
 *    survives a failed Parallel delete without leaking a paid monitor OR a feed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => {
  const tx = {
    collection: { count: vi.fn(), create: vi.fn() },
    feed: { create: vi.fn() },
    $executeRaw: vi.fn(),
  }
  return {
    __tx: tx,
    db: {
      collection: { count: vi.fn(), findMany: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
      feed: { create: vi.fn(), delete: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      settings: { findFirst: vi.fn() },
      material: { count: vi.fn() },
      collectionMaterial: { count: vi.fn() },
      savedItem: { count: vi.fn() },
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    },
  }
})

vi.mock("@/lib/parsers/interest", () => ({
  createParallelMonitor: vi.fn(),
  deleteParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(() => "https://radaric.pro/api/webhooks/parallel"),
}))

vi.mock("@/lib/saved/synthesis", () => ({
  regenerateSynthesis: vi.fn(),
}))

// RAD-323: the sweep resolves owner access from the DB. Default to granted so the
// lifecycle tests below stay focused on their own behaviour.
vi.mock("@/lib/subscription", () => ({
  hasAccessForUserId: vi.fn(async () => true),
}))

import * as dbModule from "@/lib/db"
import { db } from "@/lib/db"
import { createParallelMonitor, deleteParallelMonitor } from "@/lib/parsers/interest"
import { regenerateSynthesis } from "@/lib/saved/synthesis"
import {
  createTrackedQuestion,
  deleteTrackedCollection,
  sweepDueCollections,
  reconcileOrphanMonitors,
  CapReachedError,
  ParallelNotConfiguredError,
  SELF_FILLING_CAP,
} from "@/lib/saved/subscription"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reaches into the mocked module's tx handle
const tx = (dbModule as any).__tx
const mockDb = db as unknown as {
  collection: {
    count: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    findFirst?: ReturnType<typeof vi.fn>
  }
  feed: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  settings: { findFirst: ReturnType<typeof vi.fn> }
  material: { count: ReturnType<typeof vi.fn> }
  collectionMaterial: { count: ReturnType<typeof vi.fn> }
  savedItem: { count: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}
const createMonitor = createParallelMonitor as ReturnType<typeof vi.fn>
const deleteMonitor = deleteParallelMonitor as ReturnType<typeof vi.fn>
const regenerate = regenerateSynthesis as ReturnType<typeof vi.fn>

const USER = "user-1"
const INPUT = { name: "EU AI Act", query: "Enforcement actions under the EU AI Act", cadence: "DAILY" as const }

beforeEach(() => {
  vi.clearAllMocks()
  // sensible defaults
  mockDb.settings.findFirst.mockResolvedValue({ parallelApiKey: "pk_live" })
  createMonitor.mockResolvedValue("mon-1")
  tx.collection.count.mockResolvedValue(0)
  tx.feed.create.mockResolvedValue({ id: "feed-1" })
  tx.collection.create.mockResolvedValue({ id: "col-1", name: INPUT.name })
  tx.$executeRaw.mockResolvedValue(1)
  // Freshness-floor material checks default to "no newer material" so the floor
  // never fires unless a test opts in.
  mockDb.material.count.mockResolvedValue(0)
  mockDb.collectionMaterial.count.mockResolvedValue(0)
  mockDb.savedItem.count.mockResolvedValue(0)
})

describe("createTrackedQuestion", () => {
  it("creates the monitor, backing feed, and collection on the happy path", async () => {
    mockDb.collection.count.mockResolvedValue(0)

    const result = await createTrackedQuestion(USER, "USER", INPUT)

    expect(result).toEqual({ id: "col-1", name: INPUT.name })
    expect(createMonitor).toHaveBeenCalledWith(
      { query: INPUT.query, cadence: "daily" },
      "https://radaric.pro/api/webhooks/parallel"
    )
    // The per-user advisory lock serializes concurrent creates.
    expect(tx.$executeRaw).toHaveBeenCalled()
    // Backing feed is hidden + EVENT_TRIGGER + carries the monitor id.
    expect(tx.feed.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hidden: true, type: "EVENT_TRIGGER", parallelMonitorId: "mon-1" }),
      })
    )
    expect(tx.collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ query: INPUT.query, monitorFeedId: "feed-1" }),
      })
    )
    expect(deleteMonitor).not.toHaveBeenCalled()
  })

  it("throws CapReachedError BEFORE paying for a monitor when at the cap", async () => {
    mockDb.collection.count.mockResolvedValue(SELF_FILLING_CAP)

    await expect(createTrackedQuestion(USER, "USER", INPUT)).rejects.toBeInstanceOf(CapReachedError)
    expect(createMonitor).not.toHaveBeenCalled()
  })

  it("lets an ADMIN past the cap pre-check and skips the lock", async () => {
    mockDb.collection.count.mockResolvedValue(SELF_FILLING_CAP + 5)

    await createTrackedQuestion(USER, "ADMIN", INPUT)

    expect(mockDb.collection.count).not.toHaveBeenCalled() // admin skips the pre-check
    expect(tx.$executeRaw).not.toHaveBeenCalled() // and the transactional lock
    expect(createMonitor).toHaveBeenCalled()
  })

  it("throws ParallelNotConfiguredError when no API key is set", async () => {
    mockDb.collection.count.mockResolvedValue(0)
    mockDb.settings.findFirst.mockResolvedValue({ parallelApiKey: null })

    await expect(createTrackedQuestion(USER, "USER", INPUT)).rejects.toBeInstanceOf(ParallelNotConfiguredError)
    expect(createMonitor).not.toHaveBeenCalled()
  })

  it("rolls the paid monitor back when the DB transaction fails", async () => {
    mockDb.collection.count.mockResolvedValue(0)
    const dbErr = new Error("duplicate name")
    mockDb.$transaction.mockRejectedValueOnce(dbErr)

    await expect(createTrackedQuestion(USER, "USER", INPUT)).rejects.toBe(dbErr)
    expect(deleteMonitor).toHaveBeenCalledWith("mon-1")
  })
})

describe("sweepDueCollections (trailing-edge debounce)", () => {
  const T = 1_000_000_000_000

  it("regenerates only collections whose new material has settled past the debounce window", async () => {
    mockDb.collection.findMany.mockResolvedValue([
      // A: last arrival 10 min ago (> 5 min debounce) → settled → DUE
      { id: "A", userId: USER, autoSynthAt: new Date(T - 600_000) },
      // B: arrival 30s ago (< debounce) → still settling → SKIP
      { id: "B", userId: USER, autoSynthAt: new Date(T - 30_000) },
    ])
    regenerate.mockResolvedValue({ status: "ok" })
    mockDb.collection.updateMany.mockResolvedValue({ count: 1 })

    const res = await sweepDueCollections(T)

    expect(regenerate).toHaveBeenCalledTimes(1)
    expect(regenerate).toHaveBeenCalledWith(USER, "A")
    expect(res).toEqual({ regenerated: 1, considered: 2 })
  })

  it("clears the dirty marker guarded on the value it read (no newer arrival lost)", async () => {
    const arrival = new Date(T - 600_000)
    mockDb.collection.findMany.mockResolvedValue([{ id: "A", userId: USER, autoSynthAt: arrival }])
    regenerate.mockResolvedValue({ status: "ok" })
    mockDb.collection.updateMany.mockResolvedValue({ count: 1 })

    await sweepDueCollections(T)

    expect(mockDb.collection.updateMany).toHaveBeenCalledWith({
      where: { id: "A", autoSynthAt: arrival },
      data: { autoSynthAt: null },
    })
  })

  it("does not clear the marker when regenerate is not ok", async () => {
    mockDb.collection.findMany.mockResolvedValue([{ id: "A", userId: USER, autoSynthAt: new Date(T - 600_000) }])
    regenerate.mockResolvedValue({ status: "cooldown" })

    const res = await sweepDueCollections(T)
    expect(res.regenerated).toBe(0)
    expect(mockDb.collection.updateMany).not.toHaveBeenCalled()
  })

  it("keeps going if one regenerate throws", async () => {
    mockDb.collection.findMany.mockResolvedValue([
      { id: "A", userId: USER, autoSynthAt: new Date(T - 600_000) },
      { id: "B", userId: USER, autoSynthAt: new Date(T - 600_000) },
    ])
    regenerate.mockRejectedValueOnce(new Error("LLM down")).mockResolvedValueOnce({ status: "ok" })
    mockDb.collection.updateMany.mockResolvedValue({ count: 1 })

    const res = await sweepDueCollections(T)
    expect(res.regenerated).toBe(1)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })
})

describe("sweepDueCollections (cadence freshness floor)", () => {
  const T = 1_700_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  function floorRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: "F",
      userId: USER,
      autoSynthAt: null,
      synthesisUpdatedAt: new Date(T - 2 * DAY), // 2 days old, cadence-stale for DAILY
      cadence: "DAILY",
      monitorFeedId: "feed-F",
      ...over,
    }
  }

  it("regenerates a cadence-stale answer when newer material exists (missed autoSynthAt-arm)", async () => {
    mockDb.collection.findMany.mockResolvedValue([floorRow()])
    mockDb.material.count.mockResolvedValue(2) // backing feed brought in new material the arm missed
    regenerate.mockResolvedValue({ status: "ok" })

    const res = await sweepDueCollections(T)

    expect(regenerate).toHaveBeenCalledWith(USER, "F")
    expect(res.regenerated).toBe(1)
  })

  it("does NOT regenerate a cadence-stale answer when there's no newer material", async () => {
    mockDb.collection.findMany.mockResolvedValue([floorRow()])
    // all material counts default to 0 → no new material
    const res = await sweepDueCollections(T)
    expect(regenerate).not.toHaveBeenCalled()
    expect(res.regenerated).toBe(0)
  })

  it("respects the cadence window — a recently-synthesized answer isn't refloored even with new material", async () => {
    mockDb.collection.findMany.mockResolvedValue([floorRow({ synthesisUpdatedAt: new Date(T - 1000) })]) // 1s ago
    mockDb.material.count.mockResolvedValue(5)
    const res = await sweepDueCollections(T)
    expect(regenerate).not.toHaveBeenCalled()
    expect(res.regenerated).toBe(0)
  })

  it("first-synthesizes a never-generated question once it has material", async () => {
    mockDb.collection.findMany.mockResolvedValue([floorRow({ synthesisUpdatedAt: null })])
    mockDb.collectionMaterial.count.mockResolvedValue(1) // routed material exists
    regenerate.mockResolvedValue({ status: "ok" })

    const res = await sweepDueCollections(T)
    expect(regenerate).toHaveBeenCalledWith(USER, "F")
    expect(res.regenerated).toBe(1)
  })

  it("does NOT pre-empt a pending arm — the floor skips a collection that's armed but not yet debounced", async () => {
    // autoSynthAt set 1 min ago (within the 5-min debounce) AND cadence-stale with new material.
    mockDb.collection.findMany.mockResolvedValue([
      floorRow({ autoSynthAt: new Date(T - 60_000) }),
    ])
    mockDb.material.count.mockResolvedValue(3)

    const res = await sweepDueCollections(T)
    // Not armed (debounce not elapsed) and floor skips it (autoSynthAt set) → waits for the debounce.
    expect(regenerate).not.toHaveBeenCalled()
    expect(res.regenerated).toBe(0)
  })

  it("can be run without the floor (includeFloor:false) — only the armed path fires", async () => {
    mockDb.collection.findMany.mockResolvedValue([floorRow()]) // cadence-stale, would floor
    mockDb.material.count.mockResolvedValue(3)
    const res = await sweepDueCollections(T, { includeFloor: false })
    expect(regenerate).not.toHaveBeenCalled()
    expect(res.regenerated).toBe(0)
  })
})

describe("deleteTrackedCollection", () => {
  function mockFindFirst(value: unknown) {
    mockDb.collection.findFirst = vi.fn().mockResolvedValue(value)
  }

  it("tears down monitor → feed → collection in order", async () => {
    mockFindFirst({
      id: "col-1",
      monitorFeedId: "feed-1",
      monitorFeed: { id: "feed-1", parallelMonitorId: "mon-1" },
    })

    const order: string[] = []
    deleteMonitor.mockImplementation(async () => void order.push("monitor"))
    mockDb.feed.delete.mockImplementation(async () => void order.push("feed"))
    mockDb.collection.delete.mockImplementation(async () => void order.push("collection"))

    const ok = await deleteTrackedCollection(USER, "col-1")

    expect(ok).toBe(true)
    expect(order).toEqual(["monitor", "feed", "collection"])
  })

  it("returns false when the collection is not found / not owned", async () => {
    mockFindFirst(null)

    const ok = await deleteTrackedCollection(USER, "missing")
    expect(ok).toBe(false)
    expect(deleteMonitor).not.toHaveBeenCalled()
  })

  it("keeps the backing feed flagged (NOT deleted) when the monitor delete fails", async () => {
    mockFindFirst({
      id: "col-1",
      monitorFeedId: "feed-1",
      monitorFeed: { id: "feed-1", parallelMonitorId: "mon-1" },
    })
    deleteMonitor.mockRejectedValueOnce(new Error("parallel 500"))
    mockDb.feed.update.mockResolvedValue({})

    const ok = await deleteTrackedCollection(USER, "col-1")

    expect(ok).toBe(true)
    // The orphaned monitorId must survive on the feed for reconcile to retry it.
    expect(mockDb.feed.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "feed-1" }, data: { monitorDeletePending: true } })
    )
    expect(mockDb.feed.delete).not.toHaveBeenCalled()
    expect(mockDb.collection.delete).toHaveBeenCalled()
  })
})

describe("reconcileOrphanMonitors", () => {
  it("deletes the orphaned feed once its monitor is finally removed; leaves failures flagged", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      { id: "f1", parallelMonitorId: "m1", backedCollection: null }, // leftover from a deleted collection
      { id: "f2", parallelMonitorId: "m2", backedCollection: null },
    ])
    deleteMonitor.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("still down"))
    mockDb.feed.delete.mockResolvedValue({})

    const res = await reconcileOrphanMonitors()

    expect(res).toEqual({ reconciled: 1 })
    expect(mockDb.feed.delete).toHaveBeenCalledWith({ where: { id: "f1" } })
    expect(mockDb.feed.delete).toHaveBeenCalledTimes(1) // f2 stays flagged
  })

  it("only clears the flag (keeps the feed) when a live collection still backs it", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      { id: "f1", parallelMonitorId: "m1", backedCollection: { id: "col-1" } },
    ])
    deleteMonitor.mockResolvedValue(undefined)
    mockDb.feed.update.mockResolvedValue({})

    const res = await reconcileOrphanMonitors()

    expect(res).toEqual({ reconciled: 1 })
    expect(mockDb.feed.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "f1" }, data: { monitorDeletePending: false } })
    )
    expect(mockDb.feed.delete).not.toHaveBeenCalled()
  })
})
