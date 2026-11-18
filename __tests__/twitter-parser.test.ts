import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  parseTwitterSource,
  parseSourceUrlToConfig,
  buildTwitterSourceUrl,
  validateTwitterUsername,
  isTwitterSourceUrl,
  type TwitterSourceConfig,
} from "@/lib/parsers/twitter"

// Mock sleep to skip rate limit delays in tests
vi.mock("@/lib/sleep", () => ({ sleep: () => Promise.resolve() }))

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeTweet(overrides: Record<string, unknown> = {}) {
  return {
    id: "1234567890",
    url: "https://x.com/testuser/status/1234567890",
    text: "Hello world from Twitter",
    createdAt: "Tue Dec 10 07:00:30 +0000 2024",
    author: { userName: "testuser", name: "Test User" },
    isReply: false,
    retweetCount: 5,
    likeCount: 10,
    quoteCount: 1,
    replyCount: 2,
    viewCount: 1000,
    ...overrides,
  }
}

function apiResponse(tweets: unknown[], hasNext = false) {
  const body = {
    status: "success",
    msg: "success",
    data: { pin_tweet: null, tweets },
    has_next_page: hasNext,
    next_cursor: hasNext ? "cursor123" : "",
  }
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

describe("parseTwitterSource", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.TWITTER_API_IO_KEY = "test-api-key"
  })

  it("fetches user timeline and converts to ParsedRSSItem format", async () => {
    mockFetch.mockResolvedValueOnce(apiResponse([makeTweet()]))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      url: "https://x.com/testuser/status/1234567890",
      externalId: "twitter:1234567890",
      content: "Hello world from Twitter",
    })
    expect(items[0].publishedAt).toBeInstanceOf(Date)
  })

  it("sends correct API request with X-API-Key header", async () => {
    mockFetch.mockResolvedValueOnce(apiResponse([]))

    await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("userName=testuser"),
      expect.objectContaining({
        headers: { "X-API-Key": "test-api-key" },
      })
    )
  })

  it("strips @ from username", async () => {
    mockFetch.mockResolvedValueOnce(apiResponse([]))

    await parseTwitterSource({ type: "ACCOUNT", value: "@testuser" })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("userName=testuser"),
      expect.anything()
    )
  })

  it("filters out replies", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({ id: "1", isReply: false }),
        makeTweet({ id: "2", isReply: true }),
        makeTweet({ id: "3", isReply: false }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items).toHaveLength(2)
  })

  it("extracts media URLs from photos via extendedEntities", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo1.jpg" },
              { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo2.jpg" },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items[0].mediaUrls).toEqual([
      "https://pbs.twimg.com/media/photo1.jpg",
      "https://pbs.twimg.com/media/photo2.jpg",
    ])
    expect(items[0].thumbnailUrl).toBe("https://pbs.twimg.com/media/photo1.jpg")
  })

  it("extracts video URLs picking highest bitrate mp4", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/123.jpg",
                video_info: {
                  variants: [
                    { url: "https://video.twimg.com/v/low.mp4", bitrate: 256000, content_type: "video/mp4" },
                    { url: "https://video.twimg.com/v/high.mp4", bitrate: 2176000, content_type: "video/mp4" },
                    { url: "https://video.twimg.com/v/stream.m3u8", content_type: "application/x-mpegURL" },
                  ],
                },
              },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items[0].mediaUrls).toEqual([
      "https://video.twimg.com/v/high.mp4",
    ])
  })

  it("preserves retweet text as-is from API", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: "RT @original: Some tweet",
          retweeted_tweet: {
            author: { userName: "original", name: "Original" },
            text: "Some tweet",
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, undefined, { includeRetweets: true })
    expect(items[0].content).toBe("RT @original: Some tweet")
  })

  it("filters out retweets by default", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: "RT @original: Some tweet",
          retweeted_tweet: {
            author: { userName: "original", name: "Original" },
            text: "Some tweet",
          },
        }),
        makeTweet({ id: "2", text: "My own tweet" }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items).toHaveLength(1)
    expect(items[0].content).toBe("My own tweet")
  })

  it("throws distinguishable error on 429 rate limit", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limit exceeded"),
    })

    await expect(
      parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    ).rejects.toThrow("429")
  })

  it("throws on SEARCH type", async () => {
    await expect(
      parseTwitterSource({ type: "SEARCH", value: "query" })
    ).rejects.toThrow("Twitter search is not supported")
  })

  it("throws when API key is missing", async () => {
    delete process.env.TWITTER_API_IO_KEY

    await expect(
      parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    ).rejects.toThrow("TWITTER_API_IO_KEY")
  })

  it("throws on API error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limited"),
    })

    await expect(
      parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    ).rejects.toThrow("429")
  })

  it("throws on API error status in body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        status: "error",
        msg: "User not found",
      })),
    })

    await expect(
      parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    ).rejects.toThrow("User not found")
  })

  it("throws on invalid JSON response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve("<html>502 Bad Gateway</html>"),
    })

    await expect(
      parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    ).rejects.toThrow("invalid JSON")
  })

  it("handles null data.tweets gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        status: "success",
        data: null,
        has_next_page: false,
        next_cursor: "",
      })),
    })

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items).toEqual([])
  })

  it("truncates long tweet text for title", async () => {
    const longText = "A".repeat(400)
    mockFetch.mockResolvedValueOnce(apiResponse([makeTweet({ text: longText })]))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })
    expect(items[0].title.length).toBeLessThanOrEqual(301) // 300 + ellipsis
    expect(items[0].content).toBe(longText)
  })
})

