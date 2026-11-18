/**
 * RAD-364 — every API path that writes a TELEGRAM feed URL accepts only a
 * public channel username. Private invite links are refused with their own
 * code: the worker reads only public channels, so a stored invite would fail
 * on every parse.
 *
 * The worker reads feeds through the operator's own Telegram session, and
 * GramJS resolves "me"/"self"/"this" to that account, a phone number against
 * its contacts, and a bare number as a cached peer id. POST used to store any
 * unnormalizable string raw (and skip the probe), PATCH never probed, and
 * onboarding save-feeds neither normalized nor probed. The worker gate is the
 * authoritative fix; these write paths stop the bad strings at the door.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))
vi.mock("@/lib/subscription", () => ({ requireActiveSubscription: vi.fn() }))
vi.mock("@/lib/entitlements", () => ({ getTwitterEntitlement: vi.fn() }))
vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    settings: { findFirst: vi.fn() },
  },
}))
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
import { validateTelegramSource } from "@/lib/feed-validation"
import { POST as createFeed } from "@/app/api/feeds/route"
import { PATCH as updateFeed } from "@/app/api/feeds/[id]/route"
import { POST as saveOnboardingFeeds } from "@/app/api/onboarding/save-feeds/route"

const FEED_ID = "feed-1"

function post(body: unknown) {
  return createFeed(
    new NextRequest("http://localhost/api/feeds", { method: "POST", body: JSON.stringify(body) })
  )
}
function patch(body: unknown) {
  return updateFeed(
    new NextRequest(`http://localhost/api/feeds/${FEED_ID}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: FEED_ID }) }
  )
}
function saveFeeds(feeds: Array<{ name: string; url: string; type: string }>) {
  return saveOnboardingFeeds(
    new Request("http://localhost/api/onboarding/save-feeds", { method: "POST", body: JSON.stringify({ feeds }) })
  )
}

const telegram = (url: string) => ({ type: "TELEGRAM", name: "Chan", url, isActive: true })

const CURRENT_FEED = {
  id: FEED_ID,
  userId: "u1",
  type: "TELEGRAM",
  url: "https://t.me/durov",
  name: "Durov",
  isActive: true,
  hidden: false,
  parallelMonitorId: null,
  interestQuery: null,
  interestCadence: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: "u1", role: "USER" } as never)
  vi.mocked(requireActiveSubscription).mockResolvedValue(null)
  vi.mocked(getTwitterEntitlement).mockResolvedValue({ tier: "pro", includesTwitter: true })
  vi.mocked(db.feed.findFirst).mockResolvedValue(null as never)
  vi.mocked(db.feed.findMany).mockResolvedValue([] as never)
  vi.mocked(db.feed.create).mockImplementation((async (a: { data: Record<string, unknown> }) => ({
    id: "f-new",
    coverUrl: null,
    ...a.data,
  })) as never)
  vi.mocked(db.feed.createMany).mockImplementation((async (a: { data: unknown[] }) => ({ count: a.data.length })) as never)
  vi.mocked(db.feed.findUnique).mockResolvedValue(CURRENT_FEED as never)
  vi.mocked(db.feed.updateMany).mockResolvedValue({ count: 1 } as never)
  vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "ok" })
})

// Shapes that resolve to the operator's own account, its contacts, or a
// cached peer id — never a public channel. URL forms are the ones that get
// past sourceSchema's .url() on POST/PATCH.
const SYNTACTICALLY_BAD = [
  "https://t.me/me",
  "https://t.me/self",
  "https://t.me/this",
  "https://t.me/THIS",
  "tg://resolve?domain=self",
  "https://t.me/+79991234567",
  "https://t.me/79991234567",
  "https://t.me/c/1234567/10",
]
// Bare forms: POST/PATCH already refuse them as non-URLs; save-feeds takes any string.
const BARE_BAD = ["me", "self", "this", "+79991234567", "79991234567", "-1001234567"]

const INVITES = ["https://t.me/+AbCdEfGhIjKlMnOp", "https://t.me/joinchat/AbCdEfGhIjKlMnOp"]

describe("POST /api/feeds", () => {
  it.each([...SYNTACTICALLY_BAD, ...BARE_BAD])("rejects %s and writes no row", async (url) => {
    const res = await post(telegram(url))
    expect(res.status).toBe(400)
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it.each(SYNTACTICALLY_BAD)("names the reason for %s", async (url) => {
    const res = await post(telegram(url))
    expect((await res.json()).code).toBe("TELEGRAM_INVALID_INPUT")
    expect(validateTelegramSource).not.toHaveBeenCalled()
  })

  it.each([
    ["https://t.me/pavel", "TELEGRAM_IS_USER"],
    ["https://t.me/example_bot", "TELEGRAM_IS_BOT"],
  ] as const)("rejects %s on the probe's verdict", async (url, code) => {
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "reject", code })
    const res = await post(telegram(url))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe(code)
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("still creates a public channel", async () => {
    const res = await post(telegram("@durov"))
    expect(res.status).toBe(400) // "@durov" is not a URL — the form canonicalizes before submit
    const ok = await post(telegram("https://t.me/s/durov/123"))
    expect(ok.status).toBe(201)
    expect(vi.mocked(db.feed.create).mock.calls[0][0].data.url).toBe("https://t.me/durov")
  })

  it.each(INVITES)("refuses a private invite link %s with its own code, unprobed", async (url) => {
    const res = await post(telegram(url))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TELEGRAM_PRIVATE_INVITE")
    expect(validateTelegramSource).not.toHaveBeenCalled()
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it.each(["https://t.me/9gag_news", "https://t.me/my__channel", "https://t.me/chan_"])(
    "refuses %s — outside Telegram's username grammar",
    async (url) => {
      const res = await post(telegram(url))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("TELEGRAM_INVALID_INPUT")
    }
  )
})

describe("PATCH /api/feeds/[id]", () => {
  it.each([...SYNTACTICALLY_BAD, ...BARE_BAD])("rejects %s and writes nothing", async (url) => {
    const res = await patch({ url })
    expect(res.status).toBe(400)
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ["https://t.me/pavel", "TELEGRAM_IS_USER"],
    ["https://t.me/example_bot", "TELEGRAM_IS_BOT"],
  ] as const)("probes a changed URL the way POST does — %s is rejected", async (url, code) => {
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "reject", code })
    const res = await patch({ url })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe(code)
    expect(validateTelegramSource).toHaveBeenCalledWith(url)
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it("rejects switching an existing row's type to TELEGRAM when its URL isn't a channel", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValue({ ...CURRENT_FEED, type: "RSS", url: "https://t.me/me" } as never)
    const res = await patch({ type: "TELEGRAM" })
    expect(res.status).toBe(400)
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it("doesn't re-probe when the URL is unchanged (a rename, a toggle)", async () => {
    const res = await patch({ url: "https://t.me/durov", name: "Renamed" })
    expect(res.status).toBe(200)
    expect(validateTelegramSource).not.toHaveBeenCalled()
    expect(db.feed.updateMany).toHaveBeenCalled()
  })

  it("canonicalizes and saves a new public channel", async () => {
    const res = await patch({ url: "https://telegram.me/s/telegram/5" })
    expect(res.status).toBe(200)
    expect(validateTelegramSource).toHaveBeenCalledWith("https://t.me/telegram")
    expect(vi.mocked(db.feed.updateMany).mock.calls[0][0].data.url).toBe("https://t.me/telegram")
  })

  it.each(INVITES)("refuses a private invite link %s with its own code", async (url) => {
    const res = await patch({ url })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TELEGRAM_PRIVATE_INVITE")
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it("a type switch to TELEGRAM stores the row's URL canonical, after the probe", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValue({ ...CURRENT_FEED, type: "RSS", url: "https://t.me/s/durov/9" } as never)
    const res = await patch({ type: "TELEGRAM" })
    expect(res.status).toBe(200)
    expect(validateTelegramSource).toHaveBeenCalledWith("https://t.me/durov")
    expect(vi.mocked(db.feed.updateMany).mock.calls[0][0].data.url).toBe("https://t.me/durov")
  })

  it("409s a changed URL another feed already holds — before the probe", async () => {
    vi.mocked(db.feed.findFirst).mockResolvedValue({ id: "other" } as never)
    const res = await patch({ url: "https://t.me/s/telegram/5" })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("DUPLICATE_FEED")
    const where = vi.mocked(db.feed.findFirst).mock.calls[0][0]?.where
    expect(where).toEqual({ userId: "u1", url: "https://t.me/telegram", NOT: { id: FEED_ID } })
    expect(validateTelegramSource).not.toHaveBeenCalled()
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it("an inconclusive probe saves the change with a caveat", async () => {
    vi.mocked(validateTelegramSource).mockResolvedValue({ verdict: "unknown" })
    const res = await patch({ url: "https://t.me/telegram" })
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toBe("FEED_UNVERIFIED")
  })
})

describe("POST /api/onboarding/save-feeds", () => {
  it.each([...SYNTACTICALLY_BAD, ...BARE_BAD])("skips %s and reports it as telegramSkipped", async (url) => {
    const res = await saveFeeds([
      { name: "Bad", url, type: "TELEGRAM" },
      { name: "Blog", url: "https://a.com/feed", type: "RSS" },
    ])
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.telegramSkipped).toBe(1)
    const created = vi.mocked(db.feed.createMany).mock.calls[0][0].data as Array<{ url: string }>
    expect(created.map((f) => f.url)).toEqual(["https://a.com/feed"])
  })

  it("stores public channels in canonical form and skips invite links", async () => {
    const res = await saveFeeds([
      { name: "Durov", url: "@durov", type: "TELEGRAM" },
      { name: "Durov again", url: "https://t.me/s/durov/9", type: "TELEGRAM" },
      { name: "Private", url: INVITES[0], type: "TELEGRAM" },
    ])
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.telegramSkipped).toBe(1)
    const created = vi.mocked(db.feed.createMany).mock.calls[0][0].data as Array<{ url: string }>
    // Two spellings of one channel collapse to one row.
    expect(created.map((f) => f.url)).toEqual(["https://t.me/durov"])
  })

  it("a batch of only bad Telegram inputs creates nothing", async () => {
    const res = await saveFeeds([{ name: "Me", url: "me", type: "TELEGRAM" }])
    const data = await res.json()
    expect(data).toMatchObject({ created: 0, telegramSkipped: 1 })
    expect(db.feed.createMany).not.toHaveBeenCalled()
  })
})
