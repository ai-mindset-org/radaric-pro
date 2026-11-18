import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  isTweetUrl,
  toFixTweetApiUrl,
  extractContentFromTweet,
  truncateContent,
  extractContentFromText,
  extractContentFromUrl,
} from "@/lib/story-aggregator/content-extractor"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a string of exactly `n` characters using repeating words. */
function makeText(chars: number, word = "hello"): string {
  const unit = word + " "
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

/**
 * Returns a minimal but valid HTML page string.
 * Readability needs enough structure to extract an article.
 */
function makeHtmlPage({
  title = "Test Article Title",
  body = "<p>This is the article body with enough content for Readability to parse it properly.</p><p>Second paragraph adds more context to the story so Readability is confident this is real content.</p>",
  ogImage = null as string | null,
  author = null as string | null,
  contentType = "text/html",
}: {
  title?: string
  body?: string
  ogImage?: string | null
  author?: string | null
  contentType?: string
} = {}): string {
  const ogImageMeta = ogImage
    ? `<meta property="og:image" content="${ogImage}" />`
    : ""
  const authorMeta = author
    ? `<meta name="author" content="${author}" />`
    : ""
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  ${ogImageMeta}
  ${authorMeta}
</head>
<body>
  <article>
    <h1>${title}</h1>
    ${body}
  </article>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// isTweetUrl()
// ---------------------------------------------------------------------------

describe("isTweetUrl", () => {
  it("recognises x.com status URLs", () => {
    expect(isTweetUrl("https://x.com/elonmusk/status/1234567890")).toBe(true)
  })

  it("recognises twitter.com status URLs", () => {
    expect(isTweetUrl("https://twitter.com/jack/status/9876543210")).toBe(true)
  })

  it("recognises mobile.twitter.com URLs", () => {
    expect(isTweetUrl("https://mobile.twitter.com/user/status/111")).toBe(true)
  })

  it("recognises www.x.com URLs", () => {
    expect(isTweetUrl("https://www.x.com/user/status/222")).toBe(true)
  })

  it("rejects non-tweet URLs", () => {
    expect(isTweetUrl("https://x.com/elonmusk")).toBe(false)
    expect(isTweetUrl("https://example.com/status/123")).toBe(false)
    expect(isTweetUrl("https://x.com/i/spaces/abc")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(isTweetUrl("HTTPS://X.COM/user/STATUS/123")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// toFixTweetApiUrl()
// ---------------------------------------------------------------------------

describe("toFixTweetApiUrl", () => {
  it("converts x.com URL to FixTweet API URL", () => {
    expect(toFixTweetApiUrl("https://x.com/elonmusk/status/1234567890")).toBe(
      "https://api.fxtwitter.com/elonmusk/status/1234567890",
    )
  })

  it("converts twitter.com URL to FixTweet API URL", () => {
    expect(toFixTweetApiUrl("https://twitter.com/jack/status/999")).toBe(
      "https://api.fxtwitter.com/jack/status/999",
    )
  })

  it("returns null for non-tweet URLs", () => {
    expect(toFixTweetApiUrl("https://example.com/article")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractContentFromTweet()
// ---------------------------------------------------------------------------

describe("extractContentFromTweet", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns nulls for non-tweet URL", async () => {
    const result = await extractContentFromTweet("https://example.com")
    expect(result).toEqual({
      title: null,
      content: null,
      ogImage: null,
      author: null,
    })
  })

  it("extracts tweet text, author, and media from FixTweet response", async () => {
    const mockResponse = {
      tweet: {
        text: "Hello world from X!",
        author: { name: "Elon Musk", screen_name: "elonmusk" },
        media: {
          photos: [{ url: "https://pbs.twimg.com/photo1.jpg" }],
        },
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const result = await extractContentFromTweet(
      "https://x.com/elonmusk/status/123",
    )

    expect(result.title).toBe("Elon Musk (@elonmusk) on X")
    expect(result.content).toBe("Hello world from X!")
    expect(result.ogImage).toBe("https://pbs.twimg.com/photo1.jpg")
    expect(result.author).toBe("Elon Musk (@elonmusk)")
  })

  it("returns nulls on fetch failure", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"))

    const result = await extractContentFromTweet(
      "https://x.com/user/status/456",
    )
    expect(result.title).toBeNull()
    expect(result.content).toBeNull()
  })

  it("returns nulls when API returns non-OK status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    )

    const result = await extractContentFromTweet(
      "https://x.com/user/status/789",
    )
    expect(result.title).toBeNull()
  })

  it("returns nulls when response has no tweet field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 404 }), { status: 200 }),
    )

    const result = await extractContentFromTweet(
      "https://x.com/user/status/101",
    )
    expect(result.title).toBeNull()
  })

  it("uses video thumbnail when no photos available", async () => {
    const mockResponse = {
      tweet: {
        text: "Check this video",
        author: { name: "User", screen_name: "user" },
        media: {
          videos: [{ thumbnail_url: "https://pbs.twimg.com/thumb.jpg" }],
        },
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const result = await extractContentFromTweet(
      "https://x.com/user/status/202",
    )
    expect(result.ogImage).toBe("https://pbs.twimg.com/thumb.jpg")
  })

  it("uses 'Post on X' title when no author", async () => {
    const mockResponse = {
      tweet: {
        text: "Anonymous post",
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const result = await extractContentFromTweet(
      "https://x.com/anon/status/303",
    )
    expect(result.title).toBe("Post on X")
    expect(result.author).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// truncateContent()
// ---------------------------------------------------------------------------

describe("truncateContent", () => {
  it("returns text unchanged when it is under the default maxLength (5000)", () => {
    const short = "Hello world"
    expect(truncateContent(short)).toBe(short)
  })

  it("truncates text that exceeds the default maxLength of 5000 characters", () => {
    const long = makeText(6000)
    const result = truncateContent(long)
    expect(result.length).toBeLessThanOrEqual(5000 + 3) // +3 for "..."
    expect(result.length).toBeGreaterThan(0)
  })

  it("adds '...' suffix when truncation occurs", () => {
    const long = makeText(6000)
    const result = truncateContent(long)
    expect(result.endsWith("...")).toBe(true)
  })

  it("does not cut in the middle of a word — truncates at last word boundary", () => {
    // Construct text where the 5000th char falls inside a word
    const base = "a".repeat(4999) + " splitword rest"
    const result = truncateContent(base)
    // The word "splitword" starts at char 5000 and must NOT be partially included
    expect(result).not.toMatch(/split(?!word)/) // no partial "split" without "word"
    // More directly: no fragment of "splitword" should appear cut
    expect(result).not.toContain("splitwor")
    expect(result).not.toContain("splitwo")
  })

  it("handles empty string without throwing", () => {
    expect(truncateContent("")).toBe("")
  })

  it("respects a custom maxLength parameter smaller than the default", () => {
    const text = "one two three four five six seven eight nine ten"
    const result = truncateContent(text, 10)
    expect(result.replace(/\.\.\.$/, "").length).toBeLessThanOrEqual(10)
    expect(result.endsWith("...")).toBe(true)
  })

  it("returns text unchanged when length equals maxLength exactly", () => {
    const text = "a".repeat(5000)
    const result = truncateContent(text)
    // Exactly at limit — no truncation needed, no "..."
    expect(result).toBe(text)
    expect(result.endsWith("...")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractContentFromText() — pure function, no network
// ---------------------------------------------------------------------------

describe("extractContentFromText", () => {
  it("uses the first non-empty line as the title", () => {
    const result = extractContentFromText("My Title\n\nSome body text here.")
    expect(result.title).toBe("My Title")
  })

  it("returns the full rawText as the content field", () => {
    const raw = "My Title\nBody content here."
    const result = extractContentFromText(raw)
    expect(result.content).toBe(raw)
  })

  it("always returns null for ogImage (plain text has no image)", () => {
    const result = extractContentFromText("Title\nBody")
    expect(result.ogImage).toBeNull()
  })

  it("returns null for author (plain text provides no author signal)", () => {
    const result = extractContentFromText("Title\nBody")
    expect(result.author).toBeNull()
  })

  it("handles single-line text — title and content are the same line", () => {
    const singleLine = "Only one line here"
    const result = extractContentFromText(singleLine)
    expect(result.title).toBe(singleLine)
    expect(result.content).toBe(singleLine)
  })

  it("returns null for title and content when given an empty string", () => {
    const result = extractContentFromText("")
    expect(result.title).toBeNull()
    expect(result.content).toBeNull()
  })

  it("skips leading empty lines to find the first non-empty line as title", () => {
    const text = "\n\n\nActual Title\nBody text."
    const result = extractContentFromText(text)
    expect(result.title).toBe("Actual Title")
  })

  it("truncates content to 5000 characters when rawText exceeds that length", () => {
    const longText = "Title line\n" + makeText(6000)
    const result = extractContentFromText(longText)
    expect(result.content).not.toBeNull()
    // Content must be capped — raw was >6000 chars
    expect(result.content!.length).toBeLessThanOrEqual(5003) // 5000 + "..."
  })
})

// ---------------------------------------------------------------------------
// extractContentFromUrl() — requires fetch mocking
// ---------------------------------------------------------------------------

describe("extractContentFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("extracts title and content from a valid HTML page using Readability", async () => {
    const html = makeHtmlPage({
      title: "Design Systems in 2025",
      body: "<p>Design systems have evolved significantly. This article covers the key trends and tools that shaped the industry in 2025, including component libraries, token management, and AI-assisted design workflows.</p><p>More details on the evolution of design thinking and tooling.</p>",
    })

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.title).toBeTruthy()
    expect(result.content).toBeTruthy()
    // Readability should extract some meaningful text from the article body
    expect(result.content).toContain("Design")
  })

  it("extracts og:image URL from the <meta property='og:image'> tag", async () => {
    const ogImageUrl = "https://example.com/images/og-cover.jpg"
    const html = makeHtmlPage({ ogImage: ogImageUrl })

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.ogImage).toBe(ogImageUrl)
  })

  it("returns null for ogImage when the page has no og:image meta tag", async () => {
    const html = makeHtmlPage({ ogImage: null })

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.ogImage).toBeNull()
  })

  it("truncates extracted content to 5000 characters", async () => {
    const longParagraph = "<p>" + makeText(10000) + "</p>"
    const html = makeHtmlPage({ body: longParagraph })

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.content).not.toBeNull()
    expect(result.content!.length).toBeLessThanOrEqual(5003) // 5000 + "..."
  })

  it("returns all nulls on network fetch failure — does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network unreachable"))

    const result = await extractContentFromUrl("https://example.com/article")

    expect(result.title).toBeNull()
    expect(result.content).toBeNull()
    expect(result.ogImage).toBeNull()
    expect(result.author).toBeNull()
  })

  it("returns all nulls for non-HTML responses (e.g. a PDF link) — does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("%PDF-1.4 binary content", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      })
    )

    const result = await extractContentFromUrl("https://example.com/doc.pdf")

    expect(result.title).toBeNull()
    expect(result.content).toBeNull()
    expect(result.ogImage).toBeNull()
  })

  it("returns all nulls when fetch times out — does not throw", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), 10)
        )
    )

    const result = await extractContentFromUrl("https://example.com/slow")

    expect(result.title).toBeNull()
    expect(result.content).toBeNull()
    expect(result.ogImage).toBeNull()
    expect(result.author).toBeNull()
  })

  it("sends Accept-Language: en-US,en;q=0.9 to prevent locale content negotiation (RAD-220)", async () => {
    const html = makeHtmlPage({ title: "Any", body: "<p>Any body.</p>" })
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )

    await extractContentFromUrl("https://example.com/article")

    expect(fetch).toHaveBeenCalledTimes(1)
    const call = vi.mocked(fetch).mock.calls[0]
    const init = call[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9")
    expect(headers["User-Agent"]).toContain("RadaricBot")
  })

  it("never throws even when fetch returns an HTTP error status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 })
    )

    await expect(
      extractContentFromUrl("https://example.com/missing")
    ).resolves.not.toThrow()

    const result = await extractContentFromUrl("https://example.com/missing")
    expect(result.title).toBeNull()
  })

  it("routes tweet URLs to FixTweet API instead of Readability", async () => {
    const mockResponse = {
      tweet: {
        text: "Routed tweet content",
        author: { name: "Test", screen_name: "test" },
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const result = await extractContentFromUrl(
      "https://x.com/test/status/999",
    )

    expect(result.content).toBe("Routed tweet content")
    expect(result.author).toBe("Test (@test)")
    expect(result.title).toBe("Test (@test) on X")
  })
})
