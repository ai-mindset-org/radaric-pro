/**
 * Pure function tests for the branded-RSS flavor registry (lib/feed-flavor.ts)
 * No mocks — resolveFlavorInput / resolveBrandUrl / detectFlavor are string-only.
 * RAD-268
 */

import { describe, it, expect } from "vitest"
import {
  FEED_FLAVORS,
  FLAVOR_CONFIGS,
  isFeedFlavor,
  resolveFlavorInput,
  resolveBrandUrl,
  detectFlavor,
} from "@/lib/feed-flavor"

describe("isFeedFlavor", () => {
  it("accepts every registered flavor", () => {
    for (const flavor of FEED_FLAVORS) expect(isFeedFlavor(flavor)).toBe(true)
  })

  it("rejects unknown values, null and undefined", () => {
    expect(isFeedFlavor("REDDIT")).toBe(false)
    expect(isFeedFlavor("substack")).toBe(false)
    expect(isFeedFlavor(null)).toBe(false)
    expect(isFeedFlavor(undefined)).toBe(false)
  })

  it("has a config for every flavor", () => {
    for (const flavor of FEED_FLAVORS) {
      expect(FLAVOR_CONFIGS[flavor].flavor).toBe(flavor)
      expect(FLAVOR_CONFIGS[flavor].label.length).toBeGreaterThan(0)
      expect(FLAVOR_CONFIGS[flavor].placeholder.length).toBeGreaterThan(0)
    }
  })
})

describe("resolveFlavorInput — SUBSTACK", () => {
  it("resolves a publication URL to its /feed", () => {
    expect(resolveFlavorInput("SUBSTACK", "https://stratechery.substack.com")).toEqual({
      url: "https://stratechery.substack.com/feed",
      name: "stratechery",
    })
  })

  it("handles protocol-less input and trailing slash", () => {
    expect(resolveFlavorInput("SUBSTACK", "stratechery.substack.com/")?.url).toBe(
      "https://stratechery.substack.com/feed"
    )
  })

  it("strips article paths down to the publication feed", () => {
    expect(resolveFlavorInput("SUBSTACK", "https://foo.substack.com/p/some-post")?.url).toBe(
      "https://foo.substack.com/feed"
    )
  })

  it("keeps an already-resolved /feed URL", () => {
    expect(resolveFlavorInput("SUBSTACK", "https://foo.substack.com/feed")?.url).toBe(
      "https://foo.substack.com/feed"
    )
  })

  it("resolves a bare publication name", () => {
    expect(resolveFlavorInput("SUBSTACK", "stratechery")).toEqual({
      url: "https://stratechery.substack.com/feed",
      name: "stratechery",
    })
    expect(resolveFlavorInput("SUBSTACK", "@stratechery")?.url).toBe(
      "https://stratechery.substack.com/feed"
    )
  })

  it("rejects custom domains (documented limitation)", () => {
    expect(resolveFlavorInput("SUBSTACK", "https://stratechery.com")).toBeNull()
  })

  it("rejects empty input", () => {
    expect(resolveFlavorInput("SUBSTACK", "")).toBeNull()
    expect(resolveFlavorInput("SUBSTACK", "   ")).toBeNull()
  })
})

