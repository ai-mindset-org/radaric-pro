/**
 * Source Cover Auto-Fetch
 *
 * Tests for lib/feed-cover.ts.
 *
 * Spec coverage:
 *   AC-1: fetchSourceCover() for RSS fetches og:image from source URL HTML
 *   AC-2: fetchSourceCover() falls back to twitter:image when og:image absent
 *   AC-3: fetchSourceCover() returns null for EVENT_TRIGGER without network request
 *   AC-4: fetchSourceCover() for TELEGRAM calls worker channel-info endpoint
 *   AC-5: fetchSourceCover() returns null when no OG/twitter image found in HTML
 *   AC-6: saveSourceCover() does NOT overwrite coverUrl already set in DB
 *   AC-7: saveSourceCover() updates coverUrl in DB when fetch succeeds and DB has null
 *   EC-1: fetchSourceCover() resolves relative OG image URLs to absolute
 *   EC-2: fetchSourceCover() returns null on network error without throwing
 *   ERR-1: fetchSourceCover() returns null for og:image with empty/invalid content attribute
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchSourceCover, saveSourceCover } from "@/lib/feed-cover"

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// ---------------------------------------------------------------------------
// Mock Prisma DB client
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { db } from "@/lib/db"

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function htmlWithOgImage(url: string) {
  return `<html><head><meta property="og:image" content="${url}"></head><body></body></html>`
}

function htmlWithTwitterImage(url: string) {
  return `<html><head><meta name="twitter:image" content="${url}"></head><body></body></html>`
}

function htmlWithNoImage() {
  return `<html><head><title>No images here</title></head><body></body></html>`
}

function htmlWithEmptyOgImage() {
  return `<html><head><meta property="og:image" content=""></head><body></body></html>`
}

function mockHtmlFetch(html: string, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(html.length) }),
    text: () => Promise.resolve(html),
  })
}

// ---------------------------------------------------------------------------
// AC-1: fetchSourceCover — RSS source fetches og:image
// ---------------------------------------------------------------------------

describe("fetchSourceCover — AC-1: fetches og:image from RSS source HTML", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-1: returns og:image URL from HTML for an RSS source", async () => {
    mockHtmlFetch(htmlWithOgImage("https://example.com/cover.jpg"))

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBe("https://example.com/cover.jpg")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/feed",
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// YOUTUBE (RAD-267): channel page og:image = channel avatar
// ---------------------------------------------------------------------------

describe("fetchSourceCover — YOUTUBE fetches og:image from the channel page", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("returns og:image (channel avatar) from the canonical channel URL", async () => {
    mockHtmlFetch(htmlWithOgImage("https://yt3.googleusercontent.com/avatar.jpg"))

    const result = await fetchSourceCover({
      type: "YOUTUBE",
      url: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
    })

    expect(result).toBe("https://yt3.googleusercontent.com/avatar.jpg")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// AC-2: fetchSourceCover — falls back to twitter:image
// ---------------------------------------------------------------------------

describe("fetchSourceCover — AC-2: falls back to twitter:image when og:image absent", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-2: returns twitter:image URL when og:image meta tag is not present", async () => {
    mockHtmlFetch(htmlWithTwitterImage("https://example.com/twitter-cover.jpg"))

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBe("https://example.com/twitter-cover.jpg")
  })
})

// ---------------------------------------------------------------------------
// AC-3: fetchSourceCover — EVENT_TRIGGER returns null without network request
// ---------------------------------------------------------------------------

describe("fetchSourceCover — AC-3: returns null for EVENT_TRIGGER without network call", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-3: returns null immediately for EVENT_TRIGGER source type", async () => {
    const result = await fetchSourceCover({
      type: "EVENT_TRIGGER",
      url: "https://example.com/trigger",
    })

    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC-4: fetchSourceCover — TELEGRAM calls worker channel-info endpoint
// ---------------------------------------------------------------------------

describe("fetchSourceCover — AC-4: fetches Telegram channel photo via worker endpoint", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-4: calls worker /telegram/channel-info with includePhoto=true and returns photo URL", async () => {
    const photoUrl = "https://r2.example.com/telegram/channel-photo.jpg"

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ photoUrl }),
    })

    const result = await fetchSourceCover({
      type: "TELEGRAM",
      url: "https://t.me/mychannel",
    })

    expect(result).toBe(photoUrl)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/telegram/channel-info"),
      expect.anything()
    )
    const calledUrl: string = mockFetch.mock.calls[0][0]
    expect(calledUrl).toContain("includePhoto=true")
    expect(calledUrl).toContain("username=mychannel")
  })
})

// ---------------------------------------------------------------------------
// AC-5: fetchSourceCover — returns null when no OG/twitter image in HTML
// ---------------------------------------------------------------------------

describe("fetchSourceCover — AC-5: returns null when HTML has no OG or twitter:image", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-5: returns null for HTML that contains no og:image or twitter:image meta tags", async () => {
    mockHtmlFetch(htmlWithNoImage())

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC-6: saveSourceCover — does NOT overwrite existing coverUrl
// ---------------------------------------------------------------------------

describe("saveSourceCover — AC-6: does not overwrite user-set coverUrl", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-6: skips DB update when source already has a coverUrl set", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValueOnce({
      id: "src-1",
      type: "RSS",
      url: "https://example.com/feed",
      coverUrl: "https://example.com/user-set-cover.jpg",
    } as any)

    await saveSourceCover("src-1")

    // Must have read the source from DB first (re-read guard)
    expect(db.feed.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "src-1" } })
    )
    // Must NOT have overwritten the existing cover
    expect(db.feed.update).not.toHaveBeenCalled()
    // No network fetch should have happened
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC-7: saveSourceCover — updates coverUrl in DB when fetch succeeds
// ---------------------------------------------------------------------------

describe("saveSourceCover — AC-7: updates coverUrl in DB when fetch succeeds and DB has null", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("AC-7: fetches cover and updates DB when source coverUrl is null", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValueOnce({
      id: "src-2",
      type: "RSS",
      url: "https://example.com/feed",
      coverUrl: null,
    } as any)

    mockHtmlFetch(htmlWithOgImage("https://example.com/new-cover.jpg"))

    vi.mocked(db.feed.update).mockResolvedValueOnce({} as any)

    await saveSourceCover("src-2")

    expect(db.feed.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "src-2" },
        data: expect.objectContaining({
          coverUrl: "https://example.com/new-cover.jpg",
        }),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// EC-1: fetchSourceCover — resolves relative OG image URLs to absolute
// ---------------------------------------------------------------------------

describe("fetchSourceCover — EC-1: resolves relative OG image URLs to absolute", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("EC-1: converts relative og:image path to absolute URL using source URL as base", async () => {
    mockHtmlFetch(
      `<html><head><meta property="og:image" content="/images/og.png"></head><body></body></html>`
    )

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBe("https://example.com/images/og.png")
  })
})

// ---------------------------------------------------------------------------
// EC-2: fetchSourceCover — returns null on network error without throwing
// ---------------------------------------------------------------------------

describe("fetchSourceCover — EC-2: returns null on network failure without throwing", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("EC-2: returns null when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBeNull()
  })

  it("EC-2: returns null when source URL returns non-200 status", async () => {
    mockHtmlFetch("<html><body>Not found</body></html>", 404)

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ERR-1: fetchSourceCover — returns null for empty or invalid og:image content
// ---------------------------------------------------------------------------

describe("fetchSourceCover — ERR-1: returns null for empty og:image content attribute", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("ERR-1: returns null when og:image content attribute is an empty string", async () => {
    mockHtmlFetch(htmlWithEmptyOgImage())

    const result = await fetchSourceCover({
      type: "RSS",
      url: "https://example.com/feed",
    })

    expect(result).toBeNull()
  })
})
