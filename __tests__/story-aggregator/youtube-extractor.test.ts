import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isYouTubeUrl,
  extractVideoId,
  extractContentFromYouTube,
  extractContentFromUrl,
} from "@/lib/story-aggregator/content-extractor"

// ---------------------------------------------------------------------------
// Mock youtube-transcript
// ---------------------------------------------------------------------------

vi.mock("youtube-transcript-plus", () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
}))

async function getMockedTranscript() {
  const { YoutubeTranscript } = await import("youtube-transcript-plus")
  return vi.mocked(YoutubeTranscript.fetchTranscript)
}

// ---------------------------------------------------------------------------
// isYouTubeUrl()
// ---------------------------------------------------------------------------

describe("isYouTubeUrl", () => {
  it("recognises youtube.com/watch URLs", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true)
  })

  it("recognises youtu.be short URLs", () => {
    expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true)
  })

  it("recognises /shorts/ URLs", () => {
    expect(isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true)
  })

  it("recognises /live/ URLs", () => {
    expect(isYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(true)
  })

  it("recognises m.youtube.com (mobile) URLs", () => {
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true)
  })

  it("recognises URLs with extra query params after v=", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s")).toBe(true)
  })

  it("rejects non-YouTube URLs", () => {
    expect(isYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBe(false)
    expect(isYouTubeUrl("https://vimeo.com/123456")).toBe(false)
    expect(isYouTubeUrl("https://x.com/user/status/123")).toBe(false)
  })

  it("rejects YouTube URLs without a video ID", () => {
    expect(isYouTubeUrl("https://www.youtube.com/channel/UCxxxx")).toBe(false)
    expect(isYouTubeUrl("https://www.youtube.com/")).toBe(false)
  })

  it("is case-insensitive for the domain", () => {
    expect(isYouTubeUrl("HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractVideoId()
// ---------------------------------------------------------------------------

describe("extractVideoId", () => {
  it("extracts ID from youtube.com/watch?v= URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })

  it("extracts ID from youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/abc123DEF_-")).toBe("abc123DEF_-")
  })

  it("extracts ID from /shorts/ URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })

  it("extracts ID from /live/ URL", () => {
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })

  it("extracts ID from URL with extra query params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx")).toBe("dQw4w9WgXcQ")
  })

  it("returns null for non-YouTube URLs", () => {
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull()
  })

  it("returns null for YouTube URLs without video ID", () => {
    expect(extractVideoId("https://www.youtube.com/channel/UCxxxx")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(extractVideoId("")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractContentFromYouTube()
// ---------------------------------------------------------------------------

describe("extractContentFromYouTube", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("combines metadata and transcript into ExtractedContent", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Hello everyone", duration: 3, offset: 0 },
      { text: "welcome to the video", duration: 4, offset: 3 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Amazing Video",
          author_name: "Cool Channel",
          thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.title).toBe("Amazing Video — Cool Channel")
    expect(result.content).toContain("Video: Amazing Video")
    expect(result.content).toContain("Channel: Cool Channel")
    expect(result.content).toContain("Transcript:")
    expect(result.content).toContain("Hello everyone")
    expect(result.content).toContain("welcome to the video")
    expect(result.ogImage).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg")
    expect(result.author).toBe("Cool Channel")
  })

  it("falls back gracefully when transcript is unavailable", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockRejectedValueOnce(new Error("Transcript disabled"))

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Private Video",
          author_name: "Some Channel",
          thumbnail_url: "https://i.ytimg.com/vi/xyz/hqdefault.jpg",
        }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.title).toBe("Private Video — Some Channel")
    expect(result.content).toContain("Video: Private Video")
    expect(result.content).toContain("Channel: Some Channel")
    expect(result.content).toContain("Video content without available transcript.")
    expect(result.content).not.toContain("Transcript:")
    expect(result.author).toBe("Some Channel")
  })

  it("falls back when transcript returns empty segments", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "No Captions Video",
          author_name: "Channel",
        }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.content).toContain("Video content without available transcript.")
  })

  it("truncates transcript to YOUTUBE_TRANSCRIPT_MAX_LENGTH (12000 chars)", async () => {
    const mockTranscript = await getMockedTranscript()
    const longText = "word ".repeat(5000) // ~25000 chars
    mockTranscript.mockResolvedValueOnce([{ text: longText, duration: 100, offset: 0 }])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Long Talk", author_name: "Speaker" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.content).not.toBeNull()
    // The transcript portion should be truncated — total content should be reasonable
    // Header (~30 chars) + "Transcript:\n" (~12 chars) + truncated text (~12003 chars)
    expect(result.content!.length).toBeLessThan(13000)
  })

  it("returns all nulls for non-YouTube URL", async () => {
    const result = await extractContentFromYouTube("https://example.com/video")

    expect(result).toEqual({
      title: null,
      content: null,
      ogImage: null,
      author: null,
    })
  })

  it("produces transcript-only content when oEmbed fails but transcript succeeds", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Transcript without metadata", duration: 5, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.title).toBeNull()
    expect(result.content).toContain("Transcript:")
    expect(result.content).toContain("Transcript without metadata")
    expect(result.content).not.toContain("Video:")
    expect(result.content).not.toContain("Channel:")
    expect(result.ogImage).toBeNull()
    expect(result.author).toBeNull()
  })

  it("returns all nulls when both metadata and transcript fail", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockRejectedValueOnce(new Error("fail"))

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    // Even with failed metadata, should have fallback content
    expect(result.content).toContain("Video content without available transcript.")
  })

  it("never throws — catches all errors gracefully", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockRejectedValueOnce(new Error("catastrophic"))

    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"))

    await expect(
      extractContentFromYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).resolves.not.toThrow()
  })

  it("cleans HTML entities from transcript text", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Tom &amp; Jerry&#39;s &quot;show&quot; is &lt;great&gt;", duration: 5, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Cartoon", author_name: "TV" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.content).toContain("Tom & Jerry's \"show\" is <great>")
    expect(result.content).not.toContain("&amp;")
    expect(result.content).not.toContain("&#39;")
  })

  it("decodes numeric and hex HTML entities from transcript text", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Price&#58; &#x24;100 and&nbsp;more", duration: 5, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Prices", author_name: "Shop" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.content).toContain("Price: $100 and more")
    expect(result.content).not.toContain("&#58;")
    expect(result.content).not.toContain("&#x24;")
    expect(result.content).not.toContain("&nbsp;")
  })

  it("uses title without author when author is missing", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Some transcript", duration: 3, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Standalone Video" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.title).toBe("Standalone Video")
    expect(result.author).toBeNull()
  })

  it("handles youtu.be short URLs", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Short URL transcript", duration: 3, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Short URL Video", author_name: "Channel" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromYouTube("https://youtu.be/dQw4w9WgXcQ")

    expect(result.title).toBe("Short URL Video — Channel")
    expect(result.content).toContain("Short URL transcript")
  })
})

