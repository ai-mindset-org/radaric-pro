/**
 * OPML Import — Failing Tests (RED phase)
 *
 * Two layers under test:
 *   1. parseOpml() — pure parser function in lib/opml-parser.ts (no mocks)
 *   2. POST /api/feeds/import-opml — API route (auth + db + source-cover mocked)
 *
 * Spec coverage:
 *   AC-1:  parseOpml() extracts feed entries (name, xmlUrl, htmlUrl)
 *   AC-2:  parseOpml() extracts group names from parent outline elements
 *   AC-3:  parseOpml() marks Feedly-specific URLs with isFeedlySpecific: true
 *   AC-4:  parseOpml() skips entries without xmlUrl
 *   AC-5:  parseOpml() handles flat OPML (feeds without group wrappers)
 *   EC-1:  parseOpml() returns empty array for empty/minimal OPML
 *   EC-2:  parseOpml() handles malformed XML gracefully (throws descriptive error)
 *   ERR-1: parseOpml() throws on completely invalid input (not XML at all)
 *   AC-6:  POST /api/feeds/import-opml creates RSS sources from parsed feeds
 *   AC-7:  POST /api/feeds/import-opml skips duplicate sources
 *   AC-8:  POST /api/feeds/import-opml stores group name in source tags field
 *   AC-9:  POST /api/feeds/import-opml returns structured response
 *   AC-10: POST /api/feeds/import-opml requires authentication (401 without session)
 *   EC-3:  POST /api/feeds/import-opml handles OPML with 200+ feeds without error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// Mocks (API tests only — parser tests use no mocks)
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/feed-cover", () => ({
  saveSourceCover: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { parseOpml } from "@/lib/opml-parser"
import { POST } from "@/app/api/feeds/import-opml/route"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUPED_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Test subscriptions</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="TechCrunch" title="TechCrunch" xmlUrl="https://techcrunch.com/feed/" htmlUrl="https://techcrunch.com"/>
      <outline type="rss" text="The Verge" title="The Verge" xmlUrl="https://www.theverge.com/rss/index.xml" htmlUrl="https://www.theverge.com"/>
    </outline>
    <outline text="Social" title="Social">
      <outline type="rss" text="Social Media Today" title="Social Media Today" xmlUrl="https://www.socialmediatoday.com/feed/" htmlUrl="https://www.socialmediatoday.com"/>
    </outline>
  </body>
</opml>`

const FLAT_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Flat subscriptions</title></head>
  <body>
    <outline type="rss" text="Hacker News" title="Hacker News" xmlUrl="https://news.ycombinator.com/rss" htmlUrl="https://news.ycombinator.com"/>
    <outline type="rss" text="Lobsters" title="Lobsters" xmlUrl="https://lobste.rs/rss" htmlUrl="https://lobste.rs"/>
  </body>
</opml>`

const FEEDLY_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Feedly export</title></head>
  <body>
    <outline text="Feeds" title="Feeds">
      <outline type="rss" text="Normal Feed" title="Normal Feed" xmlUrl="https://example.com/rss" htmlUrl="https://example.com"/>
      <outline type="rss" text="Feedly Web" title="Feedly Web" xmlUrl="https://feedly.com/web/ea9aa059-f633-4ca4-8b09-9dc0758df8fb" htmlUrl="https://feedly.com"/>
      <outline type="rss" text="Feedly Proxy" title="Feedly Proxy" xmlUrl="https://feedproxy.feedly.com/c14ea2c6-3252-417c-93ba-7e3b236abc" htmlUrl="https://feedly.com"/>
      <outline type="rss" text="Feedly Alert" title="Feedly Alert" xmlUrl="https://feedly.com/f/alert/11293ed8-4f5f-465a-aee4-b45bdb309abc" htmlUrl="https://feedly.com"/>
    </outline>
  </body>
</opml>`

const WITH_MISSING_XMLURL_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Mixed subscriptions</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="TechCrunch" title="TechCrunch" xmlUrl="https://techcrunch.com/feed/" htmlUrl="https://techcrunch.com"/>
      <outline text="Group Header Only" title="Group Header Only"/>
      <outline type="rss" text="Empty URL Feed" title="Empty URL Feed" xmlUrl="" htmlUrl="https://empty.com"/>
    </outline>
  </body>
</opml>`

const EMPTY_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Empty</title></head>
  <body></body>
</opml>`

function buildLargeOpml(feedCount: number): string {
  const feeds = Array.from(
    { length: feedCount },
    (_, i) =>
      `      <outline type="rss" text="Feed ${i}" title="Feed ${i}" xmlUrl="https://feed${i}.example.com/rss" htmlUrl="https://feed${i}.example.com"/>`
  ).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Large export</title></head>
  <body>
    <outline text="All Feeds" title="All Feeds">
${feeds}
    </outline>
  </body>
</opml>`
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function setupAuth(userId = "user-123") {
  vi.mocked(requireAuth).mockResolvedValue({ userId, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupNoAuth() {
  vi.mocked(requireAuth).mockResolvedValue(
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) as any
  )
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

// ---------------------------------------------------------------------------
// parseOpml — pure function tests (no mocks)
// ---------------------------------------------------------------------------

describe("parseOpml", () => {
  it("AC-1: extracts feed entries with name, xmlUrl, htmlUrl from standard OPML XML", () => {
    const feeds = parseOpml(GROUPED_OPML)

    expect(feeds.length).toBeGreaterThanOrEqual(3)

    const tc = feeds.find((f) => f.xmlUrl === "https://techcrunch.com/feed/")
    expect(tc).toBeDefined()
    expect(tc!.name).toBe("TechCrunch")
    expect(tc!.xmlUrl).toBe("https://techcrunch.com/feed/")
    expect(tc!.htmlUrl).toBe("https://techcrunch.com")
  })

  it("AC-2: extracts group names from parent outline elements and assigns to each feed as `group` field", () => {
    const feeds = parseOpml(GROUPED_OPML)

    const techFeeds = feeds.filter((f) => f.group === "Tech")
    expect(techFeeds.length).toBe(2)
    expect(techFeeds.map((f) => f.xmlUrl)).toContain("https://techcrunch.com/feed/")
    expect(techFeeds.map((f) => f.xmlUrl)).toContain("https://www.theverge.com/rss/index.xml")

    const socialFeeds = feeds.filter((f) => f.group === "Social")
    expect(socialFeeds.length).toBe(1)
    expect(socialFeeds[0].xmlUrl).toBe("https://www.socialmediatoday.com/feed/")
  })

  it("AC-3: marks feedly.com/web/* URLs with isFeedlySpecific: true", () => {
    const feeds = parseOpml(FEEDLY_OPML)

    const webFeed = feeds.find((f) => f.xmlUrl.startsWith("https://feedly.com/web/"))
    expect(webFeed).toBeDefined()
    expect(webFeed!.isFeedlySpecific).toBe(true)
  })

  it("AC-3: marks feedproxy.feedly.com/* and feedly.com/f/alert/* URLs with isFeedlySpecific: true", () => {
    const feeds = parseOpml(FEEDLY_OPML)

    const proxyFeed = feeds.find((f) => f.xmlUrl.startsWith("https://feedproxy.feedly.com/"))
    expect(proxyFeed).toBeDefined()
    expect(proxyFeed!.isFeedlySpecific).toBe(true)

    const alertFeed = feeds.find((f) => f.xmlUrl.startsWith("https://feedly.com/f/alert/"))
    expect(alertFeed).toBeDefined()
    expect(alertFeed!.isFeedlySpecific).toBe(true)

    // Normal feeds must NOT be flagged
    const normalFeed = feeds.find((f) => f.xmlUrl === "https://example.com/rss")
    expect(normalFeed).toBeDefined()
    expect(normalFeed!.isFeedlySpecific).toBe(false)
  })

  it("AC-4: skips entries without xmlUrl (group headers, empty outlines)", () => {
    const feeds = parseOpml(WITH_MISSING_XMLURL_OPML)

    // Only the entry with a real xmlUrl should be returned
    expect(feeds.length).toBe(1)
    expect(feeds[0].xmlUrl).toBe("https://techcrunch.com/feed/")
  })

  it("AC-5: handles flat OPML (feeds without group wrappers)", () => {
    const feeds = parseOpml(FLAT_OPML)

    expect(feeds.length).toBe(2)
    const hn = feeds.find((f) => f.xmlUrl === "https://news.ycombinator.com/rss")
    expect(hn).toBeDefined()
    expect(hn!.name).toBe("Hacker News")
    // Flat feeds have no group
    expect(hn!.group).toBeUndefined()
  })

  it("EC-1: returns empty array for empty/minimal OPML with no feeds", () => {
    const feeds = parseOpml(EMPTY_OPML)

    expect(feeds).toEqual([])
  })

  it("EC-2: throws a descriptive error for malformed XML", () => {
    const malformedXml = `<?xml version="1.0"?><opml><body><outline text="broken"`

    expect(() => parseOpml(malformedXml)).toThrow()
    // Error should be descriptive (message should exist)
    try {
      parseOpml(malformedXml)
    } catch (err) {
      expect(err instanceof Error).toBe(true)
      expect((err as Error).message.length).toBeGreaterThan(0)
    }
  })

  it("ERR-1: throws on completely invalid input (not XML at all)", () => {
    expect(() => parseOpml("this is not xml at all !!!")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// POST /api/feeds/import-opml — API route tests (with mocks)
// ---------------------------------------------------------------------------

describe("POST /api/feeds/import-opml", () => {
  beforeEach(() => vi.clearAllMocks())

  it("AC-10: returns 401 when request has no session", async () => {
    setupNoAuth()

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: GROUPED_OPML,
    })

    const res = await POST(req)

    expect(res.status).toBe(401)
  })

  it("AC-6: creates RSS sources from parsed OPML feeds", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 2 })

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: FLAT_OPML,
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(db.feed.createMany).toHaveBeenCalledTimes(1)
    // createMany data should contain both feeds
    const createManyCall = vi.mocked(db.feed.createMany).mock.calls[0][0] as any
    expect(createManyCall.data).toHaveLength(2)
    expect(body.created).toBe(2)
  })

  it("AC-7: skips duplicate sources (existing userId+url)", async () => {
    setupAuth()
    // First findMany: existing sources for dedup. Second findMany: fetch created IDs for covers.
    vi.mocked(db.feed.findMany)
      .mockResolvedValueOnce([{ url: "https://techcrunch.com/feed/" } as any])
      .mockResolvedValueOnce([])
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 2 })

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: GROUPED_OPML,
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    // TechCrunch already exists — should be skipped
    expect(body.skipped).toBeGreaterThanOrEqual(1)
    // createMany data should NOT contain the existing URL
    const createManyCall = vi.mocked(db.feed.createMany).mock.calls[0][0] as any
    const urls = createManyCall.data.map((d: any) => d.url)
    expect(urls).not.toContain("https://techcrunch.com/feed/")
  })

  it("AC-8: stores group name in source tags field", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 3 })

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: GROUPED_OPML,
    })

    await POST(req)

    // createMany data should include tags with group name
    const createManyCall = vi.mocked(db.feed.createMany).mock.calls[0][0] as any
    const techCrunchEntry = createManyCall.data.find(
      (d: any) => d.url === "https://techcrunch.com/feed/"
    )
    expect(techCrunchEntry).toBeDefined()
    expect(techCrunchEntry.tags).toContain("Tech")
  })

  it("AC-9: returns structured response {created, skipped, failed, feedlySpecific, groups}", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 3 })

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: GROUPED_OPML,
    })

    const res = await POST(req)
    const body = await res.json()

    expect(typeof body.created).toBe("number")
    expect(typeof body.skipped).toBe("number")
    expect(typeof body.failed).toBe("number")
    expect(typeof body.feedlySpecific).toBe("number")
    expect(Array.isArray(body.groups)).toBe(true)
  })

  it("EC-3: handles OPML with 200+ feeds without error", async () => {
    setupAuth()
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.feed.createMany).mockResolvedValue({ count: 220 })

    const largeOpml = buildLargeOpml(220)

    const req = new NextRequest("http://localhost/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: largeOpml,
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.created).toBe(220)
  })
})