describe("parseSourceUrlToConfig", () => {
  it("parses x.com URLs", () => {
    expect(parseSourceUrlToConfig("https://x.com/AnthropicAI")).toEqual({
      type: "ACCOUNT",
      value: "AnthropicAI",
    })
  })

  it("parses twitter.com URLs", () => {
    expect(parseSourceUrlToConfig("https://twitter.com/AnthropicAI")).toEqual({
      type: "ACCOUNT",
      value: "AnthropicAI",
    })
  })

  it("parses x.com URLs with path segments", () => {
    expect(
      parseSourceUrlToConfig("https://x.com/AnthropicAI/status/123")
    ).toEqual({
      type: "ACCOUNT",
      value: "AnthropicAI",
    })
  })

  it("parses legacy Nitter URLs", () => {
    expect(
      parseSourceUrlToConfig("https://nitter.privacyredirect.com/AnthropicAI/rss")
    ).toEqual({
      type: "ACCOUNT",
      value: "AnthropicAI",
    })
  })

  it("parses legacy RSSHub URLs", () => {
    expect(
      parseSourceUrlToConfig("https://rsshub.app/twitter/user/AnthropicAI")
    ).toEqual({
      type: "ACCOUNT",
      value: "AnthropicAI",
    })
  })

  it("ignores x.com/search paths", () => {
    expect(parseSourceUrlToConfig("https://x.com/search?q=test")).toBeNull()
  })

  it("ignores reserved x.com paths", () => {
    const reserved = ["home", "explore", "notifications", "messages", "settings", "compose", "lists", "bookmarks"]
    for (const path of reserved) {
      expect(parseSourceUrlToConfig(`https://x.com/${path}`)).toBeNull()
    }
  })

  it("returns null for non-Twitter URLs", () => {
    expect(parseSourceUrlToConfig("https://example.com/feed")).toBeNull()
  })
})

describe("buildTwitterSourceUrl", () => {
  it("builds x.com URL from config", () => {
    expect(
      buildTwitterSourceUrl({ type: "ACCOUNT", value: "AnthropicAI" })
    ).toBe("https://x.com/AnthropicAI")
  })

  it("strips @ from username", () => {
    expect(
      buildTwitterSourceUrl({ type: "ACCOUNT", value: "@AnthropicAI" })
    ).toBe("https://x.com/AnthropicAI")
  })

  it("throws on SEARCH type", () => {
    expect(() =>
      buildTwitterSourceUrl({ type: "SEARCH", value: "query" })
    ).toThrow()
  })
})

