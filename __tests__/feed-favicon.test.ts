/**
 * Source Favicon Auto-Fetch — unit tests.
 *
 * Coverage:
 *   pickFaviconFromHtml (pure parser):
 *     - prefers apple-touch-icon over rel=icon
 *     - falls back to rel="icon" then rel="shortcut icon"
 *     - resolves relative hrefs against the base URL
 *     - returns null when no icon link is declared
 *   fetchSourceFavicon:
 *     - returns null (no network) for TELEGRAM / TWITTER (generic platform favicon)
 *     - returns null for non-http urls (Parallel monitors)
 *     - returns a declared favicon for a web/RSS source
 *     - falls back to /favicon.ico (verified image) when none declared
 *     - returns null when no favicon exists anywhere
 *   saveSourceFavicon:
 *     - does NOT overwrite an existing faviconUrl
 *     - updates faviconUrl when DB has null and a favicon is found
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { pickFaviconFromHtml, fetchSourceFavicon, saveSourceFavicon } from "@/lib/feed-favicon"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { db } from "@/lib/db"

function htmlResponse(html: string): Response {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => html,
  } as unknown as Response
}

function icoResponse(contentType: string | null, ok = true): Response {
  return {
    ok,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => "",
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("pickFaviconFromHtml", () => {
  it("prefers apple-touch-icon over rel=icon", () => {
    const html = `
      <link rel="icon" href="/favicon.png">
      <link rel="apple-touch-icon" href="/touch.png">
    `
    expect(pickFaviconFromHtml(html, "https://example.com")).toBe("https://example.com/touch.png")
  })

  it("falls back to rel=\"icon\" when no apple-touch-icon", () => {
    const html = `<link rel="icon" type="image/png" href="/favicon-32.png">`
    expect(pickFaviconFromHtml(html, "https://example.com")).toBe(
      "https://example.com/favicon-32.png"
    )
  })

  it("matches rel=\"shortcut icon\"", () => {
    const html = `<link rel="shortcut icon" href="https://cdn.example.com/fav.ico">`
    expect(pickFaviconFromHtml(html, "https://example.com")).toBe(
      "https://cdn.example.com/fav.ico"
    )
  })

  it("resolves relative hrefs against the base URL", () => {
    const html = `<link rel="icon" href="assets/icon.svg">`
    expect(pickFaviconFromHtml(html, "https://example.com/blog/")).toBe(
      "https://example.com/blog/assets/icon.svg"
    )
  })

  it("returns null when no icon link is declared", () => {
    expect(pickFaviconFromHtml(`<title>No icons here</title>`, "https://example.com")).toBeNull()
  })
})

describe("fetchSourceFavicon", () => {
  it("returns null without any network call for TELEGRAM", async () => {
    expect(await fetchSourceFavicon({ type: "TELEGRAM", url: "https://t.me/foo" })).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns null without any network call for TWITTER", async () => {
    expect(await fetchSourceFavicon({ type: "TWITTER", url: "https://x.com/foo" })).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns null without any network call for YOUTUBE (generic platform favicon)", async () => {
    expect(
      await fetchSourceFavicon({ type: "YOUTUBE", url: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ" })
    ).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns null for non-http urls (Parallel monitors)", async () => {
    expect(
      await fetchSourceFavicon({ type: "EVENT_TRIGGER", url: "parallel://monitor/abc" })
    ).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns the declared favicon for a web source", async () => {
    mockFetch.mockResolvedValueOnce(
      htmlResponse(`<link rel="apple-touch-icon" href="/touch.png">`)
    )
    const result = await fetchSourceFavicon({ type: "RSS", url: "https://news.example.com/" })
    expect(result).toBe("https://news.example.com/touch.png")
  })

  it("falls back to /favicon.ico when none declared and it is an image", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(`<title>no icon link</title>`)) // homepage HTML
      .mockResolvedValueOnce(icoResponse("image/x-icon")) // favicon.ico HEAD/GET
    const result = await fetchSourceFavicon({ type: "RSS", url: "https://news.example.com/" })
    expect(result).toBe("https://news.example.com/favicon.ico")
  })

  it("returns null when /favicon.ico is not an image", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(`<title>no icon link</title>`))
      .mockResolvedValueOnce(icoResponse("text/html")) // 404 page served as HTML
    const result = await fetchSourceFavicon({ type: "RSS", url: "https://news.example.com/" })
    expect(result).toBeNull()
  })
})

describe("saveSourceFavicon", () => {
  it("does NOT overwrite an existing faviconUrl", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValue({
      id: "s1",
      type: "RSS",
      url: "https://news.example.com/",
      faviconUrl: "https://news.example.com/already.png",
    } as never)

    await saveSourceFavicon("s1")

    expect(db.feed.update).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("updates faviconUrl when DB has null and a favicon is found", async () => {
    vi.mocked(db.feed.findUnique).mockResolvedValue({
      id: "s1",
      type: "RSS",
      url: "https://news.example.com/",
      faviconUrl: null,
    } as never)
    mockFetch.mockResolvedValueOnce(
      htmlResponse(`<link rel="icon" href="/favicon-32.png">`)
    )

    await saveSourceFavicon("s1")

    expect(db.feed.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { faviconUrl: "https://news.example.com/favicon-32.png" },
    })
  })
})
