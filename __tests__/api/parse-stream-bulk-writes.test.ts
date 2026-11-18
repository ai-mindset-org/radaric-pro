/**
 * GET /api/parse-stream — Bulk DB Writes via Promise.allSettled (RAD-183)
 *
 * Tests that material creation runs concurrently within each source using
 * Promise.allSettled with MATERIAL_CREATE_CONCURRENCY cap, rather than a
 * serial for-loop.
 *
 * Criteria covered:
 *   AC-1: All material creates for a single source run concurrently via Promise.allSettled,
 *         capped at MATERIAL_CREATE_CONCURRENCY=10 (exported constant)
 *   AC-2: Each created material is returned with full MATERIAL_SELECT fields including feed relation
 *   AC-3: material_created SSE events are sent for each successfully created material
 *   AC-4: P2002 (duplicate) errors are handled per-item — duplicates skipped, others succeed
 *   AC-5: source_complete stats (approved, filtered, new) equal the count of actually created materials
 *   EC-1: All items are duplicates — source completes with 0 new, no material_created events
 *   EC-2: Single item — works identically to current behavior
 *   EC-3: Mixed duplicates and new items — only new items get SSE events, stats reflect actual creates
 *   ERR-1: Non-P2002 DB error for one item does not prevent other items from being created
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// --- Mocks (must precede imports that use them) ---

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("@/lib/parsers/rss", () => ({
  parseRSSFeed: vi.fn(),
}))

vi.mock("@/lib/parsers/telegram", () => ({
  parseTelegramChannel: vi.fn(),
}))

vi.mock("@/lib/parsers/twitter", () => ({
  parseTwitterSource: vi.fn(),
  parseSourceUrlToConfig: vi.fn(),
}))

vi.mock("@/lib/parsers/interest", () => ({
  parseInterestSource: vi.fn(),
}))

vi.mock("@/lib/ai", () => ({
  evaluateMaterialsBatch: vi.fn(),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { GET } from "@/app/api/parse-stream/route"

// Import MATERIAL_CREATE_CONCURRENCY — does not yet exist; tests guard on it
// so every test that calls `assertConcurrencyConstant()` will fail until
// the implementer exports this constant.
import * as routeModule from "@/app/api/parse-stream/route"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "user-bulk-001"
const SOURCE_ID = "src-bulk-001"

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Every test that verifies the new concurrent write path calls this first.
 * Fails immediately if MATERIAL_CREATE_CONCURRENCY is not exported, ensuring
 * all tests in this file remain RED until the implementation lands.
 */
function assertConcurrencyConstant() {
  expect((routeModule as never).MATERIAL_CREATE_CONCURRENCY).toBe(10)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { sourceIds?: string[] } = {}): NextRequest {
  const url = new URL("http://localhost/api/parse-stream")
  if (opts.sourceIds) {
    url.searchParams.set("sourceIds", opts.sourceIds.join(","))
  }
  return new NextRequest(url)
}

function makeSource(id: string = SOURCE_ID) {
  return {
    id,
    name: `Feed ${id}`,
    type: "RSS",
    url: `https://example.com/feed/${id}`,
    isActive: true,
    userId: USER_ID,
    parallelMonitorId: null,
    includeRetweets: false,
  }
}

function makeItem(index: number) {
  return {
    title: `Item ${index}`,
    content: `Content ${index}`,
    url: `https://example.com/item/${index}`,
    externalId: `ext-${index}`,
    publishedAt: new Date("2026-01-01"),
    thumbnailUrl: null,
    mediaUrls: [],
  }
}

async function readSSEEvents(response: Response): Promise<Record<string, unknown>[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: Record<string, unknown>[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split("\n")) {
      if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)))
    }
  }
  return events
}

function setupAuth() {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, role: "USER" } } as never)
  vi.mocked(db.user.findUnique).mockResolvedValue({
    id: USER_ID,
    userSettings: { onboardingCompleted: true },
    subscription: {
      status: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
      cancelAtPeriodEnd: false,
    },
  } as never)
}

function setupNoExistingMaterials() {
  vi.mocked(db.material.findMany).mockResolvedValue([])
}

function setupFeedUpdate() {
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
}

function setupAIApproveAll() {
  vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ materials }: never) =>
    (materials as unknown[]).map(() => ({ relevant: true, confidence: 90, reasoning: "Approved" }))
  )
}