describe("resolveFlavorInput — BLUESKY", () => {
  it("resolves @handle.bsky.social", () => {
    expect(resolveFlavorInput("BLUESKY", "@user.bsky.social")).toEqual({
      url: "https://bsky.app/profile/user.bsky.social/rss",
      name: "@user.bsky.social",
    })
  })

  it("resolves a bare handle without @", () => {
    expect(resolveFlavorInput("BLUESKY", "user.bsky.social")?.url).toBe(
      "https://bsky.app/profile/user.bsky.social/rss"
    )
  })

  it("expands a dot-less handle with .bsky.social", () => {
    expect(resolveFlavorInput("BLUESKY", "@user")?.url).toBe(
      "https://bsky.app/profile/user.bsky.social/rss"
    )
  })

  it("supports custom-domain handles", () => {
    expect(resolveFlavorInput("BLUESKY", "@pfrazee.com")?.url).toBe(
      "https://bsky.app/profile/pfrazee.com/rss"
    )
  })

  it("resolves a profile URL", () => {
    expect(resolveFlavorInput("BLUESKY", "https://bsky.app/profile/pfrazee.com")?.url).toBe(
      "https://bsky.app/profile/pfrazee.com/rss"
    )
  })

  it("keeps an already-resolved profile /rss URL", () => {
    expect(resolveFlavorInput("BLUESKY", "https://bsky.app/profile/foo.bsky.social/rss")?.url).toBe(
      "https://bsky.app/profile/foo.bsky.social/rss"
    )
  })

  it("rejects non-bsky URLs", () => {
    expect(resolveFlavorInput("BLUESKY", "https://example.com/foo")).toBeNull()
    expect(resolveFlavorInput("BLUESKY", "example.com/foo")).toBeNull()
  })

  it("rejects malformed handles", () => {
    expect(resolveFlavorInput("BLUESKY", ".bad")).toBeNull()
    expect(resolveFlavorInput("BLUESKY", "@")).toBeNull()
  })
})

describe("resolveFlavorInput — MASTODON", () => {
  it("resolves a profile URL to .rss", () => {
    expect(resolveFlavorInput("MASTODON", "https://mastodon.social/@Gargron")).toEqual({
      url: "https://mastodon.social/@Gargron.rss",
      name: "@Gargron@mastodon.social",
    })
  })

  it("resolves a webfinger handle @user@instance", () => {
    expect(resolveFlavorInput("MASTODON", "@Gargron@mastodon.social")?.url).toBe(
      "https://mastodon.social/@Gargron.rss"
    )
  })

  it("resolves a webfinger handle without the leading @", () => {
    expect(resolveFlavorInput("MASTODON", "Gargron@mastodon.social")?.url).toBe(
      "https://mastodon.social/@Gargron.rss"
    )
  })

  it("handles trailing slash and protocol-less profile URLs", () => {
    expect(resolveFlavorInput("MASTODON", "mastodon.social/@Gargron/")?.url).toBe(
      "https://mastodon.social/@Gargron.rss"
    )
  })

  it("keeps an already-resolved .rss URL", () => {
    expect(resolveFlavorInput("MASTODON", "https://merveilles.town/@user.rss")?.url).toBe(
      "https://merveilles.town/@user.rss"
    )
  })

  it("rejects instance URLs without a profile path", () => {
    expect(resolveFlavorInput("MASTODON", "https://mastodon.social/about")).toBeNull()
  })

  it("rejects a bare @user without instance", () => {
    expect(resolveFlavorInput("MASTODON", "@user")).toBeNull()
  })
})

describe("resolveFlavorInput — PRODUCTHUNT", () => {
  it("resolves empty input to the general launches feed", () => {
    expect(resolveFlavorInput("PRODUCTHUNT", "")).toEqual({
      url: "https://www.producthunt.com/feed",
      name: "Product Hunt",
    })
  })

  it("resolves a topic slug to a category feed", () => {
    expect(resolveFlavorInput("PRODUCTHUNT", "artificial-intelligence")).toEqual({
      url: "https://www.producthunt.com/feed?category=artificial-intelligence",
      name: "Product Hunt: artificial-intelligence",
    })
  })

  it("resolves a topic URL to a category feed", () => {
    expect(
      resolveFlavorInput("PRODUCTHUNT", "https://www.producthunt.com/topics/developer-tools")?.url
    ).toBe("https://www.producthunt.com/feed?category=developer-tools")
  })

  it("resolves the bare site URL to the general feed", () => {
    expect(resolveFlavorInput("PRODUCTHUNT", "https://www.producthunt.com")?.url).toBe(
      "https://www.producthunt.com/feed"
    )
  })

  it("rejects invalid slugs", () => {
    expect(resolveFlavorInput("PRODUCTHUNT", "not a slug!")).toBeNull()
  })
})

