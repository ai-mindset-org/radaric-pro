/**
 * Pure function tests for extractFeedsFromLines (lib/feed-extraction.ts)
 * No mocks — tests regex-based feed extraction from text input.
 * RAD-178
 */

import { describe, it, expect } from "vitest"
import { extractFeedsFromLines, resolveStatus } from "@/lib/feed-extraction"
import type { ExtractedFeed } from "@/lib/onboarding-types"

describe("extractFeedsFromLines", () => {
  describe("RSS URLs", () => {
    it("extracts direct RSS feed URL", () => {
      const feeds = extractFeedsFromLines("https://blog.example.com/feed.xml")
      expect(feeds).toHaveLength(1)
      expect(feeds[0]).toMatchObject({
        url: "https://blog.example.com/feed.xml",
        type: "RSS",
        status: "found",
      })
    })

    it("extracts /feed path as RSS", () => {
      const feeds = extractFeedsFromLines("https://example.com/feed")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("RSS")
    })

    it("extracts /rss path as RSS", () => {
      const feeds = extractFeedsFromLines("https://example.com/rss")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("RSS")
    })

    it("extracts /atom path as RSS", () => {
      const feeds = extractFeedsFromLines("https://example.com/atom")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("RSS")
    })

    it("extracts .xml extension as RSS", () => {
      const feeds = extractFeedsFromLines("https://example.com/blog.xml")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("RSS")
    })
  })

  describe("Telegram links", () => {
    it("extracts https://t.me/channel", () => {
      const feeds = extractFeedsFromLines("https://t.me/durov")
      expect(feeds).toHaveLength(1)
      expect(feeds[0]).toMatchObject({
        url: "https://t.me/durov",
        name: "@durov",
        type: "TELEGRAM",
        status: "found",
      })
    })

    it("extracts t.me/channel without https", () => {
      const feeds = extractFeedsFromLines("t.me/testchannel")
      expect(feeds).toHaveLength(1)
      expect(feeds[0]).toMatchObject({
        url: "https://t.me/testchannel",
        type: "TELEGRAM",
        status: "found",
      })
    })

    it("extracts http://t.me/channel", () => {
      const feeds = extractFeedsFromLines("http://t.me/mychannel")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("TELEGRAM")
    })
  })

  describe("Twitter handles", () => {
    it("extracts @handle as Twitter", () => {
      const feeds = extractFeedsFromLines("@testuser")
      expect(feeds).toHaveLength(1)
      expect(feeds[0]).toMatchObject({
        url: "https://x.com/testuser",
        name: "@testuser",
        type: "TWITTER",
        status: "found",
      })
    })

    it("extracts x.com URL as Twitter", () => {
      const feeds = extractFeedsFromLines("https://x.com/elonmusk")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("TWITTER")
    })

    it("extracts twitter.com URL as Twitter", () => {
      const feeds = extractFeedsFromLines("https://twitter.com/jack")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("TWITTER")
    })

    it("handles max 15-char Twitter usernames", () => {
      const feeds = extractFeedsFromLines("@abcdefghijklmno") // 15 chars
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("TWITTER")
    })
  })

  describe("Website URLs", () => {
    it("classifies plain website URL as WEBSITE with pending status", () => {
      const feeds = extractFeedsFromLines("https://example.com")
      expect(feeds).toHaveLength(1)
      expect(feeds[0]).toMatchObject({
        url: "https://example.com",
        type: "WEBSITE",
        status: "pending",
      })
    })

    it("extracts hostname as name, stripping www", () => {
      const feeds = extractFeedsFromLines("https://www.example.com/blog")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].name).toBe("example.com")
    })
  })

  describe("Mixed input", () => {
    it("handles multiple lines with different types", () => {
      const input = [
        "https://blog.example.com/feed.xml",
        "t.me/durov",
        "@testuser",
        "https://example.com",
      ].join("\n")

      const feeds = extractFeedsFromLines(input)
      expect(feeds).toHaveLength(4)
      expect(feeds[0].type).toBe("RSS")
      expect(feeds[1].type).toBe("TELEGRAM")
      expect(feeds[2].type).toBe("TWITTER")
      expect(feeds[3].type).toBe("WEBSITE")
    })

    it("extracts multiple URLs on a single line", () => {
      const feeds = extractFeedsFromLines("https://a.com/feed https://b.com/rss")
      expect(feeds).toHaveLength(2)
      expect(feeds[0].type).toBe("RSS")
      expect(feeds[1].type).toBe("RSS")
    })

    it("Telegram link takes priority over URL parsing on same line", () => {
      const feeds = extractFeedsFromLines("Check out t.me/mychannel for updates")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("TELEGRAM")
    })
  })

  describe("Edge cases", () => {
    it("returns empty array for empty string", () => {
      expect(extractFeedsFromLines("")).toEqual([])
    })

    it("returns empty array for whitespace-only input", () => {
      expect(extractFeedsFromLines("   \n\n  \n")).toEqual([])
    })

    it("skips lines with no recognizable feeds", () => {
      const feeds = extractFeedsFromLines("Just some random text\nwith no feeds here")
      expect(feeds).toEqual([])
    })

    it("handles URL with query parameters", () => {
      const feeds = extractFeedsFromLines("https://example.com/feed.xml?format=rss&lang=en")
      expect(feeds).toHaveLength(1)
      expect(feeds[0].type).toBe("RSS")
    })
  })
})