describe("validateTwitterUsername", () => {
  it("accepts valid usernames", () => {
    expect(validateTwitterUsername("AnthropicAI")).toEqual({
      valid: true,
      normalized: "AnthropicAI",
    })
  })

  it("strips @ prefix", () => {
    expect(validateTwitterUsername("@AnthropicAI")).toEqual({
      valid: true,
      normalized: "AnthropicAI",
    })
  })

  it("rejects empty usernames", () => {
    expect(validateTwitterUsername("").valid).toBe(false)
  })

  it("rejects usernames over 15 characters", () => {
    expect(validateTwitterUsername("a".repeat(16)).valid).toBe(false)
  })

  it("rejects usernames with invalid characters", () => {
    expect(validateTwitterUsername("user-name").valid).toBe(false)
  })
})

describe("Twitter incremental fetch & pagination", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.TWITTER_API_IO_KEY = "test-api-key"
  })

  function apiResponseWithCursor(tweets: unknown[], hasNext: boolean, cursor: string) {
    const body = {
      status: "success",
      msg: "success",
      data: { pin_tweet: null, tweets },
      has_next_page: hasNext,
      next_cursor: cursor,
    }
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    }
  }

  it("AC-1: stops fetching when sinceId is encountered and excludes that tweet from results", async () => {
    const tweets = [
      makeTweet({ id: "105", text: "newest tweet" }),
      makeTweet({ id: "104", text: "second tweet" }),
      makeTweet({ id: "103", text: "third tweet" }),
      makeTweet({ id: "100", text: "the sinceId tweet — must be excluded" }),
      makeTweet({ id: "99", text: "older tweet — must be excluded" }),
    ]
    mockFetch.mockResolvedValueOnce(apiResponse(tweets))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "100")

    expect(items).toHaveLength(3)
    const ids = items.map((i) => i.externalId)
    expect(ids).toContain("twitter:105")
    expect(ids).toContain("twitter:104")
    expect(ids).toContain("twitter:103")
    expect(ids).not.toContain("twitter:100")
    expect(ids).not.toContain("twitter:99")
  })

  it("AC-2: fetches exactly 1 page when sinceId is not provided (current behavior preserved)", async () => {
    mockFetch.mockResolvedValueOnce(apiResponse([makeTweet()], /* hasNext */ false))

    await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    // Only 1 Twitter API call — no OG fetch needed for this tweet (no entities.urls)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("AC-3: fetches next page using cursor when has_next_page is true and sinceId not found on page 1", async () => {
    const page1Tweets = [
      makeTweet({ id: "200", text: "page 1 tweet A" }),
      makeTweet({ id: "199", text: "page 1 tweet B" }),
    ]
    const page2Tweets = [
      makeTweet({ id: "150", text: "page 2 tweet A" }),
      makeTweet({ id: "149", text: "page 2 tweet B" }),
    ]

    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(page1Tweets, true, "cursor_page2"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(page2Tweets, false, ""))

    await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "50")

    // Verify page 2 was fetched using cursor param
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondCallUrl: string = mockFetch.mock.calls[1][0]
    expect(secondCallUrl).toContain("cursor=cursor_page2")
  })

  it("AC-4: stops pagination after MAX_PAGES (3) even when sinceId is never found", async () => {
    const pageOfTweets = (startId: number) => [
      makeTweet({ id: String(startId), text: `tweet ${startId}` }),
      makeTweet({ id: String(startId - 1), text: `tweet ${startId - 1}` }),
    ]

    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(300), true, "cursor2"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(200), true, "cursor3"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(100), true, "cursor4"))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "1")

    // Exactly 3 fetch calls (MAX_PAGES), no 4th page
    expect(mockFetch).toHaveBeenCalledTimes(3)
    // All 6 tweets returned
    expect(items).toHaveLength(6)
  })

  it("AC-5: parseTwitterSource passes sinceId through to fetchUserTimeline", async () => {
    const tweets = [
      makeTweet({ id: "500", text: "new tweet" }),
      makeTweet({ id: "100", text: "the cutoff tweet — excluded" }),
    ]
    mockFetch.mockResolvedValueOnce(apiResponse(tweets))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "100")

    // Only tweet with id "500" should appear
    expect(items).toHaveLength(1)
    expect(items[0].externalId).toBe("twitter:500")
  })

  it("AC-6: tweets from all fetched pages are combined into a single result array", async () => {
    const page1Tweets = [
      makeTweet({ id: "200", text: "page 1 tweet" }),
    ]
    const page2Tweets = [
      makeTweet({ id: "150", text: "page 2 tweet" }),
    ]

    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(page1Tweets, true, "cursor2"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(page2Tweets, false, ""))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "50")

    expect(items).toHaveLength(2)
    const ids = items.map((i) => i.externalId)
    expect(ids).toContain("twitter:200")
    expect(ids).toContain("twitter:150")
  })

  it("EC-1: sinceId found in the middle of page 1 — returns only tweets before it", async () => {
    const tweets = [
      makeTweet({ id: "10", text: "tweet 10" }),
      makeTweet({ id: "9", text: "tweet 9" }),
      makeTweet({ id: "8", text: "tweet 8" }),
      makeTweet({ id: "7", text: "tweet 7 — sinceId" }),
      makeTweet({ id: "6", text: "tweet 6 — excluded" }),
    ]
    mockFetch.mockResolvedValueOnce(apiResponse(tweets, /* hasNext */ true))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "7")

    expect(items).toHaveLength(3)
    const ids = items.map((i) => i.externalId)
    expect(ids).toEqual(["twitter:10", "twitter:9", "twitter:8"])
    // No second page fetched since sinceId was found
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("EC-2: has_next_page false on page 1 — no pagination attempted regardless of sinceId", async () => {
    const tweets = [
      makeTweet({ id: "500", text: "tweet 500" }),
      makeTweet({ id: "499", text: "tweet 499" }),
    ]
    mockFetch.mockResolvedValueOnce(apiResponse(tweets, /* hasNext */ false))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "1")

    // sinceId "1" is not in these tweets, but has_next_page is false — must not fetch page 2
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Both tweets returned (sinceId "1" not found but no more pages)
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.externalId)).toEqual(["twitter:500", "twitter:499"])
  })

  it("EC-3: sinceId not in any page — pagination continues up to MAX_PAGES, returns all fetched tweets", async () => {
    const pageOfTweets = (startId: number) => [
      makeTweet({ id: String(startId) }),
    ]

    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(300), true, "c2"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(200), true, "c3"))
    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(pageOfTweets(100), true, "c4"))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "999")

    // Reached MAX_PAGES, all 3 tweets returned
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(items).toHaveLength(3)
  })

  it("ERR-1: page 2 API call fails — returns tweets from page 1 only without throwing", async () => {
    const page1Tweets = [
      makeTweet({ id: "200", text: "page 1 tweet A" }),
      makeTweet({ id: "199", text: "page 1 tweet B" }),
    ]

    mockFetch.mockResolvedValueOnce(apiResponseWithCursor(page1Tweets, true, "cursor2"))
    mockFetch.mockRejectedValueOnce(new Error("Network error on page 2"))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" }, "50")

    // No error thrown, page 1 tweets returned
    expect(items).toHaveLength(2)
    expect(items[0].externalId).toBe("twitter:200")
    expect(items[1].externalId).toBe("twitter:199")
    // Page 2 was attempted (2 fetch calls) — verifies graceful degradation
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe("isTwitterSourceUrl", () => {
  it("recognizes x.com URLs", () => {
    expect(isTwitterSourceUrl("https://x.com/AnthropicAI")).toBe(true)
  })

  it("recognizes legacy Nitter URLs", () => {
    expect(
      isTwitterSourceUrl("https://nitter.privacyredirect.com/user/rss")
    ).toBe(true)
  })

  it("rejects non-Twitter URLs", () => {
    expect(isTwitterSourceUrl("https://example.com")).toBe(false)
  })
})

/** Create a mock fetch response with streaming body (for OG image fetch) */
function ogResponse(html: string, headers?: Record<string, string>) {
  const encoded = new TextEncoder().encode(html)
  let read = false
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8", ...headers }),
    body: {
      getReader: () => ({
        read: () => {
          if (!read) { read = true; return Promise.resolve({ done: false, value: encoded }) }
          return Promise.resolve({ done: true, value: undefined })
        },
        cancel: () => {},
      }),
    },
  }
}

describe("Twitter media enhancement", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.TWITTER_API_IO_KEY = "test-api-key"
  })

  // AC-1: When a tweet has no native media but contains a URL in entities.urls,
  // fetch that URL and extract its og:image as thumbnailUrl
  it("AC-1: extracts OG image when tweet has no native media but has URL in entities.urls", async () => {
    const ogHtml = `<html><head><meta property="og:image" content="https://example.com/og-image.jpg"></head><body></body></html>`

    // First call: Twitter API response
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          entities: {
            urls: [{ expanded_url: "https://example.com/article" }],
          },
        }),
      ])
    )
    // Second call: OG image fetch for the external URL
    mockFetch.mockResolvedValueOnce(ogResponse(ogHtml))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].thumbnailUrl).toBe("https://example.com/og-image.jpg")
    expect(items[0].mediaUrls).toContain("https://example.com/og-image.jpg")
  })

  // AC-2: When a tweet has native media (photos/videos), do NOT fetch OG images
  // from linked URLs (native media takes priority)
  it("AC-2: does not fetch OG image when tweet has native photo media", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              { type: "photo", media_url_https: "https://pbs.twimg.com/media/native.jpg" },
            ],
          },
          entities: {
            urls: [{ expanded_url: "https://example.com/article" }],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    // Only one fetch call — the Twitter API. No OG fetch should happen.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(items[0].mediaUrls).toEqual(["https://pbs.twimg.com/media/native.jpg"])
    expect(items[0].thumbnailUrl).toBe("https://pbs.twimg.com/media/native.jpg")
  })

  // AC-3: Videos with duration_millis > 300000 (5 min) are excluded from mediaUrls
  it("AC-3: excludes video from mediaUrls when duration_millis exceeds 300000ms", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/123.jpg",
                video_info: {
                  duration_millis: 300001,
                  variants: [
                    { url: "https://video.twimg.com/v/long.mp4", bitrate: 2176000, content_type: "video/mp4" },
                  ],
                },
              },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].mediaUrls).toEqual([])
    expect(items[0].thumbnailUrl).toBeUndefined()
  })

  // AC-4: Videos with duration_millis <= 300000 or no duration_millis are included
  it("AC-4: includes video when duration_millis is exactly 300000ms (EC-2: boundary)", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/456.jpg",
                video_info: {
                  duration_millis: 300000,
                  variants: [
                    { url: "https://video.twimg.com/v/boundary.mp4", bitrate: 2176000, content_type: "video/mp4" },
                  ],
                },
              },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].mediaUrls).toEqual(["https://video.twimg.com/v/boundary.mp4"])
  })

  it("AC-4: includes video when no duration_millis field present", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/789.jpg",
                video_info: {
                  variants: [
                    { url: "https://video.twimg.com/v/noduration.mp4", bitrate: 2176000, content_type: "video/mp4" },
                  ],
                },
              },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].mediaUrls).toEqual(["https://video.twimg.com/v/noduration.mp4"])
  })

  // AC-5 / ERR-1: When OG image fetch returns non-200, tweet is still returned without media
  it("AC-5: returns tweet without thumbnailUrl when OG fetch returns non-200", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          entities: {
            urls: [{ expanded_url: "https://example.com/article" }],
          },
        }),
      ])
    )
    // Second call: OG fetch returns 404
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    })

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items).toHaveLength(1)
    expect(items[0].mediaUrls).toEqual([])
    expect(items[0].thumbnailUrl).toBeUndefined()
  })

  // ERR-1: When OG image fetch times out (network error), tweet is still returned without media
  it("ERR-1: returns tweet without thumbnailUrl when OG fetch throws network error", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          entities: {
            urls: [{ expanded_url: "https://example.com/article" }],
          },
        }),
      ])
    )
    // Second call: simulate network failure for the OG fetch
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items).toHaveLength(1)
    expect(items[0].mediaUrls).toEqual([])
    expect(items[0].thumbnailUrl).toBeUndefined()
  })

  // EC-1: Tweet has both native photos AND external URLs — only native photos used, no OG fetch
  it("EC-1: uses only native photos when tweet has both native media and external URLs", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          extendedEntities: {
            media: [
              { type: "photo", media_url_https: "https://pbs.twimg.com/media/native1.jpg" },
              { type: "photo", media_url_https: "https://pbs.twimg.com/media/native2.jpg" },
            ],
          },
          entities: {
            urls: [{ expanded_url: "https://example.com/some-article" }],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(items[0].mediaUrls).toEqual([
      "https://pbs.twimg.com/media/native1.jpg",
      "https://pbs.twimg.com/media/native2.jpg",
    ])
  })

  // EC-3: Tweet has multiple URLs — only the first non-twitter URL is fetched for OG image
  it("EC-3: fetches OG image only from the first non-twitter URL when multiple URLs present", async () => {
    const ogHtml = `<html><head><meta property="og:image" content="https://firstsite.com/og.jpg"></head><body></body></html>`

    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          entities: {
            urls: [
              { expanded_url: "https://firstsite.com/article" },
              { expanded_url: "https://secondsite.com/article" },
            ],
          },
        }),
      ])
    )
    mockFetch.mockResolvedValueOnce(ogResponse(ogHtml))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    // Only two fetch calls total: Twitter API + first URL only
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(items[0].thumbnailUrl).toBe("https://firstsite.com/og.jpg")
  })

  // EC-4: t.co URLs that expand to twitter.com links are skipped
  it("EC-4: skips twitter.com expanded URLs when looking for OG image", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          entities: {
            urls: [
              { expanded_url: "https://twitter.com/user/status/123" },
              { expanded_url: "https://x.com/user/status/456" },
            ],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    // No OG fetch — all URLs are twitter/x.com links
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(items[0].thumbnailUrl).toBeUndefined()
    expect(items[0].mediaUrls).toEqual([])
  })
})

