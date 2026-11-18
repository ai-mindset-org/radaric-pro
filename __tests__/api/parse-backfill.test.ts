/**
 * RAD-359 AC-4 — `/api/parse` (legacy one-shot route) backfills media on re-parse.
 *
 * The harness is lifted from `__tests__/api/parse-youtube-dispatch.test.ts`
 * (mock-based, no DB): same mock surface, plus `db.material.update`, which is
 * the new call under assertion. The route is imported for its side-effect-free
 * `POST` after the mocks are registered.
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

vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))

import { db } from "@/lib/db"
import { requireAuth } from "@/lib/auth-utils"
import { parseTelegramChannel } from "@/lib/parsers/telegram"
import { evaluateMaterialsBatch } from "@/lib/ai"

const USER_ID = "user-backfill-001"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
  vi.mocked(evaluateMaterialsBatch).mockImplementation(async ({ materials }: never) =>
    (materials as unknown[]).map(() => ({ relevant: true, confidence: 90, reasoning: "ok" }))
  )
})

// Warm-up at collection time so the first test does not pay for resolving the
// route's dependency tree under CPU contention (see parse-youtube-dispatch).
await import("@/app/api/parse/route")

describe("POST /api/parse — TELEGRAM media backfill (RAD-359 AC-4)", () => {
  it("AC-4: applies the reconciliation update on a duplicate-only source without re-running AI", async () => {
    const source = {
      id: "tg-legacy",
      name: "Channel",
      type: "TELEGRAM",
      url: "https://t.me/ch",
      isActive: true,
      userId: USER_ID,
      includeRetweets: false,
    }
    vi.mocked(db.feed.findMany).mockResolvedValue([source] as never)

    // Every parsed item is a duplicate; the stored row is a pre-feature one.
    vi.mocked(db.material.findMany).mockResolvedValue([
      {
        id: "mat-1",
        url: "https://t.me/ch/1",
        externalId: "ch:1",
        mediaUrls: [],
        thumbnailUrl: null,
        content: "[Media message]",
      },
    ] as never)

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
    ] as never)

    vi.mocked(db.material.update).mockResolvedValue({ id: "mat-1" } as never)

    const { POST } = await import("@/app/api/parse/route")
    const request = new NextRequest(new URL("http://localhost/api/parse"), {
      method: "POST",
      body: JSON.stringify({}),
    })
    const response = await POST(request)
    const body = await response.json()

    const payload = {
      thumbnailUrl: "https://cdn/x/thumb.jpg",
      mediaUrls: ["https://cdn/x/v.mp4"],
      content: "Real text",
    }

    expect(db.material.update).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.material.update).mock.calls[0][0]).toEqual({
      where: { id: "mat-1" },
      data: payload,
    })

    expect(evaluateMaterialsBatch).not.toHaveBeenCalled()
    expect(body.results).toMatchObject({ parsed: 1, evaluated: 0, approved: 0, filtered: 0 })
  })
})
