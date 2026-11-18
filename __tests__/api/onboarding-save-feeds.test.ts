/**
 * POST /api/onboarding/save-feeds — batch feed creation during onboarding
 *
 * Tests Zod validation, deduplication, existing feed skip, and DB persistence.
 * RAD-178
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/entitlements", () => ({
  getTwitterEntitlement: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { POST } from "@/app/api/onboarding/save-feeds/route"

const USER_ID = "user-onb-123"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupUnauth() {
  const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  vi.mocked(requireAuth).mockResolvedValue(res as never)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/onboarding/save-feeds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.feed.findMany).mockResolvedValue([])
  vi.mocked(db.feed.createMany).mockResolvedValue({ count: 0 } as never)
  // Default: Twitter allowed (onboarding / Pro). Lite-drop cases override this.
  vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: null, includesTwitter: true })
})

describe("POST /api/onboarding/save-feeds", () => {
  it("returns 401 when not authenticated", async () => {
    setupUnauth()
    const res = await POST(makeRequest({ feeds: [] }))
    expect(res.status).toBe(401)
  })

  it("creates feeds and returns counts", async () => {
    setupAuth()
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 3 } as never)

    const feeds = [
      { name: "Blog A", url: "https://a.com/feed", type: "RSS" },
      { name: "Channel B", url: "https://t.me/channelb", type: "TELEGRAM" },
      { name: "User C", url: "https://x.com/userc", type: "TWITTER" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.created).toBe(3)
    expect(data.skipped).toBe(0)

    expect(db.feed.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: USER_ID, url: "https://a.com/feed", type: "RSS", isActive: true }),
      ]),
      skipDuplicates: true,
    })
  })

  it("drops TWITTER feeds for a non-Pro user and reports twitterSkipped", async () => {
    setupAuth()
    // Completed-onboarding Lite user — X parsing not in plan.
    vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: "lite", includesTwitter: false })
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 2 } as never)

    const feeds = [
      { name: "Blog A", url: "https://a.com/feed", type: "RSS" },
      { name: "Channel B", url: "https://t.me/channelb", type: "TELEGRAM" },
      { name: "User C", url: "https://x.com/userc", type: "TWITTER" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.created).toBe(2)
    expect(data.twitterSkipped).toBe(1)

    // The X feed must never reach createMany.
    const created = vi.mocked(db.feed.createMany).mock.calls[0][0].data as Array<{ type: string }>
    expect(created.some((f) => f.type === "TWITTER")).toBe(false)
  })

  it("deduplicates feeds with same URL in payload", async () => {
    setupAuth()
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 1 } as never)

    const feeds = [
      { name: "Blog A", url: "https://a.com/feed", type: "RSS" },
      { name: "Blog A Copy", url: "https://a.com/feed", type: "RSS" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(201)

    const createCall = vi.mocked(db.feed.createMany).mock.calls[0][0]
    expect((createCall.data as never[]).length).toBe(1)
  })

  it("skips feeds that already exist in DB", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([
      { url: "https://existing.com/feed" },
    ] as never)
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 1 } as never)

    const feeds = [
      { name: "Existing", url: "https://existing.com/feed", type: "RSS" },
      { name: "New", url: "https://new.com/feed", type: "RSS" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(201)
    const data = await res.json()
    // skipped = unique count (2) - created count (1) = 1
    expect(data.created).toBe(1)
    expect(data.skipped).toBe(1)

    const createCall = vi.mocked(db.feed.createMany).mock.calls[0][0]
    const created = createCall.data as never[]
    expect(created.length).toBe(1)
    expect(created[0].url).toBe("https://new.com/feed")
  })

  it("returns {created: 0, skipped: N} when all feeds exist", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([
      { url: "https://a.com/feed" },
      { url: "https://b.com/feed" },
    ] as never)

    const feeds = [
      { name: "A", url: "https://a.com/feed", type: "RSS" },
      { name: "B", url: "https://b.com/feed", type: "RSS" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.created).toBe(0)
    expect(data.skipped).toBe(2)
  })

  describe("Validation", () => {
    it("rejects empty feeds array", async () => {
      setupAuth()
      const res = await POST(makeRequest({ feeds: [] }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("No feeds")
    })

    it("rejects more than 300 feeds", async () => {
      setupAuth()
      const feeds = Array.from({ length: 301 }, (_, i) => ({
        name: `Feed ${i}`,
        url: `https://feed${i}.com/rss`,
        type: "RSS",
      }))

      const res = await POST(makeRequest({ feeds }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Invalid data")
    })

    it("rejects invalid feed type", async () => {
      setupAuth()
      const feeds = [{ name: "Bad", url: "https://bad.com", type: "INVALID" }]
      const res = await POST(makeRequest({ feeds }))
      expect(res.status).toBe(400)
    })

    it("rejects type WEBSITE (not in save-feeds schema)", async () => {
      setupAuth()
      const feeds = [{ name: "Site", url: "https://site.com", type: "WEBSITE" }]
      const res = await POST(makeRequest({ feeds }))
      expect(res.status).toBe(400)
    })
  })

  it("handles unicode feed names", async () => {
    setupAuth()
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 2 } as never)

    const feeds = [
      { name: "Канал Дурова", url: "https://t.me/durov", type: "TELEGRAM" },
      { name: "日本語チャンネル", url: "https://t.me/japan", type: "TELEGRAM" },
    ]

    const res = await POST(makeRequest({ feeds }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.created).toBe(2)
  })
})