// Lede headline for post-shaped materials — RAD-315
describe("Twitter lede title derivation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.TWITTER_API_IO_KEY = "test-api-key"
  })

  it("AC-5: derives a lede title while keeping content as the full unchanged tweet text", async () => {
    const text = "Goodbye per-seat pricing.\n\nPer-user pricing has always rubbed me the wrong way."
    mockFetch.mockResolvedValueOnce(apiResponse([makeTweet({ text })]))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].title).toBe("Goodbye per-seat pricing.")
    expect(items[0].content).toBe(text)
  })

  it("AC-6: falls back to the linked page's og:title when the tweet text yields no headline", async () => {
    const ogHtml = `<html><head><meta property="og:title" content="Understanding the future of AI"></head><body></body></html>`
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: "https://t.co/smgJJlwKZQ",
          author: { userName: "shadcn", name: "shadcn" },
          entities: { urls: [{ expanded_url: "https://example.com/article" }] },
        }),
      ])
    )
    mockFetch.mockResolvedValueOnce(ogResponse(ogHtml))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].title).toBe("Understanding the future of AI")
  })

  it("AC-6: falls back to 'Photo from @user' when the tweet has no headline text and carries photo media", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: "https://t.co/smgJJlwKZQ",
          author: { userName: "shadcn", name: "shadcn" },
          extendedEntities: {
            media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/photo1.jpg" }],
          },
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items[0].title).toBe("Photo from @shadcn")
  })

  it("ERR-1: falls back to 'Link from @user' without throwing when the og:title fetch fails", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: "https://t.co/smgJJlwKZQ",
          author: { userName: "shadcn", name: "shadcn" },
          entities: { urls: [{ expanded_url: "https://example.com/article" }] },
        }),
      ])
    )
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("server error") })

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "testuser" })

    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Link from @shadcn")
  })
})

