/**
 * YOUTUBE creation paths (RAD-267)
 *
 * POST /api/feeds: input canonicalization (@handle → /channel/UC…), name
 * upgrade from the resolved channel title, resolution failure → 400, and the
 * cross-form duplicate guard (qa-lead A3): the same channel already present
 * under EITHER url form (canonical /channel/UC… or RSS feed-XML
 * videos.xml?channel_id=UC…) answers 409 DUPLICATE_FEED — @@unique([userId,url])
 * alone can't catch the cross-form case.
 *
 * POST /api/onboarding/save-feeds: YOUTUBE accepted + resolved before
 * createMany; unresolvable inputs → youtubeSkipped; cross-form existing → skipped.
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
  getTwitterEntitlement: vi.fn(async () => ({ tier: "pro", includesTwitter: true })),
}))
vi.mock("@/lib/db", () => ({
  db: {
    feed: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), createMany: vi.fn() },
    settings: { findFirst: vi.fn() },
  },
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
// Keep the pure parts (extractChannelId, YouTubeResolveError) real; mock only
// the network resolver.
vi.mock("@/lib/youtube", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/youtube")>()
  return { ...original, resolveYouTubeChannel: vi.fn() }
})

import { requireAuth } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { resolveYouTubeChannel, YouTubeResolveError, extractChannelId } from "@/lib/youtube"
import { POST } from "@/app/api/feeds/route"
import { POST as saveFeedsPOST } from "@/app/api/onboarding/save-feeds/route"

const UC = "UCBJycsmduvYEL83R_U4JriQ"
const CANONICAL = `https://www.youtube.com/channel/${UC}`
const FEED_XML = `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`

function makeRequest(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/feeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: "u1", role: "USER" } as never)
  vi.mocked(requireActiveSubscription).mockResolvedValue(null as never)
  vi.mocked(db.feed.create).mockResolvedValue({ id: "feed1", coverUrl: null } as never)
  vi.mocked(db.feed.findFirst).mockResolvedValue(null as never)
  vi.mocked(resolveYouTubeChannel).mockResolvedValue({
    channelId: UC,
    channelUrl: CANONICAL,
    title: "Marques Brownlee",
  })
})

describe("POST /api/feeds — YOUTUBE canonicalization", () => {
  it("stores the canonical /channel/UC… URL and upgrades an echoed-handle name to the channel title", async () => {
    const res = await POST(
      makeRequest({ type: "YOUTUBE", name: "mkbhd", url: "https://www.youtube.com/@mkbhd", isActive: true })
    )
    expect(res.status).toBe(201)
    expect(resolveYouTubeChannel).toHaveBeenCalledWith("https://www.youtube.com/@mkbhd")
    const createArg = vi.mocked(db.feed.create).mock.calls[0][0] as { data: { url: string; name: string; type: string } }
    expect(createArg.data.url).toBe(CANONICAL)
    expect(createArg.data.type).toBe("YOUTUBE")
    expect(createArg.data.name).toBe("Marques Brownlee")
  })

  it("keeps a deliberate custom name", async () => {
    await POST(
      makeRequest({ type: "YOUTUBE", name: "Tech reviews I trust", url: "https://www.youtube.com/@mkbhd", isActive: true })
    )
    const createArg = vi.mocked(db.feed.create).mock.calls[0][0] as { data: { name: string } }
    expect(createArg.data.name).toBe("Tech reviews I trust")
  })

  it("returns 400 with the resolver message when resolution fails, writing nothing", async () => {
    vi.mocked(resolveYouTubeChannel).mockRejectedValue(new YouTubeResolveError("Channel not found — check the handle or URL"))
    const res = await POST(
      makeRequest({ type: "YOUTUBE", name: "x", url: "https://www.youtube.com/@nosuch", isActive: true })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Channel not found/)
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("A3: 409 when the channel already exists as a plain RSS feed-XML feed (cross-form)", async () => {
    vi.mocked(db.feed.findFirst).mockResolvedValue({ id: "existing-rss" } as never)
    const res = await POST(
      makeRequest({ type: "YOUTUBE", name: "mkbhd", url: "https://www.youtube.com/@mkbhd", isActive: true })
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("DUPLICATE_FEED")
    expect(db.feed.create).not.toHaveBeenCalled()
    // The guard queries by channel id containment, which matches BOTH url forms
    expect(db.feed.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u1", url: { contains: UC } }),
      })
    )
  })

  it("A3: extractChannelId resolves both url forms to the same UC id (guard equivalence)", () => {
    expect(extractChannelId(CANONICAL)).toBe(UC)
    expect(extractChannelId(FEED_XML)).toBe(UC)
  })
})

describe("POST /api/onboarding/save-feeds — YOUTUBE", () => {
  function makeSaveRequest(feeds: unknown[]): Request {
    return new Request("http://localhost/api/onboarding/save-feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feeds }),
    })
  }

  it("accepts YOUTUBE feeds, resolving them to the canonical form before createMany", async () => {
    vi.mocked(db.feed.findMany).mockResolvedValue([] as never)
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 1 } as never)

    const res = await saveFeedsPOST(
      makeSaveRequest([{ name: "mkbhd", url: "https://www.youtube.com/@mkbhd", type: "YOUTUBE" }])
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.created).toBe(1)
    expect(body.youtubeSkipped).toBe(0)
    const createArg = vi.mocked(db.feed.createMany).mock.calls[0][0] as { data: Array<{ url: string; type: string }> }
    expect(createArg.data[0].url).toBe(CANONICAL)
    expect(createArg.data[0].type).toBe("YOUTUBE")
  })

  it("skips unresolvable YouTube inputs, reporting youtubeSkipped", async () => {
    vi.mocked(resolveYouTubeChannel).mockRejectedValue(new YouTubeResolveError("nope"))
    vi.mocked(db.feed.findMany).mockResolvedValue([] as never)
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 1 } as never)

    const res = await saveFeedsPOST(
      makeSaveRequest([
        { name: "bad", url: "https://www.youtube.com/@gone", type: "YOUTUBE" },
        { name: "Blog", url: "https://a.com/feed", type: "RSS" },
      ])
    )
    const body = await res.json()
    expect(body.youtubeSkipped).toBe(1)
    expect(body.created).toBe(1)
    const createArg = vi.mocked(db.feed.createMany).mock.calls[0][0] as { data: Array<{ type: string }> }
    expect(createArg.data).toHaveLength(1)
    expect(createArg.data[0].type).toBe("RSS")
  })

  it("A3: skips a channel already present as a feed-XML RSS feed (cross-form)", async () => {
    vi.mocked(db.feed.findMany).mockResolvedValue([{ url: FEED_XML }] as never)
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 0 } as never)

    const res = await saveFeedsPOST(
      makeSaveRequest([{ name: "mkbhd", url: "https://www.youtube.com/@mkbhd", type: "YOUTUBE" }])
    )
    const body = await res.json()
    expect(body.created).toBe(0)
    expect(body.skipped).toBe(1)
    expect(db.feed.createMany).not.toHaveBeenCalled()
  })
})