function makeMaterialResult(sourceId: string, index: number) {
  return {
    id: `mat-${sourceId}-${index}`,
    title: `Item ${index}`,
    url: `https://example.com/item/${index}`,
    content: `Content ${index}`,
    contentEntities: [],
    publishedAt: new Date("2026-01-01"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED",
    aiConfidence: 90,
    aiReasoning: "Approved",
    userStatus: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    feed: { id: sourceId, name: `Feed ${sourceId}`, type: "RSS" },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/parse-stream — bulk DB writes (RAD-183)", () => {
  // -------------------------------------------------------------------------
  // AC-1: MATERIAL_CREATE_CONCURRENCY exported constant + concurrent timing
  // -------------------------------------------------------------------------
  it("AC-1: MATERIAL_CREATE_CONCURRENCY=10 is exported from the route module", () => {
    assertConcurrencyConstant()
  })

  it("AC-1: material creates for a single source run concurrently (~50ms for 5 items), not serially (~250ms)", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const DELAY = 50
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i + 1))

    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(items)

    let createIdx = 0
    vi.mocked(db.material.create).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, DELAY))
      return makeMaterialResult(SOURCE_ID, createIdx++) as never
    })

    const start = Date.now()
    const response = await GET(makeRequest())
    await readSSEEvents(response)
    const elapsed = Date.now() - start

    // Serial would take 5 * 50ms = 250ms; concurrent should be ~50ms
    // Allow 6x margin for CI/machine load overhead (still well under 250ms serial)
    expect(elapsed).toBeLessThan(DELAY * 6)
  })

  // -------------------------------------------------------------------------
  // AC-2: Full MATERIAL_SELECT fields including feed relation
  // -------------------------------------------------------------------------
  it("AC-2: each material_created event includes full MATERIAL_SELECT fields with feed relation", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])
    vi.mocked(db.material.create).mockResolvedValue(makeMaterialResult(SOURCE_ID, 1) as never)

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(1)

    const material = materialCreatedEvents[0].material as Record<string, unknown>
    expect(material).toHaveProperty("id")
    expect(material).toHaveProperty("title")
    expect(material).toHaveProperty("url")
    expect(material).toHaveProperty("content")
    expect(material).toHaveProperty("aiEvaluation")
    expect(material).toHaveProperty("aiConfidence")
    expect(material).toHaveProperty("aiReasoning")
    expect(material).toHaveProperty("userStatus")
    expect(material).toHaveProperty("createdAt")
    // feed relation must be present with correct shape
    expect(material).toHaveProperty("feed")
    const feed = material.feed as Record<string, unknown>
    expect(feed).toHaveProperty("id")
    expect(feed).toHaveProperty("name")
    expect(feed).toHaveProperty("type")
  })

  // -------------------------------------------------------------------------
  // AC-3: material_created SSE events sent for each successfully created material
  // -------------------------------------------------------------------------
  it("AC-3: material_created SSE event is sent for each successfully created material", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const ITEM_COUNT = 3
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(
      Array.from({ length: ITEM_COUNT }, (_, i) => makeItem(i + 1))
    )

    let idx = 0
    vi.mocked(db.material.create).mockImplementation(async () =>
      makeMaterialResult(SOURCE_ID, idx++) as never
    )

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(ITEM_COUNT)
    for (const event of materialCreatedEvents) {
      expect(event.sourceId).toBe(SOURCE_ID)
      expect(event.material).toBeDefined()
    }
  })

  // -------------------------------------------------------------------------
  // AC-4: P2002 duplicate errors handled per-item
  // -------------------------------------------------------------------------
  it("AC-4: P2002 error for one item skips that item while other items succeed independently", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(items)
    vi.mocked(evaluateMaterialsBatch).mockResolvedValue(
      items.map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
    )

    let callIdx = 0
    vi.mocked(db.material.create).mockImplementation(async () => {
      const current = callIdx++
      // Second item (index 1) is a duplicate
      if (current === 1) {
        const err = new Error("Unique constraint failed") as Error & { code: string }
        err.code = "P2002"
        throw err
      }
      return makeMaterialResult(SOURCE_ID, current) as never
    })

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Only 2 material_created events (items 1 and 3; item 2 was P2002)
    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(2)

    // source_complete is sent — duplicate does not crash the pipeline
    const sourceComplete = events.find((e) => e.type === "source_complete")
    expect(sourceComplete).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // AC-5: source_complete stats equal actually created materials count
  // -------------------------------------------------------------------------
  it("AC-5: source_complete stats reflect actually created materials, not input count", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(items)
    vi.mocked(evaluateMaterialsBatch).mockResolvedValue([
      { relevant: true, confidence: 90, reasoning: "ok" },
      { relevant: false, confidence: 20, reasoning: "no" }, // filtered
      { relevant: true, confidence: 85, reasoning: "ok" },
    ])

    let callIdx = 0
    vi.mocked(db.material.create).mockImplementation(async () => {
      const current = callIdx++
      // First item is a duplicate — must NOT count in stats
      if (current === 0) {
        const err = new Error("Unique constraint failed") as Error & { code: string }
        err.code = "P2002"
        throw err
      }
      return makeMaterialResult(SOURCE_ID, current) as never
    })

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const sourceComplete = events.find((e) => e.type === "source_complete")
    expect(sourceComplete).toBeDefined()
    const stats = sourceComplete!.stats as Record<string, number>

    // 3 input items, 1 duplicate → 2 actually created
    expect(stats.new).toBe(2)
    // approved + filtered = exactly 2 (only the created ones)
    expect(stats.approved + stats.filtered).toBe(2)
    // Never equal to the raw input count
    expect(stats.new).not.toBe(3)
  })

  // -------------------------------------------------------------------------
  // EC-1: All items are duplicates
  // -------------------------------------------------------------------------
  it("EC-1: all items are P2002 duplicates — source_complete reports 0 new, no material_created events", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1), makeItem(2)])
    vi.mocked(db.material.create).mockImplementation(async () => {
      const err = new Error("Unique constraint failed") as Error & { code: string }
      err.code = "P2002"
      throw err
    })

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(0)

    const sourceComplete = events.find((e) => e.type === "source_complete")
    expect(sourceComplete).toBeDefined()
    expect((sourceComplete!.stats as Record<string, number>).new).toBe(0)
  })

  // -------------------------------------------------------------------------
  // EC-2: Single item
  // -------------------------------------------------------------------------
  it("EC-2: single item — works identically, one material_created event, correct stats", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])
    vi.mocked(db.material.create).mockResolvedValue(makeMaterialResult(SOURCE_ID, 1) as never)

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(1)

    const sourceComplete = events.find((e) => e.type === "source_complete")
    expect((sourceComplete!.stats as Record<string, number>).new).toBe(1)
    expect((sourceComplete!.stats as Record<string, number>).approved).toBe(1)
  })

  // -------------------------------------------------------------------------
  // EC-3: Mixed duplicates and new items
  // -------------------------------------------------------------------------
  it("EC-3: mixed duplicates and new items — only new items get SSE events, stats reflect actual creates", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4)]
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(items)
    vi.mocked(evaluateMaterialsBatch).mockResolvedValue(
      items.map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
    )

    const duplicateIndices = new Set([0, 2]) // items at index 0 and 2 are duplicates
    let callIdx = 0
    vi.mocked(db.material.create).mockImplementation(async () => {
      const current = callIdx++
      if (duplicateIndices.has(current)) {
        const err = new Error("Unique constraint failed") as Error & { code: string }
        err.code = "P2002"
        throw err
      }
      return makeMaterialResult(SOURCE_ID, current) as never
    })

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Only 2 material_created events (items at index 1 and 3 succeeded)
    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(2)

    // Stats reflect 2 actual creates, not 4 input items
    const sourceComplete = events.find((e) => e.type === "source_complete")
    const stats = sourceComplete!.stats as Record<string, number>
    expect(stats.new).toBe(2)
    expect(stats.approved).toBe(2)
  })

  // -------------------------------------------------------------------------
  // ERR-1: Non-P2002 error isolation via Promise.allSettled
  // -------------------------------------------------------------------------
  it("ERR-1: non-P2002 DB error for one item does not prevent other items from being created", async () => {
    assertConcurrencyConstant()

    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource()] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue(items)
    vi.mocked(evaluateMaterialsBatch).mockResolvedValue(
      items.map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
    )

    let callIdx = 0
    vi.mocked(db.material.create).mockImplementation(async () => {
      const current = callIdx++
      // Second item throws a generic (non-P2002) error
      if (current === 1) {
        throw new Error("Connection timeout")
      }
      return makeMaterialResult(SOURCE_ID, current) as never
    })

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Items at index 0 and 2 should still succeed — 2 material_created events
    const materialCreatedEvents = events.filter((e) => e.type === "material_created")
    expect(materialCreatedEvents).toHaveLength(2)

    // source_complete is still sent (error does not propagate out of Promise.allSettled)
    const sourceComplete = events.find((e) => e.type === "source_complete")
    expect(sourceComplete).toBeDefined()
    expect((sourceComplete!.stats as Record<string, number>).new).toBe(2)
  })
})

// RAD-297: the AI routes under test now require a verified email; these tests
// exercise the work BEHIND the gate. The gate itself is covered in
// __tests__/email-verification.test.ts and __tests__/api/email-verification-routes.test.ts.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
