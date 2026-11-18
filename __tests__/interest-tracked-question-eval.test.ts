// @vitest-environment node

/**
 * RAD-397 — a tracked question's monitor feed must be evaluated against THE
 * QUESTION, not the user's global curation prompt.
 *
 * `processParallelEvent` / `parseInterestSource` called `evaluateMaterialsBatch`
 * without `criteria`, so the backing feed's events fell through to the global
 * digest prompt (every research event FILTERED with "Global criteria: REJECT" —
 * the question's own sources were judged by an unrelated design prompt, so its
 * living answer could never grow).
 *
 * The routing path (Slice 2) already evaluates in a clean query-only context;
 * these tests pin the same contract for the monitor path, plus the fallback:
 * a user-created monitor feed (no backing collection) keeps its feed/global
 * evaluation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn() },
    feed: { findUnique: vi.fn(), update: vi.fn() },
    collection: { findUnique: vi.fn(), updateMany: vi.fn() },
    material: { findMany: vi.fn(), createMany: vi.fn() },
  },
}))

vi.mock("@/lib/ai", () => ({
  evaluateMaterialsBatch: vi.fn(),
}))

import { db } from "@/lib/db"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { parseInterestSource, processParallelEvent } from "@/lib/parsers/interest"

const mockDb = db as unknown as {
  settings: { findFirst: ReturnType<typeof vi.fn> }
  feed: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  collection: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
  material: { findMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> }
}
const evalBatch = evaluateMaterialsBatch as ReturnType<typeof vi.fn>

const USER = "user-1"
const QUERY = "What key research has Anthropic published on its website?"

const EVENT = {
  type: "event",
  event_group_id: "mevtgrp_test_group",
  output: "Anthropic published a new alignment study. Findings follow.",
  event_date: "2026-10-01",
  source_urls: ["https://www.anthropic.com/research/alignment"],
}

function stubFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/event_groups/") || String(url).includes("/events?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: [EVENT] }),
        } as unknown as Response
      }
      // OG-image fetch — no image.
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.settings.findFirst.mockResolvedValue({ parallelApiKey: "test-key" })
  mockDb.feed.findUnique.mockResolvedValue({
    id: "feed-1",
    name: "Tracked question feed",
    parallelMonitorId: "monitor_1",
    hidden: true,
  })
  mockDb.feed.update.mockResolvedValue({})
  mockDb.collection.updateMany.mockResolvedValue({ count: 1 })
  mockDb.material.findMany.mockResolvedValue([])
  mockDb.material.createMany.mockResolvedValue({ count: 1 })
  evalBatch.mockImplementation(async ({ materials }: { materials: unknown[] }) =>
    materials.map(() => ({ relevant: true, confidence: 90, reasoning: "Matches the question" }))
  )
  stubFetchOk()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseInterestSource — tracked-question criteria (RAD-397)", () => {
  it("passes the backing collection's query as the eval criteria", async () => {
    mockDb.collection.findUnique.mockResolvedValue({ query: QUERY })

    await parseInterestSource("feed-1", USER)

    expect(mockDb.collection.findUnique).toHaveBeenCalledWith({
      where: { monitorFeedId: "feed-1" },
      select: { query: true },
    })
    expect(evalBatch).toHaveBeenCalledTimes(1)
    expect(evalBatch.mock.calls[0][0]).toMatchObject({ sourceId: "feed-1", criteria: QUERY })
  })

  it("omits criteria for a user-created monitor feed with no backing collection", async () => {
    mockDb.collection.findUnique.mockResolvedValue(null)

    await parseInterestSource("feed-1", USER)

    expect(evalBatch).toHaveBeenCalledTimes(1)
    expect(evalBatch.mock.calls[0][0].criteria).toBeUndefined()
  })
})

describe("processParallelEvent — tracked-question criteria (RAD-397)", () => {
  it("passes the backing collection's query as the eval criteria", async () => {
    mockDb.collection.findUnique.mockResolvedValue({ query: QUERY })

    await processParallelEvent("feed-1", "mevtgrp_test_group", USER)

    expect(evalBatch).toHaveBeenCalledTimes(1)
    expect(evalBatch.mock.calls[0][0]).toMatchObject({ sourceId: "feed-1", criteria: QUERY })
  })

  it("omits criteria for a user-created monitor feed with no backing collection", async () => {
    mockDb.collection.findUnique.mockResolvedValue(null)

    await processParallelEvent("feed-1", "mevtgrp_test_group", USER)

    expect(evalBatch).toHaveBeenCalledTimes(1)
    expect(evalBatch.mock.calls[0][0].criteria).toBeUndefined()
  })
})