// Quote tweets carry the quoted post — RAD-398
describe("Twitter quote tweets (RAD-398)", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.TWITTER_API_IO_KEY = "test-api-key"
  })

  const OWN_TEXT = "Turns out it's open."
  const QUOTED_TEXT = "All software will be open-source."
  const NAVAL = { userName: "naval", name: "Naval" }
  const AMJAD = { userName: "amasad", name: "Amjad Masad" }

  function makeQuoted(overrides: Record<string, unknown> = {}) {
    return makeTweet({
      id: "999",
      url: "https://x.com/amasad/status/999",
      text: QUOTED_TEXT,
      author: AMJAD,
      ...overrides,
    })
  }

  function photo(url: string) {
    return { type: "photo", media_url_https: url }
  }

  it("AC-1: appends the quoted post under a 'Quoting {name} (@{userName}):' line", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([makeTweet({ text: OWN_TEXT, author: NAVAL, quoted_tweet: makeQuoted() })])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].content).toBe(
      "Turns out it's open.\n\nQuoting Amjad Masad (@amasad):\nAll software will be open-source."
    )
  })

  it("AC-2: stores a 5000-character quoted text in full, unshortened, at the end of content", async () => {
    const longQuoted = "x".repeat(4999) + "!"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({ text: OWN_TEXT, author: NAVAL, quoted_tweet: makeQuoted({ text: longQuoted }) }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].content).toBe(`${OWN_TEXT}\n\nQuoting Amjad Masad (@amasad):\n${longQuoted}`)
    expect(items[0].content.endsWith(longQuoted)).toBe(true)
  })

  it("AC-3: orders own media before quoted media and keeps the own photo as thumbnail", async () => {
    const A = "https://pbs.twimg.com/media/own-A.jpg"
    const B = "https://pbs.twimg.com/media/quoted-B.jpg"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: makeQuoted({ extendedEntities: { media: [photo(B)] } }),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].mediaUrls).toEqual([A, B])
    expect(items[0].thumbnailUrl).toBe(A)
  })

  it("AC-4: quoted video picks its highest-bitrate mp4 and an over-300000ms quoted video is skipped", async () => {
    const A = "https://pbs.twimg.com/media/own-A.jpg"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: makeQuoted({
            extendedEntities: {
              media: [
                {
                  type: "video",
                  media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/q1.jpg",
                  video_info: {
                    duration_millis: 60000,
                    variants: [
                      { url: "https://video.twimg.com/q/low.mp4", bitrate: 256000, content_type: "video/mp4" },
                      { url: "https://video.twimg.com/q/high.mp4", bitrate: 2176000, content_type: "video/mp4" },
                      { url: "https://video.twimg.com/q/stream.m3u8", content_type: "application/x-mpegURL" },
                    ],
                  },
                },
                {
                  type: "video",
                  media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/q2.jpg",
                  video_info: {
                    duration_millis: 300001,
                    variants: [
                      { url: "https://video.twimg.com/q/too-long.mp4", bitrate: 2176000, content_type: "video/mp4" },
                    ],
                  },
                },
              ],
            },
          }),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].mediaUrls).toEqual([A, "https://video.twimg.com/q/high.mp4"])
  })

  it("AC-5: derives the title from the author's own text only, identical to the no-quote title", async () => {
    mockFetch.mockResolvedValueOnce(apiResponse([makeTweet({ text: OWN_TEXT, author: NAVAL })]))
    const [baseline] = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    mockFetch.mockResolvedValueOnce(
      apiResponse([makeTweet({ text: OWN_TEXT, author: NAVAL, quoted_tweet: makeQuoted() })])
    )
    const [quoted] = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(quoted.content).toBe(
      "Turns out it's open.\n\nQuoting Amjad Masad (@amasad):\nAll software will be open-source."
    )
    expect(quoted.title).toBe(baseline.title)
    expect(quoted.title.includes("open-source")).toBe(false)
  })

  it("AC-6: quoted_tweet absent or null leaves content and mediaUrls unchanged", async () => {
    const A = "https://pbs.twimg.com/media/own-A.jpg"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({ id: "1", text: OWN_TEXT, author: NAVAL, extendedEntities: { media: [photo(A)] } }),
        makeTweet({
          id: "2",
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: null,
        }),
        // positive control in the same batch: a real quote must change the item
        makeTweet({
          id: "3",
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: makeQuoted(),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items.map((i) => i.content)).toEqual([
      OWN_TEXT,
      OWN_TEXT,
      "Turns out it's open.\n\nQuoting Amjad Masad (@amasad):\nAll software will be open-source.",
    ])
    expect(items.map((i) => i.mediaUrls)).toEqual([[A], [A], [A]])
  })

  it("EC-1: empty own text yields just the quote block and the kind-fallback title", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([makeTweet({ text: "", author: NAVAL, quoted_tweet: makeQuoted() })])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].content).toBe("Quoting Amjad Masad (@amasad):\nAll software will be open-source.")
    expect(items[0].title).toBe("Post from @naval")
  })

  it("EC-2: ignores the quoted tweet's own quoted_tweet (one level only)", async () => {
    const B = "https://pbs.twimg.com/media/quoted-B.jpg"
    const C = "https://pbs.twimg.com/media/nested-C.jpg"
    const nested = makeTweet({
      id: "555",
      text: "Nested level two text",
      author: { userName: "deep", name: "Deep User" },
      extendedEntities: { media: [photo(C)] },
    })
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: OWN_TEXT,
          author: NAVAL,
          quoted_tweet: makeQuoted({ extendedEntities: { media: [photo(B)] }, quoted_tweet: nested }),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].content).toBe(
      "Turns out it's open.\n\nQuoting Amjad Masad (@amasad):\nAll software will be open-source."
    )
    expect(items[0].mediaUrls).toEqual([B])
  })

  it("EC-3: no media on either tweet yields mediaUrls []", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([makeTweet({ text: OWN_TEXT, author: NAVAL, quoted_tweet: makeQuoted() })])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].content).toBe(
      "Turns out it's open.\n\nQuoting Amjad Masad (@amasad):\nAll software will be open-source."
    )
    expect(items[0].mediaUrls).toEqual([])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("ERR-1: empty/whitespace quoted text adds no attribution line but its photo is still appended", async () => {
    const A = "https://pbs.twimg.com/media/own-A.jpg"
    const B = "https://pbs.twimg.com/media/quoted-B.jpg"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          id: "1",
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: makeQuoted({ text: "   \n ", extendedEntities: { media: [photo(B)] } }),
        }),
        makeTweet({
          id: "2",
          text: OWN_TEXT,
          author: NAVAL,
          quoted_tweet: makeQuoted({ text: "", extendedEntities: { media: [photo(B)] } }),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items.map((i) => i.content)).toEqual([OWN_TEXT, OWN_TEXT])
    expect(items.map((i) => i.mediaUrls)).toEqual([[A, B], [B]])
  })

  // Review fixes — a deleted/withheld quoted post may arrive as a stub; it must
  // never fail the whole feed parse.
  it("a quoted_tweet stub without text or author leaves the item as if unquoted", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([makeTweet({ text: OWN_TEXT, author: NAVAL, quoted_tweet: { id: "999" } })])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items).toHaveLength(1)
    expect(items[0].content).toBe(OWN_TEXT)
    expect(items[0].mediaUrls).toEqual([])
  })

  it("attribution degrades to the handle, then to 'a post', when the quoted author is partial", async () => {
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({ id: "1", text: OWN_TEXT, author: NAVAL, quoted_tweet: { id: "8", text: QUOTED_TEXT, author: { userName: "amasad", name: "" } } }),
        makeTweet({ id: "2", text: OWN_TEXT, author: NAVAL, quoted_tweet: { id: "9", text: QUOTED_TEXT } }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items.map((i) => i.content)).toEqual([
      `${OWN_TEXT}\n\nQuoting @amasad:\n${QUOTED_TEXT}`,
      `${OWN_TEXT}\n\nQuoting a post:\n${QUOTED_TEXT}`,
    ])
  })

  it("the author's own link still gets its OG preview when only the quoted post has media", async () => {
    const B = "https://pbs.twimg.com/media/quoted-B.jpg"
    const ogHtml = `<html><head><meta property="og:image" content="https://example.com/og.jpg"></head></html>`
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: OWN_TEXT,
          author: NAVAL,
          entities: { urls: [{ expanded_url: "https://example.com/article" }] },
          quoted_tweet: makeQuoted({ extendedEntities: { media: [photo(B)] } }),
        }),
      ])
    )
    mockFetch.mockResolvedValueOnce(ogResponse(ogHtml))

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].mediaUrls).toEqual(["https://example.com/og.jpg", B])
    expect(items[0].thumbnailUrl).toBe("https://example.com/og.jpg")
  })

  it("a media URL carried by both the tweet and its quote appears once", async () => {
    const A = "https://pbs.twimg.com/media/shared-A.jpg"
    mockFetch.mockResolvedValueOnce(
      apiResponse([
        makeTweet({
          text: OWN_TEXT,
          author: NAVAL,
          extendedEntities: { media: [photo(A)] },
          quoted_tweet: makeQuoted({ extendedEntities: { media: [photo(A)] } }),
        }),
      ])
    )

    const items = await parseTwitterSource({ type: "ACCOUNT", value: "naval" })

    expect(items[0].mediaUrls).toEqual([A])
  })
})
