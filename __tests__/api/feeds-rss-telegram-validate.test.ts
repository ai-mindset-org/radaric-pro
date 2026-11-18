/**
 * POST /api/feeds — source validation at creation.
 *
 * A source that can never yield material must be rejected at the door rather
 * than accepted and left to parse to nothing forever (which reads to the user
 * as "parsing is broken"). But only a DEFINITIVE answer may reject: our own
 * probe failing has to fail open, or a good feed becomes unaddable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))
vi.mock("@/lib/subscription", () => ({ requireActiveSubscription: vi.fn() }))
vi.mock("@/lib/entitlements", () => ({ getTwitterEntitlement: vi.fn() }))
vi.mock("@/lib/db", () => ({
  db: {
    feed: { create: vi.fn(), findFirst: vi.fn() },
    settings: { findFirst: vi.fn() },
  },
}))
// Spread the real module so the reject-copy map stays authentic and a future
// export can't silently arrive undefined in the route under test.
vi.mock("@/lib/feed-validation", async (actual) => ({
  ...(await actual<object>()),
  validateRssSource: vi.fn(),
  validateTelegramSource: vi.fn(),
}))
vi.mock("@/lib/parsers/twitter", () => ({ buildTwitterSourceUrl: vi.fn(() => "https://x.com/u") }))
vi.mock("@/lib/parsers/interest", () => ({
  createParallelMonitor: vi.fn(),
  deleteParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(() => "https://radaric.pro/api/webhooks/parallel"),
}))
vi.mock("@/lib/youtube", () => ({
  resolveYouTubeChannel: vi.fn(),
  YouTubeResolveError: class extends Error {},
}))
vi.mock("@/lib/feed-cover", () => ({ saveSourceCover: vi.fn(() => Promise.resolve()) }))
vi.mock("@/lib/feed-favicon", () => ({ saveSourceFavicon: vi.fn(() => Promise.resolve()) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { requireAuth } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { db } from "@/lib/db"
import { validateRssSource, validateTelegramSource } from "@/lib/feed-validation"
import { resolveYouTubeChannel } from "@/lib/youtube"
import { POST } from "@/app/api/feeds/route"

function makeRequest(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/feeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

const rss = (url = "https://example.com/feed.xml") => ({ type: "RSS", name: "Blog", url, isActive: true })
const telegram = (url: string) => ({ type: "TELEGRAM", name: "Chan", url, isActive: true })

function feedOk(over: Record<string, unknown> = {}) {
  return { ok: true as const, itemCount: 5, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: "u1", role: "USER" } as never)
  vi.mocked(requireActiveSubscription).mockResolvedValue(null)
  vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: "pro", includesTwitter: true })
  vi.mocked(db.feed.findFirst).mockResolvedValue(null as never)
  vi.mocked(db.feed.create).mockImplementation((async (a: { data: Record<string, unknown> }) => ({
    id: "f1",
    coverUrl: null,
    ...a.data,
  })) as never)
  vi.mocked(validateRssSource).mockResolvedValue(feedOk())
  vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "ok" })
})

describe("POST /api/feeds — Telegram source validation", () => {
  it("rejects a bot and writes no row", async () => {
    // The reported bug: a bot handle resolved fine, parsed 0 messages every
    // run, and looked to the user like broken parsing.
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "reject", code: "TELEGRAM_IS_BOT" })

    const res = await POST(makeRequest(telegram("https://t.me/example_bot")))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TELEGRAM_IS_BOT")
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("rejects a personal account with a distinct code", async () => {
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "reject", code: "TELEGRAM_IS_USER" })
    const res = await POST(makeRequest(telegram("https://t.me/someperson")))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TELEGRAM_IS_USER")
  })

  it("rejects a username that doesn't exist", async () => {
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "reject", code: "TELEGRAM_NOT_FOUND" })
    const res = await POST(makeRequest(telegram("https://t.me/nosuchchannel")))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TELEGRAM_NOT_FOUND")
  })

  it("creates a channel feed", async () => {
    const res = await POST(makeRequest(telegram("https://t.me/durov")))
    expect(res.status).toBe(201)
    expect(db.feed.create).toHaveBeenCalled()
  })

  it("creates the feed when validation is inconclusive (fail open)", async () => {
    // The worker reconnects periodically; failing closed would break Telegram
    // feed creation for minutes at a time.
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "unknown" })
    const res = await POST(makeRequest(telegram("https://t.me/durov")))
    expect(res.status).toBe(201)
    expect(db.feed.create).toHaveBeenCalled()
  })

  it("409s a duplicate without paying for the worker probe first", async () => {
    // Without this the create still 409s via the P2002 catch — but only after a
    // 5s worker round-trip, and validateTelegramSource may have already answered
    // 400 TELEGRAM_IS_BOT for a source the user already owns.
    vi.mocked(db.feed.findFirst).mockResolvedValue({ id: "existing" } as never)
    const res = await POST(makeRequest(telegram("https://t.me/durov")))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("DUPLICATE_FEED")
    expect(validateTelegramSource).not.toHaveBeenCalled()
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("checks for the duplicate using the CANONICALIZED url, not the raw paste", async () => {
    // t.me/s/durov/123 and t.me/durov are the same channel; keying the
    // pre-check on the raw paste would miss the duplicate and probe anyway.
    await POST(makeRequest(telegram("https://t.me/s/durov/123")))
    const where = vi.mocked(db.feed.findFirst).mock.calls[0][0]?.where as { url?: string }
    expect(where.url).toBe("https://t.me/durov")
  })

  it("validates the canonicalized URL, not the raw paste", async () => {
    await POST(makeRequest(telegram("https://t.me/s/durov/123")))
    expect(validateTelegramSource).toHaveBeenCalledWith("https://t.me/durov")
  })
})

describe("POST /api/feeds — RSS source validation", () => {
  it("rejects a URL that isn't a feed and writes no row", async () => {
    vi.mocked(validateRssSource).mockResolvedValue({ ok: false, code: "NOT_A_FEED" })
    const res = await POST(makeRequest(rss("https://example.com/page")))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("NOT_A_FEED")
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("creates a populated feed with no warning", async () => {
    const res = await POST(makeRequest(rss()))
    expect(res.status).toBe(201)
    expect((await res.json()).warning).toBeUndefined()
  })

  it("creates an empty-but-valid feed and warns", async () => {
    // github.com/aji-ai/dit-2026/releases.atom — valid Atom, zero entries
    // because the repo never cut a release. Legitimately addable, but the user
    // has to be told, or silence looks like a bug.
    vi.mocked(validateRssSource).mockResolvedValue(feedOk({ itemCount: 0 }))
    const res = await POST(makeRequest(rss("https://github.com/aji-ai/dit-2026/releases.atom")))
    expect(res.status).toBe(201)
    expect((await res.json()).warning).toBe("FEED_EMPTY")
    expect(db.feed.create).toHaveBeenCalled()
  })

  it("creates the feed with a caveat when it can't be verified (fail open)", async () => {
    vi.mocked(validateRssSource).mockResolvedValue({ ok: "unknown" })
    const res = await POST(makeRequest(rss()))
    expect(res.status).toBe(201)
    expect((await res.json()).warning).toBe("FEED_UNVERIFIED")
    expect(db.feed.create).toHaveBeenCalled()
  })

  it("rejects a domain that doesn't exist with its own code", async () => {
    vi.mocked(validateRssSource).mockResolvedValue({ ok: false, code: "DNS_NOT_FOUND" })
    const res = await POST(makeRequest(rss("https://exmaple.cmo/feed")))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("DNS_NOT_FOUND")
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("stores the URL exactly as given — validation never rewrites it", async () => {
    await POST(makeRequest(rss("https://example.com/tag/ai/rss")))
    const written = vi.mocked(db.feed.create).mock.calls[0][0] as { data: { url: string } }
    expect(written.data.url).toBe("https://example.com/tag/ai/rss")
  })

  it("409s a duplicate without paying for validation first", async () => {
    vi.mocked(db.feed.findFirst).mockResolvedValue({ id: "existing" } as never)
    const res = await POST(makeRequest(rss()))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("DUPLICATE_FEED")
    expect(validateRssSource).not.toHaveBeenCalled()
  })

  it("keeps the 201 body shaped as the source object", async () => {
    // Callers treat the body as the feed itself; a warning rides alongside.
    vi.mocked(validateRssSource).mockResolvedValue(feedOk({ itemCount: 0 }))
    const body = await (await POST(makeRequest(rss()))).json()
    expect(body.id).toBe("f1")
    expect(body.type).toBe("RSS")
  })
})

describe("POST /api/feeds — other source types are unaffected", () => {
  it("does not validate a YOUTUBE source as RSS or Telegram", async () => {
    vi.mocked(resolveYouTubeChannel).mockResolvedValue({
      channelId: "UC123",
      channelUrl: "https://www.youtube.com/channel/UC123",
      title: "MKBHD",
    } as never)
    const res = await POST(
      makeRequest({ type: "YOUTUBE", name: "mkbhd", url: "https://youtube.com/@mkbhd", isActive: true })
    )
    expect(res.status).toBe(201)
    expect(validateRssSource).not.toHaveBeenCalled()
    expect(validateTelegramSource).not.toHaveBeenCalled()
  })

  it("does not validate a TWITTER source", async () => {
    const res = await POST(
      makeRequest({ type: "TWITTER", name: "U", isActive: true, twitterType: "ACCOUNT", twitterValue: "u" })
    )
    expect(res.status).toBe(201)
    expect(validateRssSource).not.toHaveBeenCalled()
    expect(validateTelegramSource).not.toHaveBeenCalled()
  })
})