describe("resolveFlavorInput — GITHUB", () => {
  it("resolves owner/repo shorthand to the releases feed", () => {
    expect(resolveFlavorInput("GITHUB", "vercel/next.js")).toEqual({
      url: "https://github.com/vercel/next.js/releases.atom",
      name: "vercel/next.js",
    })
  })

  it("resolves a repository URL", () => {
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel/next.js")?.url).toBe(
      "https://github.com/vercel/next.js/releases.atom"
    )
  })

  it("strips .git and trailing slashes", () => {
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel/next.js.git")?.url).toBe(
      "https://github.com/vercel/next.js/releases.atom"
    )
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel/next.js/")?.url).toBe(
      "https://github.com/vercel/next.js/releases.atom"
    )
  })

  it("maps a /releases page URL to releases.atom", () => {
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel/next.js/releases")?.url).toBe(
      "https://github.com/vercel/next.js/releases.atom"
    )
  })

  it("keeps an explicit .atom feed (commits, tags)", () => {
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel/next.js/commits.atom")?.url).toBe(
      "https://github.com/vercel/next.js/commits.atom"
    )
  })

  it("rejects owner-only and bare-host inputs", () => {
    expect(resolveFlavorInput("GITHUB", "https://github.com/vercel")).toBeNull()
    expect(resolveFlavorInput("GITHUB", "github.com")).toBeNull()
  })
})

describe("resolveFlavorInput — ARXIV", () => {
  it("resolves a category code", () => {
    expect(resolveFlavorInput("ARXIV", "cs.AI")).toEqual({
      url: "https://rss.arxiv.org/rss/cs.AI",
      name: "arXiv cs.AI",
    })
  })

  it("resolves categories without a subfield", () => {
    expect(resolveFlavorInput("ARXIV", "econ.EM")?.url).toBe("https://rss.arxiv.org/rss/econ.EM")
    expect(resolveFlavorInput("ARXIV", "hep-th")?.url).toBe("https://rss.arxiv.org/rss/hep-th")
  })

  it("resolves an arxiv.org listing URL", () => {
    expect(resolveFlavorInput("ARXIV", "https://arxiv.org/list/cs.AI/recent")?.url).toBe(
      "https://rss.arxiv.org/rss/cs.AI"
    )
  })

  it("keeps an already-resolved rss.arxiv.org URL", () => {
    expect(resolveFlavorInput("ARXIV", "https://rss.arxiv.org/rss/cs.AI")?.url).toBe(
      "https://rss.arxiv.org/rss/cs.AI"
    )
  })

  it("rejects invalid category strings", () => {
    expect(resolveFlavorInput("ARXIV", "not a category!!")).toBeNull()
    expect(resolveFlavorInput("ARXIV", "")).toBeNull()
  })
})