// ---------------------------------------------------------------------------
// extractContentFromUrl() — YouTube routing
// ---------------------------------------------------------------------------

describe("extractContentFromUrl — YouTube routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("routes YouTube URLs to YouTube extractor instead of Readability", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Routed transcript", duration: 3, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Routed Video",
          author_name: "Test Channel",
          thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    expect(result.content).toContain("Routed transcript")
    expect(result.title).toBe("Routed Video — Test Channel")
    expect(result.author).toBe("Test Channel")
  })

  it("routes youtu.be URLs to YouTube extractor", async () => {
    const mockTranscript = await getMockedTranscript()
    mockTranscript.mockResolvedValueOnce([
      { text: "Short link transcript", duration: 3, offset: 0 },
    ])

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Short Link Video", author_name: "Channel" }),
        { status: 200 },
      ),
    )

    const result = await extractContentFromUrl("https://youtu.be/dQw4w9WgXcQ")

    expect(result.content).toContain("Short link transcript")
  })

  it("does not route non-YouTube URLs to YouTube extractor", async () => {
    const html = `<!DOCTYPE html><html><head><title>Normal</title></head><body><article><p>Normal article content that is long enough for Readability to parse.</p><p>More content here.</p></article></body></html>`

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.content).not.toContain("Transcript:")
    expect(result.content).not.toContain("Video content without available transcript.")
  })
})
