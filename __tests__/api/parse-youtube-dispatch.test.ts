/**
 * YOUTUBE dispatch smoke tests (RAD-267)
 *
 * - parse-stream: YOUTUBE source routes to parseYouTubeChannel with the
 *   knownExternalIds pre-query, then through processSourceItems.
 * - /api/parse (legacy, onboarding first parse): YOUTUBE branch produces
 *   materials — no knownExternalIds (intentional asymmetry, qa-lead D2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((v: unknown) => v instanceof Response),
}))

vi.mock("@/lib/subscription", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscription")>()
  return {
    ...original,
    requireActiveSubscription: vi.fn(async () => null),
  }
})

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

vi.mock("@/lib/parsers/youtube", () => ({
  parseYouTubeChannel: vi.fn(),
}))

vi.mock("@/lib/parsers/interest", () => ({
  parseInterestSource: vi.fn(),
}))

vi.mock("@/lib/ai", () => ({
  evaluateMaterialsBatch: vi.fn(),
}))

vi.mock("@/lib/entitlements", () => ({
  subscriptionIncludesTwitter: vi.fn(() => true),
  getTwitterEntitlement: vi.fn(async () => ({ includesTwitter: true })),
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { requireAuth } from "@/lib/auth-utils"
import { parseYouTubeChannel } from "@/lib/parsers/youtube"
import { evaluateMaterialsBatch } from "@/lib/ai"

const USER_ID = "user-yt-001"
const UC = "UCBJycsmduvYEL83R_U4JriQ"
const CHANNEL_URL = `https://www.youtube.com/channel/${UC}`

function makeYouTubeSource(id = "yt-1") {
  return {
    id,
    name: "Test Channel",
    type: "YOUTUBE",
    url: CHANNEL_URL,
    isActive: true,
    userId: USER_ID,
    parallelMonitorId: null,
    includeRetweets: false,
  }
}

function makeVideoItem(n: number) {
  return {
    title: `Video ${n}`,
    content: `Video: Video ${n}\nChannel: Test Channel\n\nTranscript:\nwords ${n}`,
    url: `https://www.youtube.com/watch?v=vid${String(n).padStart(8, "0")}`,
    externalId: `youtube:vid${String(n).padStart(8, "0")}`,
    publishedAt: new Date("2026-07-01"),
    thumbnailUrl: `https://i.ytimg.com/vi/vid${n}/hqdefault.jpg`,
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, role: "USER" } } as never)
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(db.user.findUnique).mockResolvedValue({
    id: USER_ID,
    userSettings: { onboardingCompleted: true },
    subscription: {
      status: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
      cancelAtPeriodEnd: false,
    },
  } as never)
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
  vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ materials }: never) =>
    (materials as unknown[]).map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
  )
})

// Warm-up (collection time, not inside a test)
//
// Both routes are imported inside a test body below, so the first test to run
// pays for transforming and resolving the route's dependency tree — seconds
// when Vite's cache is cold, which is why this file timed out under CPU
// contention while passing in isolation. Importing them here pays that once at
// collection time, which testTimeout does not bound. Every heavy dependency is
// already replaced by the hoisted vi.mock calls above, so this loads exactly
// what the tests load.
await import("@/app/api/parse-stream/route")
await import("@/app/api/parse/route")

describe("parse-stream YOUTUBE dispatch", () => {
  it("routes a YOUTUBE source through parseYouTubeChannel with the knownExternalIds pre-query", async () => {
    const source = makeYouTubeSource()
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)
    // 1st material.findMany: the knownExternalIds pre-query; 2nd: processSourceItems dedup
    vi.mocked(db.material.findMany)
      .mockResolvedValueOnce([{ externalId: "youtube:vid00000001" }] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(parseYouTubeChannel).mockResolvedValue([makeVideoItem(2)] as never)
    vi.mocked(db.material.create).mockImplementation(async ({ data }: never) => ({
      id: "mat-1",
      ...(data as object),
      feed: { id: source.id, name: source.name, type: "YOUTUBE" },
    }) as never)

    const { GET } = await import("@/app/api/parse-stream/route")
    const response = await GET(new NextRequest(new URL("http://localhost/api/parse-stream")))
    const events = await readSSEEvents(response)

    expect(parseYouTubeChannel).toHaveBeenCalledTimes(1)
    const [urlArg, optsArg] = vi.mocked(parseYouTubeChannel).mock.calls[0]
    expect(urlArg).toBe(CHANNEL_URL)
    expect(optsArg?.knownExternalIds).toEqual(new Set(["youtube:vid00000001"]))

    // The pre-query is scoped to this source's youtube: ids
    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: source.id,
          externalId: { startsWith: "youtube:" },
        }),
      })
    )

    const complete = events.find((e) => e.type === "source_complete") as { stats: { new: number } }
    expect(complete).toBeDefined()
    expect(complete.stats.new).toBe(1)
    expect(events.some((e) => e.type === "parse_complete")).toBe(true)
  })
})

describe("/api/parse YOUTUBE dispatch (legacy onboarding route, D2)", () => {
  it("parses a YOUTUBE source and creates materials — no knownExternalIds", async () => {
    const source = makeYouTubeSource("yt-legacy")
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    vi.mocked(db.material.createMany).mockResolvedValue({ count: 2 } as never)
    vi.mocked(parseYouTubeChannel).mockResolvedValue([makeVideoItem(1), makeVideoItem(2)] as never)

    const { POST } = await import("@/app/api/parse/route")
    const request = new NextRequest(new URL("http://localhost/api/parse"), {
      method: "POST",
      body: JSON.stringify({}),
    })
    const response = await POST(request)
    const body = await response.json()

    expect(parseYouTubeChannel).toHaveBeenCalledTimes(1)
    // Legacy route passes only the URL — fetch-all is intentional (first parse)
    expect(vi.mocked(parseYouTubeChannel).mock.calls[0][1]).toBeUndefined()
    expect(db.material.createMany).toHaveBeenCalledTimes(1)
    const createArg = vi.mocked(db.material.createMany).mock.calls[0][0] as { data: Array<{ externalId: string }> }
    expect(createArg.data).toHaveLength(2)
    expect(createArg.data[0].externalId).toBe("youtube:vid00000001")
    expect(body.results).toMatchObject({ parsed: 2, evaluated: 2, approved: 2 })
  })
})

// RAD-297: the AI routes under test now require a verified email; these tests
// exercise the work BEHIND the gate. The gate itself is covered in
// __tests__/email-verification.test.ts and __tests__/api/email-verification-routes.test.ts.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
