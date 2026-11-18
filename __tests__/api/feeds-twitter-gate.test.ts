/**
 * POST /api/feeds — Twitter/X tier gate.
 *
 * A non-Pro (Lite) user cannot create a TWITTER feed: the route returns 402
 * TWITTER_NOT_IN_PLAN before any row is written. Pro/ADMIN and non-Twitter
 * types are unaffected.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))
vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn(),
}))
vi.mock("@/lib/entitlements", () => ({
  getTwitterEntitlement: vi.fn(),
}))
vi.mock("@/lib/db", () => ({
  db: {
    feed: { create: vi.fn(), findFirst: vi.fn() },
    settings: { findFirst: vi.fn() },
  },
}))
// The RSS cases below would otherwise run the real validator and hit the
// network from a unit test. Source validation has its own suites.
vi.mock("@/lib/feed-validation", async (actual) => ({
  ...(await actual<object>()),
  validateRssSource: vi.fn(),
  validateTelegramSource: vi.fn(),
}))
vi.mock("@/lib/parsers/twitter", () => ({
  buildTwitterSourceUrl: vi.fn(() => "https://x.com/userc"),
}))
vi.mock("@/lib/parsers/interest", () => ({
  createParallelMonitor: vi.fn(),
  deleteParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(() => "https://radaric.pro/api/webhooks/parallel"),
}))
vi.mock("@/lib/feed-cover", () => ({ saveSourceCover: vi.fn(() => Promise.resolve()) }))
vi.mock("@/lib/feed-favicon", () => ({ saveSourceFavicon: vi.fn(() => Promise.resolve()) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { requireAuth } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { db } from "@/lib/db"
import { validateRssSource } from "@/lib/feed-validation"
import { POST } from "@/app/api/feeds/route"

function makeRequest(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/feeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

const TWITTER_BODY = {
  type: "TWITTER",
  name: "User C",
  isActive: true,
  twitterType: "ACCOUNT",
  twitterValue: "userc",
}
const RSS_BODY = {
  type: "RSS",
  name: "Blog A",
  url: "https://a.com/feed",
  isActive: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: "u1", role: "USER" } as never)
  vi.mocked(requireActiveSubscription).mockResolvedValue(null) // active sub → allow
  vi.mocked(db.feed.create).mockResolvedValue({ id: "feed1", coverUrl: null } as never)
  vi.mocked(db.feed.findFirst).mockResolvedValue(null as never) // no duplicate
  vi.mocked(validateRssSource).mockResolvedValue({ ok: true, itemCount: 3 })
})

describe("POST /api/feeds — Twitter tier gate", () => {
  it("blocks a Lite user from creating a TWITTER feed (402, no row written)", async () => {
    vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: "lite", includesTwitter: false })

    const res = await POST(makeRequest(TWITTER_BODY))
    expect(res.status).toBe(402)
    const data = await res.json()
    expect(data.code).toBe("TWITTER_NOT_IN_PLAN")
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("allows a Pro user to create a TWITTER feed", async () => {
    vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: "pro", includesTwitter: true })

    const res = await POST(makeRequest(TWITTER_BODY))
    expect(res.status).toBe(201)
    expect(db.feed.create).toHaveBeenCalledTimes(1)
  })

  it("does not gate non-Twitter feeds (RSS) and never consults the entitlement", async () => {
    const res = await POST(makeRequest(RSS_BODY))
    expect(res.status).toBe(201)
    expect(getTwitterEntitlement).not.toHaveBeenCalled()
    expect(db.feed.create).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/feeds — duplicate source (RAD-268)", () => {
  it("returns 409 DUPLICATE_FEED on a unique-constraint violation", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed on source_user_url_unique"), {
      code: "P2002",
    })
    vi.mocked(db.feed.create).mockRejectedValue(p2002)

    const res = await POST(makeRequest(RSS_BODY))
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe("DUPLICATE_FEED")
  })

  it("still returns 500 for non-P2002 database errors", async () => {
    vi.mocked(db.feed.create).mockRejectedValue(new Error("connection lost"))

    const res = await POST(makeRequest(RSS_BODY))
    expect(res.status).toBe(500)
  })
})