describe("resolveStatus", () => {
  it("sets TELEGRAM to found with url", () => {
    const feed: ExtractedFeed = { url: null, name: "test", type: "TELEGRAM", status: "pending" }
    const result = resolveStatus(feed)
    expect(result.status).toBe("found")
    expect(result.url).toBe("https://t.me/test")
  })

  it("sets TWITTER to found", () => {
    const feed: ExtractedFeed = { url: "https://x.com/user", name: "@user", type: "TWITTER", status: "pending" }
    const result = resolveStatus(feed)
    expect(result.status).toBe("found")
  })

  it("sets RSS to found", () => {
    const feed: ExtractedFeed = { url: "https://example.com/feed", name: "Feed", type: "RSS", status: "pending" }
    const result = resolveStatus(feed)
    expect(result.status).toBe("found")
  })

  it("keeps WEBSITE as pending", () => {
    const feed: ExtractedFeed = { url: "https://example.com", name: "Example", type: "WEBSITE", status: "pending" }
    const result = resolveStatus(feed)
    expect(result.status).toBe("pending")
  })
})

describe("resolveStatus + extraction — YouTube (RAD-267)", () => {
  it("sets YOUTUBE to found with the url as-is (canonicalization happens at save)", () => {
    const feed: ExtractedFeed = { url: "https://www.youtube.com/@mkbhd", name: "youtube.com", type: "YOUTUBE", status: "pending" }
    const result = resolveStatus(feed)
    expect(result.status).toBe("found")
    expect(result.url).toBe("https://www.youtube.com/@mkbhd")
    // hostname-default name upgraded to the handle
    expect(result.name).toBe("@mkbhd")
  })

  it("preserves a curated name on YOUTUBE entries", () => {
    const feed: ExtractedFeed = { url: "https://www.youtube.com/@mkbhd", name: "Marques", type: "YOUTUBE", status: "pending" }
    expect(resolveStatus(feed).name).toBe("Marques")
  })

  it("detects channel handle URLs in pasted lines as YOUTUBE", () => {
    const feeds = extractFeedsFromLines("https://www.youtube.com/@mkbhd")
    expect(feeds).toHaveLength(1)
    expect(feeds[0].type).toBe("YOUTUBE")
    expect(feeds[0].status).toBe("found")
  })

  it("detects /channel/ and video URLs as YOUTUBE", () => {
    const feeds = extractFeedsFromLines(
      "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ\nhttps://youtu.be/dQw4w9WgXcQ"
    )
    expect(feeds.map((f) => f.type)).toEqual(["YOUTUBE", "YOUTUBE"])
  })

  it("classifies a YouTube feed-XML URL as YOUTUBE, not RSS (transcript upgrade)", () => {
    const feeds = extractFeedsFromLines(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ"
    )
    expect(feeds).toHaveLength(1)
    expect(feeds[0].type).toBe("YOUTUBE")
  })

  it("still classifies non-YouTube xml/feed URLs as RSS", () => {
    const feeds = extractFeedsFromLines("https://example.com/feed.xml")
    expect(feeds[0].type).toBe("RSS")
  })
})

describe("resolveStatus — branded URLs (RAD-268)", () => {
  const website = (url: string, name = "site"): ExtractedFeed => ({
    url,
    name,
    type: "WEBSITE",
    status: "pending",
  })

  it("resolves a GitHub repo URL to the releases feed", () => {
    const result = resolveStatus(website("https://github.com/vercel/next.js"))
    expect(result).toMatchObject({
      type: "RSS",
      status: "found",
      feedUrl: "https://github.com/vercel/next.js/releases.atom",
    })
  })

  it("resolves a Bluesky profile URL to its RSS", () => {
    const result = resolveStatus(website("https://bsky.app/profile/pfrazee.com"))
    expect(result).toMatchObject({
      type: "RSS",
      status: "found",
      feedUrl: "https://bsky.app/profile/pfrazee.com/rss",
    })
  })

  it("resolves a Substack publication URL to /feed", () => {
    const result = resolveStatus(website("https://stratechery.substack.com"))
    expect(result).toMatchObject({
      type: "RSS",
      status: "found",
      feedUrl: "https://stratechery.substack.com/feed",
    })
  })

  it("resolves a Product Hunt topic URL to the category feed", () => {
    const result = resolveStatus(website("https://www.producthunt.com/topics/developer-tools"))
    expect(result).toMatchObject({
      type: "RSS",
      status: "found",
      feedUrl: "https://www.producthunt.com/feed?category=developer-tools",
    })
  })

  it("resolves an arXiv listing URL to the category RSS", () => {
    const result = resolveStatus(website("https://arxiv.org/list/cs.AI/recent"))
    expect(result).toMatchObject({
      type: "RSS",
      status: "found",
      feedUrl: "https://rss.arxiv.org/rss/cs.AI",
    })
  })

  it("upgrades a generic hostname name to the brand-suggested name", () => {
    const result = resolveStatus(website("https://github.com/vercel/next.js", "github.com"))
    expect(result.name).toBe("vercel/next.js")
  })

  it("preserves a curated (non-hostname) name", () => {
    const result = resolveStatus(website("https://github.com/vercel/next.js", "Next.js releases"))
    expect(result.name).toBe("Next.js releases")
  })

  it("leaves Medium profile URLs on the discovery path (no Mastodon heuristic)", () => {
    const result = resolveStatus(website("https://medium.com/@some-writer"))
    expect(result.status).toBe("pending")
    expect(result.type).toBe("WEBSITE")
    expect(result.feedUrl).toBeUndefined()
  })

  it("leaves plain websites on the discovery path", () => {
    const result = resolveStatus(website("https://example.com/blog"))
    expect(result.status).toBe("pending")
    expect(result.type).toBe("WEBSITE")
  })
})
