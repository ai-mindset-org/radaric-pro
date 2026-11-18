import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  extractChannelId,
  resolveYouTubeChannel,
  YouTubeResolveError,
  youtubeChannelUrl,
  youtubeFeedUrl,
} from "@/lib/youtube"
import { normalizeYouTubeInput } from "@/lib/validations/feed"

const UC = "UCBJycsmduvYEL83R_U4JriQ" // 24 chars, UC + 22

// ---------------------------------------------------------------------------
// extractChannelId() — pure
// ---------------------------------------------------------------------------

describe("extractChannelId", () => {
  it("extracts from canonical /channel/ URLs", () => {
    expect(extractChannelId(`https://www.youtube.com/channel/${UC}`)).toBe(UC)
  })

  it("extracts from /channel/ URLs with trailing path/query", () => {
    expect(extractChannelId(`https://www.youtube.com/channel/${UC}/videos`)).toBe(UC)
    expect(extractChannelId(`https://youtube.com/channel/${UC}?view=0`)).toBe(UC)
  })

  it("extracts from feed XML URLs", () => {
    expect(extractChannelId(`https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`)).toBe(UC)
  })

  it("extracts from protocol-less and mobile forms", () => {
    expect(extractChannelId(`youtube.com/channel/${UC}`)).toBe(UC)
    expect(extractChannelId(`https://m.youtube.com/channel/${UC}`)).toBe(UC)
  })

  it("returns null for handle URLs, video URLs, and non-YouTube input", () => {
    expect(extractChannelId("https://www.youtube.com/@mkbhd")).toBeNull()
    expect(extractChannelId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull()
    expect(extractChannelId("https://example.com/channel/" + UC)).toBeNull()
    expect(extractChannelId("")).toBeNull()
  })

  it("rejects malformed channel ids", () => {
    expect(extractChannelId("https://www.youtube.com/channel/UCshort")).toBeNull()
    expect(extractChannelId("https://www.youtube.com/channel/XX" + "a".repeat(22))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// youtubeChannelUrl() / youtubeFeedUrl() — pure builders
// ---------------------------------------------------------------------------

describe("URL builders", () => {
  it("builds the canonical channel URL", () => {
    expect(youtubeChannelUrl(UC)).toBe(`https://www.youtube.com/channel/${UC}`)
  })

  it("builds the feed XML URL", () => {
    expect(youtubeFeedUrl(UC)).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`)
  })
})

// ---------------------------------------------------------------------------
// normalizeYouTubeInput() — pure pre-normalization (form/API)
// ---------------------------------------------------------------------------

describe("normalizeYouTubeInput", () => {
  it("normalizes @handle and bare handle to the handle URL", () => {
    expect(normalizeYouTubeInput("@mkbhd")).toBe("https://www.youtube.com/@mkbhd")
    expect(normalizeYouTubeInput("mkbhd")).toBe("https://www.youtube.com/@mkbhd")
  })

  it("normalizes handle URLs in any paste format", () => {
    expect(normalizeYouTubeInput("youtube.com/@mkbhd")).toBe("https://www.youtube.com/@mkbhd")
    expect(normalizeYouTubeInput("https://www.youtube.com/@mkbhd")).toBe("https://www.youtube.com/@mkbhd")
    expect(normalizeYouTubeInput("https://m.youtube.com/@mkbhd")).toBe("https://www.youtube.com/@mkbhd")
    expect(normalizeYouTubeInput("http://youtube.com/@mkbhd/videos?si=abc")).toBe("https://www.youtube.com/@mkbhd")
  })

  it("normalizes /channel/ URLs to the canonical form", () => {
    expect(normalizeYouTubeInput(`youtube.com/channel/${UC}`)).toBe(`https://www.youtube.com/channel/${UC}`)
    expect(normalizeYouTubeInput(`https://www.youtube.com/channel/${UC}/videos`)).toBe(
      `https://www.youtube.com/channel/${UC}`
    )
  })

  it("converts feed XML URLs to the canonical channel URL", () => {
    expect(normalizeYouTubeInput(`https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`)).toBe(
      `https://www.youtube.com/channel/${UC}`
    )
  })

  it("passes legacy /c/ and /user/ URLs through https-normalized", () => {
    expect(normalizeYouTubeInput("youtube.com/c/SomeName")).toBe("https://www.youtube.com/c/SomeName")
    expect(normalizeYouTubeInput("https://www.youtube.com/user/SomeName")).toBe(
      "https://www.youtube.com/user/SomeName"
    )
  })

  it("passes video URLs through https-normalized, preserving the video id", () => {
    expect(normalizeYouTubeInput("youtu.be/dQw4w9WgXcQ")).toBe("https://youtu.be/dQw4w9WgXcQ")
    expect(normalizeYouTubeInput("youtube.com/watch?v=dQw4w9WgXcQ&t=1s")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s"
    )
  })

  it("rejects non-YouTube URLs, playlists, and empty input", () => {
    expect(normalizeYouTubeInput("https://example.com/@mkbhd")).toBeNull()
    expect(normalizeYouTubeInput("vimeo.com/123")).toBeNull()
    expect(normalizeYouTubeInput("")).toBeNull()
    expect(normalizeYouTubeInput("   ")).toBeNull()
    // Playlists are out of scope for v1
    expect(normalizeYouTubeInput("https://www.youtube.com/playlist?list=PLx")).toBeNull()
    expect(
      normalizeYouTubeInput("https://www.youtube.com/feeds/videos.xml?playlist_id=PLx")
    ).toBeNull()
  })

  it("rejects domain-shaped bare input that isn't YouTube", () => {
    expect(normalizeYouTubeInput("example.com")).toBeNull()
  })

  it("accepts dotted handles only with the @ prefix", () => {
    expect(normalizeYouTubeInput("@marques.brownlee")).toBe("https://www.youtube.com/@marques.brownlee")
    expect(normalizeYouTubeInput("marques.brownlee")).toBeNull() // ambiguous with a domain
  })
})

// ---------------------------------------------------------------------------
// resolveYouTubeChannel() — network resolution (mocked fetch)
// ---------------------------------------------------------------------------

function channelPageHtml(id: string, title = "Marques Brownlee") {
  return `<html><head>
    <meta property="og:title" content="${title}">
    <meta property="og:url" content="https://www.youtube.com/channel/${id}">
    <link rel="canonical" href="https://www.youtube.com/channel/${id}">
    <meta itemprop="identifier" content="${id}">
  </head><body></body></html>`
}

describe("resolveYouTubeChannel", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fast-paths canonical /channel/ URLs without network", async () => {
    const result = await resolveYouTubeChannel(`https://www.youtube.com/channel/${UC}`)
    expect(result).toEqual({ channelId: UC, channelUrl: youtubeChannelUrl(UC), title: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fast-paths feed XML URLs without network", async () => {
    const result = await resolveYouTubeChannel(`https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`)
    expect(result.channelId).toBe(UC)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves @handle URLs by fetching the channel page (og:url)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => channelPageHtml(UC),
    })
    const result = await resolveYouTubeChannel("https://www.youtube.com/@mkbhd")
    expect(result).toEqual({ channelId: UC, channelUrl: youtubeChannelUrl(UC), title: "Marques Brownlee" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://www.youtube.com/@mkbhd")
  })

  it("falls back to itemprop identifier when og:url/canonical are absent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        `<html><head><meta itemprop="identifier" content="${UC}"></head></html>`,
    })
    const result = await resolveYouTubeChannel("https://www.youtube.com/@mkbhd")
    expect(result.channelId).toBe(UC)
    expect(result.title).toBeNull()
  })

  it("resolves video URLs via oEmbed author_url → channel page", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          title: "Some Video",
          author_name: "Marques Brownlee",
          author_url: "https://www.youtube.com/@mkbhd",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => channelPageHtml(UC),
      })
    const result = await resolveYouTubeChannel("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    expect(result.channelId).toBe(UC)
    expect(result.title).toBe("Marques Brownlee")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain("oembed")
  })

  it("throws YouTubeResolveError when the page has no channel id", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "<html><head></head></html>" })
    await expect(resolveYouTubeChannel("https://www.youtube.com/@nosuchchannel")).rejects.toBeInstanceOf(
      YouTubeResolveError
    )
  })

  it("throws YouTubeResolveError on HTTP failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await expect(resolveYouTubeChannel("https://www.youtube.com/@gone")).rejects.toBeInstanceOf(
      YouTubeResolveError
    )
  })

  it("throws YouTubeResolveError for un-normalizable input", async () => {
    await expect(resolveYouTubeChannel("https://example.com/whatever")).rejects.toBeInstanceOf(
      YouTubeResolveError
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("decodes HTML entities in the extracted title", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => channelPageHtml(UC, "Tom &amp; Jerry&#39;s Channel"),
    })
    const result = await resolveYouTubeChannel("https://www.youtube.com/@tomjerry")
    expect(result.title).toBe("Tom & Jerry's Channel")
  })
})
