/**
 * RAD-346 — a dropped parse stream no longer ends the run.
 *
 * A CDN or reverse proxy in front of the app can truncate the SSE stream.
 * The route used to read that as a user stop: sources not yet started were
 * skipped, `parse_complete` was never sent, and writing to the dead stream was
 * logged as a fake source error. The run now belongs to the server and records
 * its outcome in `lib/parse-runs.ts`; a card that lost the transport polls
 * `GET /api/parse-stream/status`, and only `POST /api/parse-stream/stop` stops a
 * run early.
 *
 * Criteria covered:
 *   AC-1: a cancelled client does not skip any source; the run finishes done
 *   AC-2: a second GET while a run is active answers with a run-level error
 *   AC-3: POST /api/parse-stream/stop sets the stop flag / reports false when idle
 *   AC-4: GET /api/parse-stream/status → { run: null } / the live snapshot
 *   AC-5: writing to a gone consumer is a silent no-op — no fake source errors
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
      update: vi.fn(),
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

vi.mock("@/lib/entitlements", () => ({
  subscriptionIncludesTwitter: vi.fn(() => true),
}))

vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { parseTelegramChannel } from "@/lib/parsers/telegram"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { GET as parseGET } from "@/app/api/parse-stream/route"
import { GET as statusGET } from "@/app/api/parse-stream/status/route"
import { POST as stopPOST } from "@/app/api/parse-stream/stop/route"
import {
  beginParseRun,
  syncRunProgress,
  isStopRequested,
  getRunSnapshot,
  __resetParseRunsForTests,
} from "@/lib/parse-runs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "user-detach-001"

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

function setupMaterialCreate() {
  vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
    id: `mat-${(data as { sourceId: string }).sourceId}-${Math.random()}`,
    ...(data as Record<string, unknown>),
    feed: { id: (data as { sourceId: string }).sourceId, name: "Feed", type: "RSS" },
  }))
}

function post(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "POST" })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  __resetParseRunsForTests()
})

describe("GET /api/parse-stream — a dropped client does not end the run (RAD-346)", () => {
  it("AC-1 / AC-5: cancelling the reader mid-run still parses every source and records a clean done run", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()
    setupMaterialCreate()

    const sources = ["detach-1", "detach-2", "detach-3"].map((id) => makeSource(id))
    vi.mocked(db.feed.findMany).mockResolvedValue(sources as never)

    let releaseFirst!: () => void
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []

    vi.mocked(parseRSSFeed).mockImplementation(async (url: string) => {
      const id = url.split("/").pop()!
      started.push(id)
      // Hold the run open so the client can hang up while sources are in flight.
      if (started.length === 1) await firstCallGate
      return [makeItem(1)]
    })

    const response = await parseGET(makeRequest())
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1))

    const reader = response.body!.getReader()
    await reader.read()
    // The CDN truncates the stream: the consumer is gone, the run is not.
    await reader.cancel()

    releaseFirst()

    await vi.waitFor(() => expect(getRunSnapshot(USER_ID)?.status).toBe("done"), { timeout: 5000 })

    // Every source on the manifest was parsed — none skipped.
    expect(started).toHaveLength(3)
    expect([...started].sort()).toEqual(["detach-1", "detach-2", "detach-3"])

    const snap = getRunSnapshot(USER_ID)
    expect(snap?.status).toBe("done")
    expect(snap?.total).toBe(3)
    expect(snap?.processed).toBe(3)
    expect(snap?.approved).toBe(3)
    expect(snap?.filtered).toBe(0)
    // AC-5: the dead-stream write is a no-op — no "Invalid state: Controller is
    // already closed" is recorded as a source error.
    expect(snap?.results?.errors).toEqual([])
    expect(snap?.results?.parsed).toBe(3)
  })

  it("AC-2: a second GET while a run is active answers with a run-level error and parses nothing", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()
    setupMaterialCreate()

    // Each request gets its own sources. "The second request parsed nothing" is
    // measured against the second request's set: the first run's two sources run
    // concurrently and keep going in the background after this GET — a dropped
    // or duplicate client no longer aborts them — so busy-2 may already have
    // completed by the time the second request is answered, and a global call
    // count on `parseRSSFeed` can never express "the second one parsed nothing".
    vi.mocked(db.feed.findMany).mockImplementation(async ({ where }: never) => {
      const ids = (where as { id?: { in?: string[] } }).id?.in ?? []
      return ids.some((id) => id.startsWith("second-"))
        ? ([makeSource("second-1"), makeSource("second-2")] as never)
        : ([makeSource("busy-1"), makeSource("busy-2")] as never)
    })

    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let parserCalls = 0
    vi.mocked(parseRSSFeed).mockImplementation(async () => {
      parserCalls++
      if (parserCalls === 1) await gate
      return []
    })

    const first = await parseGET(makeRequest({ sourceIds: ["busy-1", "busy-2"] }))

    try {
      // One run per user: the second request must not start a parallel parse.
      const second = await parseGET(makeRequest({ sourceIds: ["second-1", "second-2"] }))
      const events = await readSSEEvents(second)

      const errorFrames = events.filter((e) => e.type === "error")
      expect(errorFrames).toHaveLength(1)
      expect(errorFrames[0].error).toMatch(/already running/i)
      // Run-level: it names the run, not a source.
      expect(errorFrames[0].sourceId).toBeUndefined()

      // Nothing was parsed for it: no manifest, and no parser ever saw one of
      // its sources.
      expect(events.some((e) => e.type === "parse_start")).toBe(false)
      expect(
        vi.mocked(parseRSSFeed).mock.calls.every(([url]) => !String(url).includes("second-"))
      ).toBe(true)
    } finally {
      releaseFirst()
      await readSSEEvents(first)
    }
  })

  it("AC-3: POST /api/parse-stream/stop stops the running user's run and answers false when idle", async () => {
    setupAuth()

    // Nothing running: a stop is a no-op the client can trust.
    const idle = await stopPOST(post("/api/parse-stream/stop"))
    expect(await idle.json()).toEqual({ stopped: false })

    const run = beginParseRun(USER_ID, 2)
    expect(run).not.toBeNull()

    const stopped = await stopPOST(post("/api/parse-stream/stop"))
    expect(await stopped.json()).toEqual({ stopped: true })
    expect(isStopRequested(run!)).toBe(true)
  })

  it("RAD-407: parse_start names the run it claimed, and a later run gets a new id", async () => {
    setupAuth()
    setupNoExistingMaterials()
    setupFeedUpdate()
    setupAIApproveAll()
    setupMaterialCreate()
    vi.mocked(db.feed.findMany).mockResolvedValue([makeSource("id-1")] as never)
    vi.mocked(parseRSSFeed).mockResolvedValue([])

    // A client that loses the stream follows the run by this id; the registry
    // keeps a finished run for 15 minutes, so "the user's latest run" is not
    // necessarily this one.
    const first = await readSSEEvents(await parseGET(makeRequest()))
    const firstStart = first.find((e) => e.type === "parse_start")
    expect(typeof firstStart?.runId).toBe("string")
    expect(firstStart?.runId).toBe(getRunSnapshot(USER_ID)?.id)

    const second = await readSSEEvents(await parseGET(makeRequest()))
    const secondStart = second.find((e) => e.type === "parse_start")
    expect(secondStart?.runId).toBe(getRunSnapshot(USER_ID)?.id)
    expect(secondStart?.runId).not.toBe(firstStart?.runId)
  })

  it("AC-4: GET /api/parse-stream/status returns { run: null } when idle and the live snapshot while running", async () => {
    setupAuth()

    const idle = await statusGET(new NextRequest("http://localhost/api/parse-stream/status"))
    expect(await idle.json()).toEqual({ run: null })

    const run = beginParseRun(USER_ID, 4)
    expect(run).not.toBeNull()
    syncRunProgress(run!, { processed: 2, approved: 1, filtered: 1 })

    const live = await statusGET(new NextRequest("http://localhost/api/parse-stream/status"))
    const body = (await live.json()) as { run: Record<string, unknown> | null }

    expect(body.run?.status).toBe("running")
    expect(body.run?.total).toBe(4)
    expect(body.run?.processed).toBe(2)
    expect(body.run?.approved).toBe(1)
    expect(body.run?.filtered).toBe(1)
    expect(body.run?.finishedAt).toBeNull()
    expect(body.run?.results).toBeNull()
  })
})

describe("GET /api/parse-stream — media backfill on a duplicate-only source (RAD-359 AC-3)", () => {
  it("AC-3: updates the empty-media row, streams material_updated, leaves a matching row alone, and never re-runs AI", async () => {
    setupAuth()
    setupFeedUpdate()
    setupAIApproveAll()

    const source = makeSource("tg-1", { type: "TELEGRAM", name: "Channel", url: "https://t.me/ch" })
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)

    // mat-1 has no media (pre-feature row); mat-2 is already mirrored.
    const stored = [
      {
        id: "mat-1",
        url: "https://t.me/ch/1",
        externalId: "ch:1",
        mediaUrls: [],
        thumbnailUrl: null,
        content: "[Media message]",
      },
      {
        id: "mat-2",
        url: "https://t.me/ch/2",
        externalId: "ch:2",
        mediaUrls: ["https://cdn/y/a.jpg"],
        thumbnailUrl: "https://cdn/y/a-thumb.jpg",
        content: "Already mirrored",
      },
    ]
    vi.mocked(db.material.findMany).mockResolvedValue(stored as never)

    vi.mocked(parseTelegramChannel).mockResolvedValue([
      {
        title: "Post 1",
        content: "Real text",
        url: "https://t.me/ch/1",
        externalId: "ch:1",
        publishedAt: new Date("2026-01-01"),
        thumbnailUrl: "https://cdn/x/thumb.jpg",
        mediaUrls: ["https://cdn/x/v.mp4"],
      },
      {
        title: "Post 2",
        content: "Already mirrored",
        url: "https://t.me/ch/2",
        externalId: "ch:2",
        publishedAt: new Date("2026-01-02"),
        thumbnailUrl: "https://cdn/y/a-thumb.jpg",
        mediaUrls: ["https://cdn/y/a.jpg"],
      },
    ] as never)

    vi.mocked(db.material.update).mockResolvedValue({ id: "mat-1" } as never)

    const response = await parseGET(makeRequest())
    const events = await readSSEEvents(response)

    const payload = {
      thumbnailUrl: "https://cdn/x/thumb.jpg",
      mediaUrls: ["https://cdn/x/v.mp4"],
      content: "Real text",
    }

    // Exactly one update — for the empty-media row. mat-2's media already
    // matches, so it is neither updated nor announced.
    expect(db.material.update).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.material.update).mock.calls[0][0]).toEqual({
      where: { id: "mat-1" },
      data: payload,
    })

    const updates = events.filter((e) => e.type === "material_updated")
    expect(updates).toHaveLength(1)
    expect(updates[0].material).toEqual({ id: "mat-1", ...payload })

    // Duplicates never reach AI.
    expect(evaluateMaterialsBatch).not.toHaveBeenCalled()

    // The source still completes with its own stats.
    const complete = events.find((e) => e.type === "source_complete") as {
      stats: { new: number }
    }
    expect(complete).toBeDefined()
    expect(complete.stats.new).toBe(0)
    expect(events.some((e) => e.type === "parse_complete")).toBe(true)
  })
})
