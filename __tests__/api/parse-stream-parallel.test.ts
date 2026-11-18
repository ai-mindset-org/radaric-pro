/**
 * GET /api/parse-stream — Single SSE + server-side parallelism (RAD-181)
 *
 * Tests that the route processes feeds concurrently using p-limit(5)
 * instead of a sequential for-loop.
 *
 * Criteria covered:
 *   AC-1: Processes up to 5 feeds concurrently via SOURCE_CONCURRENCY=5
 *   AC-3: Each SSE event includes sourceId for client attribution
 *   AC-4: Fault isolation — parser/AI failure in one source does not block others
 *   AC-5: parse_complete contains aggregated results from all feeds
 *   AC-6: A request-signal abort (RAD-346) is a transport loss, not a stop — every
 *         source still parses and parse_complete is still sent. An explicit stop
 *         (POST /api/parse-stream/stop) skips unstarted feeds and sends no
 *         parse_complete.
 *   EC-1: Single feed — works identically to current behavior
 *   EC-2: Zero active feeds — parse_complete with zeroed results immediately
 *   EC-3: Concurrent accumulator — parse_complete totals equal sum of source_complete stats
 *   EC-4: Event ordering — source_start first, source_complete last per source; parse_complete final
 *   ERR-1: Parser failure in one feed — error event with sourceId, other feeds complete normally
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

// Default true so existing tests are unaffected; the tier-exclusion tests
// override it. (hasActiveAccess stays real — the gate fixture grants access.)
vi.mock("@/lib/entitlements", () => ({
  subscriptionIncludesTwitter: vi.fn(() => true),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { parseInterestSource } from "@/lib/parsers/interest"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { subscriptionIncludesTwitter } from "@/lib/entitlements"
import { GET } from "@/app/api/parse-stream/route"
// RAD-346: the run is the server's, so the stop flag and its snapshot live here.
import {
  requestStopForUser,
  getRunSnapshot,
  __resetParseRunsForTests,
} from "@/lib/parse-runs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "user-test-001"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { sourceIds?: string[]; signal?: AbortSignal } = {}): NextRequest {
  const url = new URL("http://localhost/api/parse-stream")
  if (opts.sourceIds) {
    url.searchParams.set("sourceIds", opts.sourceIds.join(","))
  }
  return new NextRequest(url, { signal: opts.signal })
}

function makeSource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Feed ${id}`,
    type: "RSS",
    url: `https://example.com/feed/${id}`,
    isActive: true,
    userId: USER_ID,
    parallelMonitorId: null,
    includeRetweets: false,
    ...overrides,
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
    const text = decoder.decode(value)
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.slice(6)))
      }
    }
  }
  return events
}

function setupAuth() {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, role: "USER" } } as never)
  // Paywall: return an active subscription so the gate passes
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

function setupMaterialCreate(sourceId: string) {
  vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
    id: `mat-${sourceId}-${Date.now()}-${Math.random()}`,
    ...data,
    feed: { id: sourceId, name: `Feed ${sourceId}`, type: "RSS" },
  }))
}

function setupFeedUpdate() {
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
}

function setupAIApproveAll() {
  vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ materials }: never) =>
    materials.map(() => ({ relevant: true, confidence: 90, reasoning: "Approved" }))
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Module-level state shared by every request in this file.
  __resetParseRunsForTests()
})

describe("GET /api/parse-stream — parallel processing (RAD-181)", () => {
  // -----------------------------------------------------------------------
  // AC-1: Concurrency
  // -----------------------------------------------------------------------
  it("AC-1: processes up to 5 feeds concurrently (SOURCE_CONCURRENCY=5 exported constant)", async () => {
    // Import the constant — it must be exported from the route module.
    // This test will fail until SOURCE_CONCURRENCY is exported.
    const routeModule = await import("@/app/api/parse-stream/route")
    expect((routeModule as never).SOURCE_CONCURRENCY).toBe(5)
  })

  // Concurrency is asserted by observing how many parser calls are in flight at
  // once, not by timing the run. The previous version of this test measured
  // elapsed wall-clock and required it to stay under a fixed bound, which made
  // it fail whenever the machine was busy — and it was weak besides, since its
  // 350ms bound was above the 250ms sequential time it was meant to rule out.
  it("AC-1: runs all 5 feeds concurrently rather than one after another", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const sourceCount = 5
    const sources = Array.from({ length: sourceCount }, (_, i) => makeSource(`s${i + 1}`))

    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    let inFlight = 0
    let maxInFlight = 0
    let markAllStarted!: () => void
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve
    })

    // No parser resolves until every parser has been entered, so the run can
    // only finish if the route really does start them together. If the route
    // regressed to sequential, the first call would wait alone, the fallback
    // below would release it, and maxInFlight would stay at 1 — a clean
    // assertion failure rather than a hang.
    vi.mocked(parseRSSFeed).mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (inFlight === sourceCount) markAllStarted()
      await Promise.race([allStarted, new Promise((r) => setTimeout(r, 1000))])
      inFlight -= 1
      return [makeItem(1)]
    })

    setupMaterialCreate("s1")

    const response = await GET(makeRequest())
    await readSSEEvents(response)

    expect(maxInFlight).toBe(sourceCount)
  })

  // -----------------------------------------------------------------------
  // RAD-318: route budget vs the per-source watchdog
  // -----------------------------------------------------------------------
  it("maxDuration exceeds the per-source watchdog", async () => {
    // A 60s budget sitting next to a 180s watchdog is a contradiction: the
    // watchdog is allowed to wait three times longer than the route may live.
    // Railway runs this as a long-lived Node server where the export is inert,
    // but it reads as a real limit and would become one elsewhere.
    const mod = await import("@/app/api/parse-stream/route")
    expect(mod.maxDuration).toBeGreaterThan(mod.SOURCE_TIMEOUT_MS / 1000)
  })

  // -----------------------------------------------------------------------
  // AC-3: sourceId in each event
  // -----------------------------------------------------------------------
  it("AC-3: every SSE event (except parse_complete) includes sourceId", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const source = makeSource("src-a3")
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])
    setupMaterialCreate("src-a3")

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Events partition into run-level and source-level. Run-level events
    // describe the whole run and carry no sourceId by definition; every
    // source-level event must still name its source. RAD-318 added parse_start
    // to the run-level set — the assertion below is the original AC-3 narrowed
    // to the partition it was always really about, not a relaxation of it.
    const RUN_LEVEL = ["parse_start", "parse_complete"]

    const runLevel = events.filter((e) => RUN_LEVEL.includes(e.type))
    const sourceLevel = events.filter((e) => !RUN_LEVEL.includes(e.type))

    expect(runLevel.map((e) => e.type)).toEqual(["parse_start", "parse_complete"])
    for (const event of runLevel) {
      expect(event.sourceId).toBeUndefined()
    }

    expect(sourceLevel.length).toBeGreaterThan(0)
    for (const event of sourceLevel) {
      expect(event.sourceId).toBe("src-a3")
    }
  })

  // -----------------------------------------------------------------------
  // AC-4: Fault isolation
  // -----------------------------------------------------------------------
  it("AC-4: parser failure in one source does not prevent other sources from completing", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const failing = makeSource("failing-src")
    const healthy = makeSource("healthy-src")
    vi.mocked(db.feed.findMany).mockResolvedValue([failing, healthy] as never)

    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      if (url.includes("failing")) throw new Error("Network error")
      return [makeItem(1)]
    })
    setupMaterialCreate("healthy-src")

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const errorEvents = events.filter((e) => e.type === "error")
    const sourceCompleteEvents = events.filter((e) => e.type === "source_complete")
    const parseCompleteEvent = events.find((e) => e.type === "parse_complete")

    // Error event emitted for failing source with sourceId
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    expect(errorEvents.some((e) => e.sourceId === "failing-src")).toBe(true)

    // Healthy source still completes
    expect(sourceCompleteEvents.some((e) => e.sourceId === "healthy-src")).toBe(true)

    // parse_complete is still sent
    expect(parseCompleteEvent).toBeDefined()
  })

  it("AC-4: AI evaluation failure in one source does not prevent other sources from completing", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const failing = makeSource("ai-failing-src")
    const healthy = makeSource("ai-healthy-src")
    vi.mocked(db.feed.findMany).mockResolvedValue([failing, healthy] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])

    vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ sourceId }: never) => {
      if (sourceId === "ai-failing-src") throw new Error("AI quota exceeded")
      return [{ relevant: true, confidence: 88, reasoning: "OK" }]
    })
    setupMaterialCreate("ai-healthy-src")

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const errorEvents = events.filter((e) => e.type === "error")
    const parseCompleteEvent = events.find((e) => e.type === "parse_complete")

    expect(errorEvents.some((e) => e.sourceId === "ai-failing-src")).toBe(true)
    expect(parseCompleteEvent).toBeDefined()
    // Healthy source error NOT in error events
    expect(errorEvents.some((e) => e.sourceId === "ai-healthy-src")).toBe(false)
  })

  it("AC-4: failed source error is included in parse_complete.results.errors", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const source = makeSource("err-src")
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)
    vi.mocked(parseRSSFeed).mockRejectedValue(new Error("Connection refused"))

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const parseComplete = events.find((e) => e.type === "parse_complete")
    expect(parseComplete?.results?.errors).toHaveLength(1)
    expect(parseComplete?.results?.errors[0]).toContain("Connection refused")
  })

  // -----------------------------------------------------------------------
  // AC-5: Aggregated results in parse_complete
  // -----------------------------------------------------------------------
  it("AC-5: parse_complete contains aggregated results from all feeds", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const sources = [makeSource("agg-1"), makeSource("agg-2")]
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    // Each source has 2 items, all approved
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1), makeItem(2)])
    vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ materials }: never) =>
      materials.map(() => ({ relevant: true, confidence: 80, reasoning: "OK" }))
    )

    let materialIdx = 0
    vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
      id: `mat-${materialIdx++}`,
      ...data,
      feed: { id: data.sourceId, name: `Feed ${data.sourceId}`, type: "RSS" },
    }))

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const parseComplete = events.find((e) => e.type === "parse_complete")
    expect(parseComplete).toBeDefined()
    expect(parseComplete?.results?.parsed).toBe(4)  // 2 sources × 2 items
    expect(parseComplete?.results?.approved).toBe(4)
    expect(parseComplete?.results?.filtered).toBe(0)
    expect(parseComplete?.results?.errors).toEqual([])
  })

  // -----------------------------------------------------------------------
  // AC-6 (RAD-346): abort is a transport loss, an explicit stop is a stop
  // -----------------------------------------------------------------------
  it("AC-6: a request-signal abort mid-run still starts every source and emits parse_complete", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const abortController = new AbortController()
    // Many sources so there's time to abort
    const sources = Array.from({ length: 5 }, (_, i) => makeSource(`abort-${i}`))
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    const startedSources: string[] = []
    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      startedSources.push(url.split("/").pop()!)
      if (startedSources.length === 1) {
        // The CDN truncates the connection while the run is in flight.
        abortController.abort()
      }
      return [makeItem(1)]
    })
    setupMaterialCreate("abort-0")

    const request = makeRequest({ signal: abortController.signal })
    const response = await GET(request)
    const events = await readSSEEvents(response)

    // A dead transport is NOT a stop: no source is skipped.
    expect(startedSources).toHaveLength(5)
    expect([...startedSources].sort()).toEqual([
      "abort-0",
      "abort-1",
      "abort-2",
      "abort-3",
      "abort-4",
    ])

    const parseCompleteEvents = events.filter((e) => e.type === "parse_complete")
    expect(parseCompleteEvents).toHaveLength(1)
    expect(parseCompleteEvents[0].results).toMatchObject({
      parsed: 5,
      approved: 5,
      filtered: 0,
      errors: [],
    })

    // And the registry — not the transport — carries the outcome.
    expect(getRunSnapshot(USER_ID)?.status).toBe("done")
    expect(getRunSnapshot(USER_ID)?.processed).toBe(5)
  })

  it("AC-6: an explicit stop skips the sources that have not started and sends no parse_complete", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    // 6 sources so one is queued behind SOURCE_CONCURRENCY = 5.
    const sources = Array.from({ length: 6 }, (_, i) => makeSource(`qlimit-${i}`))
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    const startedSources: string[] = []
    let stopAccepted: boolean | null = null
    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      const id = url.split("/").pop()!
      startedSources.push(id)
      if (startedSources.length === 1) {
        // The user hit Stop while the first source was running.
        stopAccepted = requestStopForUser(USER_ID)
        await new Promise((r) => setTimeout(r, 20))
      }
      return []
    })

    const request = makeRequest()
    const response = await GET(request)
    const events = await readSSEEvents(response)

    expect(stopAccepted).toBe(true)
    expect(startedSources).toContain("qlimit-0")
    // The queued 6th source never starts.
    expect(startedSources).not.toContain("qlimit-5")

    const parseCompleteEvents = events.filter((e) => e.type === "parse_complete")
    expect(parseCompleteEvents).toHaveLength(0)

    expect(getRunSnapshot(USER_ID)?.status).toBe("stopped")
  })

  // -----------------------------------------------------------------------
  // EC-1: Single feed
  // -----------------------------------------------------------------------
  it("EC-1: single feed — emits source_start, items_fetched, source_complete, parse_complete in order", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const source = makeSource("solo")
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])
    setupMaterialCreate("solo")

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const types = events.map((e) => e.type)
    // parse_start is the manifest: it opens every run so the client has a
    // trustworthy denominator before any source reports.
    expect(types[0]).toBe("parse_start")
    expect(types[1]).toBe("source_start")
    expect(types[types.length - 1]).toBe("parse_complete")
    expect(types).toContain("source_complete")
  })

  // -----------------------------------------------------------------------
  // EC-2: Zero active feeds
  // -----------------------------------------------------------------------
  it("EC-2: zero active feeds — emits parse_complete immediately with zeroed results", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([])

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // A zero-source run still announces its denominator; without this the card
    // would have to infer "0 of ?" from the absence of events.
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("parse_start")
    expect(events[0].sourceCount).toBe(0)
    expect(events[0].sources).toEqual([])

    expect(events[1].type).toBe("parse_complete")
    expect(events[1].results).toEqual({
      parsed: 0,
      evaluated: 0,
      approved: 0,
      filtered: 0,
      errors: [],
    })
  })

  // -----------------------------------------------------------------------
  // EC-3: Concurrent accumulator
  // -----------------------------------------------------------------------
  it("EC-3: parse_complete totals equal sum of all individual source_complete stats", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const sources = [makeSource("acc-1"), makeSource("acc-2"), makeSource("acc-3")]
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    // Source 1: 3 approved, source 2: 1 approved + 1 filtered, source 3: 0 items
    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      if (url.includes("acc-1")) return [makeItem(1), makeItem(2), makeItem(3)]
      if (url.includes("acc-2")) return [makeItem(4), makeItem(5)]
      return []
    })

    vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ sourceId, materials }: never) => {
      if (sourceId === "acc-1") return materials.map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
      if (sourceId === "acc-2") return [
        { relevant: true, confidence: 80, reasoning: "ok" },
        { relevant: false, confidence: 70, reasoning: "nope" },
      ]
      return []
    })

    let idx = 0
    vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
      id: `mat-${idx++}`,
      ...data,
      feed: { id: data.sourceId, name: `Feed ${data.sourceId}`, type: "RSS" },
    }))

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    const parseComplete = events.find((e) => e.type === "parse_complete")
    const sourceCompletes = events.filter((e) => e.type === "source_complete")

    const sumParsed = sourceCompletes.reduce((s, e) => s + e.stats.parsed, 0)
    const sumNew = sourceCompletes.reduce((s, e) => s + e.stats.new, 0)

    expect(parseComplete?.results?.parsed).toBe(sumParsed)
    expect(parseComplete?.results?.approved + parseComplete?.results?.filtered).toBe(sumNew)
  })

  // -----------------------------------------------------------------------
  // EC-4: Event ordering per source
  // -----------------------------------------------------------------------
  it("EC-4: for any given sourceId, source_start is first and source_complete is last; parse_complete is the final event", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const sources = [makeSource("ord-1"), makeSource("ord-2")]
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([makeItem(1)])

    let idx = 0
    vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
      id: `mat-${idx++}`,
      ...data,
      feed: { id: data.sourceId, name: `Feed ${data.sourceId}`, type: "RSS" },
    }))

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Final event is parse_complete
    expect(events[events.length - 1].type).toBe("parse_complete")

    // For each source: source_start comes before source_complete
    for (const srcId of ["ord-1", "ord-2"]) {
      const sourceEvents = events
        .map((e, i) => ({ event: e, idx: i }))
        .filter(({ event }) => event.sourceId === srcId)

      const startIdx = sourceEvents.find(({ event }) => event.type === "source_start")?.idx
      const completeIdx = sourceEvents.find(({ event }) => event.type === "source_complete")?.idx

      expect(startIdx).toBeDefined()
      expect(completeIdx).toBeDefined()
      expect(startIdx!).toBeLessThan(completeIdx!)
    }
  })

  // -----------------------------------------------------------------------
  // ERR-1: Parser failure in one feed
  // -----------------------------------------------------------------------
  it("ERR-1: parser failure in one feed — error event sent for that feed, other feeds complete normally", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()

    const broken = makeSource("broken-rss")
    const good1 = makeSource("good-rss-1")
    const good2 = makeSource("good-rss-2")
    vi.mocked(db.feed.findMany).mockResolvedValue([broken, good1, good2] as never)

    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      if (url.includes("broken")) throw new Error("Parse error: invalid XML")
      return [makeItem(1)]
    })

    let idx = 0
    vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
      id: `mat-${idx++}`,
      ...data,
      feed: { id: data.sourceId, name: `Feed ${data.sourceId}`, type: "RSS" },
    }))

    const response = await GET(makeRequest())
    const events = await readSSEEvents(response)

    // Exactly one error event for the broken source
    const errorEvents = events.filter((e) => e.type === "error")
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].sourceId).toBe("broken-rss")

    // Both good sources have source_complete events
    const sourceCompletes = events.filter((e) => e.type === "source_complete")
    expect(sourceCompletes.some((e) => e.sourceId === "good-rss-1")).toBe(true)
    expect(sourceCompletes.some((e) => e.sourceId === "good-rss-2")).toBe(true)

    // parse_complete is sent and includes the error
    const parseComplete = events.find((e) => e.type === "parse_complete")
    expect(parseComplete).toBeDefined()
    expect(parseComplete?.results?.errors).toHaveLength(1)
  })
})

describe("GET /api/parse-stream — INTEREST sources (RAD-333)", () => {
  /**
   * The route used to count every material an Interest/Event Trigger source
   * created as approved (`results.approved += parseResult.created`, `filtered:
   * 0`), while the parser stores a real per-material evaluation. The card's
   * "AI approved" count then jumped above what the INBOX grid gained at
   * parse_complete, and the auto-group gate fired on runs where everything had
   * been filtered out.
   */
  it("splits approved from filtered by the material's own evaluation", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const source = makeSource("int-1", { type: "INTEREST", parallelMonitorId: "mon-1" })
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)

    vi.mocked(parseInterestSource).mockResolvedValue({
      created: 2,
      skipped: 1,
      total: 3,
      materials: [
        { id: "m-approved", aiEvaluation: "APPROVED" },
        { id: "m-filtered", aiEvaluation: "FILTERED" },
      ],
    } as never)

    const events = await readSSEEvents(await GET(makeRequest()))

    const complete = events.find((e) => e.type === "source_complete")!
    expect(complete.stats).toMatchObject({ parsed: 3, new: 2, approved: 1, filtered: 1 })

    const parseComplete = events.find((e) => e.type === "parse_complete")!
    expect(parseComplete.results).toMatchObject({ approved: 1, filtered: 1 })

    // The processing card reads `aiEvaluation` off each streamed frame to count
    // "AI approved" live; a MATERIAL_SELECT change that dropped the field would
    // zero that counter with no other test noticing.
    const streamed = events
      .filter((e) => e.type === "material_created")
      .map((e) => (e.material as { aiEvaluation: string }).aiEvaluation)
    expect(streamed).toEqual(["APPROVED", "FILTERED"])
  })

  it("reports zero approved when every material was filtered out", async () => {
    // The auto-group gate sums `source_complete.stats.approved`, so a source
    // that produced only FILTERED materials must contribute 0 — otherwise the
    // run schedules a grouping pass over nothing.
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()

    const source = makeSource("int-2", { type: "INTEREST", parallelMonitorId: "mon-2" })
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)

    vi.mocked(parseInterestSource).mockResolvedValue({
      created: 2,
      skipped: 0,
      total: 2,
      materials: [
        { id: "m-1", aiEvaluation: "FILTERED" },
        { id: "m-2", aiEvaluation: "FILTERED" },
      ],
    } as never)

    const events = await readSSEEvents(await GET(makeRequest()))

    expect(events.find((e) => e.type === "source_complete")!.stats).toMatchObject({
      new: 2,
      approved: 0,
      filtered: 2,
    })
    expect(events.find((e) => e.type === "parse_complete")!.results).toMatchObject({ approved: 0, filtered: 2 })
  })
})

describe("GET /api/parse-stream — Twitter tier exclusion", () => {
  it("excludes TWITTER from the source query for a non-Pro (Lite) user", async () => {
    setupAuth()
    setupNoExistingMaterials()
    vi.mocked(subscriptionIncludesTwitter).mockReturnValue(false)
    vi.mocked(db.feed.findMany).mockResolvedValue([])

    await readSSEEvents(await GET(makeRequest()))

    const where = (vi.mocked(db.feed.findMany).mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.type).toEqual({ not: "TWITTER" })
  })

  it("does not restrict source type for a Pro user", async () => {
    setupAuth()
    setupNoExistingMaterials()
    vi.mocked(subscriptionIncludesTwitter).mockReturnValue(true)
    vi.mocked(db.feed.findMany).mockResolvedValue([])

    await readSSEEvents(await GET(makeRequest()))

    const where = (vi.mocked(db.feed.findMany).mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.type).toBeUndefined()
  })
})

// RAD-297: the AI routes under test now require a verified email; these tests
// exercise the work BEHIND the gate. The gate itself is covered in
// __tests__/email-verification.test.ts and __tests__/api/email-verification-routes.test.ts.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