describe("resolveBrandUrl (extraction path — URL-only)", () => {
  it("resolves a Substack publication URL", () => {
    expect(resolveBrandUrl("https://stratechery.substack.com")).toMatchObject({
      flavor: "SUBSTACK",
      url: "https://stratechery.substack.com/feed",
    })
  })

  it("resolves a Bluesky profile URL", () => {
    expect(resolveBrandUrl("https://bsky.app/profile/pfrazee.com")).toMatchObject({
      flavor: "BLUESKY",
      url: "https://bsky.app/profile/pfrazee.com/rss",
    })
  })

  it("resolves a GitHub repository URL", () => {
    expect(resolveBrandUrl("https://github.com/vercel/next.js")).toMatchObject({
      flavor: "GITHUB",
      url: "https://github.com/vercel/next.js/releases.atom",
    })
  })

  it("resolves a Product Hunt topic URL", () => {
    expect(resolveBrandUrl("https://www.producthunt.com/topics/developer-tools")).toMatchObject({
      flavor: "PRODUCTHUNT",
      url: "https://www.producthunt.com/feed?category=developer-tools",
    })
  })

  it("resolves an arXiv listing URL", () => {
    expect(resolveBrandUrl("https://arxiv.org/list/cs.AI/recent")).toMatchObject({
      flavor: "ARXIV",
      url: "https://rss.arxiv.org/rss/cs.AI",
    })
  })

  it("does NOT resolve Mastodon-style profile URLs (Medium false-positive guard)", () => {
    expect(resolveBrandUrl("https://medium.com/@some-writer")).toBeNull()
    expect(resolveBrandUrl("https://mastodon.social/@Gargron")).toBeNull()
  })

  it("ignores plain websites and other platforms", () => {
    expect(resolveBrandUrl("https://example.com")).toBeNull()
    expect(resolveBrandUrl("https://t.me/durov")).toBeNull()
    expect(resolveBrandUrl("https://x.com/user")).toBeNull()
  })
})

describe("detectFlavor", () => {
  it("detects each brand's resolved feed URL", () => {
    expect(detectFlavor("https://stratechery.substack.com/feed")).toBe("SUBSTACK")
    expect(detectFlavor("https://bsky.app/profile/user.bsky.social/rss")).toBe("BLUESKY")
    expect(detectFlavor("https://mastodon.social/@Gargron.rss")).toBe("MASTODON")
    expect(detectFlavor("https://www.producthunt.com/feed")).toBe("PRODUCTHUNT")
    expect(detectFlavor("https://www.producthunt.com/feed?category=developer-tools")).toBe("PRODUCTHUNT")
    expect(detectFlavor("https://github.com/vercel/next.js/releases.atom")).toBe("GITHUB")
    expect(detectFlavor("https://rss.arxiv.org/rss/cs.AI")).toBe("ARXIV")
  })

  it("round-trips every resolver output", () => {
    const resolved = [
      resolveFlavorInput("SUBSTACK", "https://foo.substack.com"),
      resolveFlavorInput("BLUESKY", "@user.bsky.social"),
      resolveFlavorInput("MASTODON", "@Gargron@mastodon.social"),
      resolveFlavorInput("PRODUCTHUNT", ""),
      resolveFlavorInput("GITHUB", "vercel/next.js"),
      resolveFlavorInput("ARXIV", "cs.AI"),
    ]
    const flavors = resolved.map((r) => (r ? detectFlavor(r.url) : null))
    expect(flavors).toEqual(["SUBSTACK", "BLUESKY", "MASTODON", "PRODUCTHUNT", "GITHUB", "ARXIV"])
  })

  it("detects GitHub commits/tags feeds too", () => {
    expect(detectFlavor("https://github.com/vercel/next.js/commits/main.atom")).toBe("GITHUB")
  })

  it("is lenient about a missing protocol", () => {
    expect(detectFlavor("foo.substack.com/feed")).toBe("SUBSTACK")
  })

  it("returns null for plain RSS feeds and non-feed URLs", () => {
    expect(detectFlavor("https://example.com/feed")).toBeNull()
    expect(detectFlavor("https://blog.example.com/rss.xml")).toBeNull()
    expect(detectFlavor("https://t.me/durov")).toBeNull()
  })

  it("does not misdetect Medium feeds as Mastodon", () => {
    expect(detectFlavor("https://medium.com/feed/@some-writer")).toBeNull()
  })

  it("does not misdetect a Bluesky profile page (non-feed) or substack article", () => {
    expect(detectFlavor("https://bsky.app/profile/user.bsky.social")).toBeNull()
  })

  it("returns null for garbage input", () => {
    expect(detectFlavor("")).toBeNull()
    expect(detectFlavor("not a url at all")).toBeNull()
  })
})
