/**
 * RAD-336 / RAD-340 — an RSS item's article page contributes its own images to the post.
 *
 * The Behance featured-projects feed (`feeds.feedburner.com/behance/vorr`)
 * carries one 404px crop per item and nothing else, while the project page it
 * links to holds 19 full-size images. The parser already fetches that page for
 * every item; Readability keeps the images and `sanitizeHtml` — whose
 * `allowedTags` has no `img` — used to throw them away.
 *
 * RAD-340: Readability chooses its container by TEXT, so a project with a
 * short description lost the whole text-less module grid (0 images in the
 * article). When that happens the parser now falls back to scanning the page
 * DOM itself, taking only images that declare a real size.
 *
 * Coverage:
 *   extractArticleContent:
 *     - returns the article's images in document order
 *     - drops a sized-below icon and a YouTube embed
 *     - caps the scan at ARTICLE_IMAGE_MAX
 *     - every early-return path returns `mediaUrls: []`, never undefined
 *     - page fallback: recovers a text-less grid Readability drops, no chrome
 *   extractMediaFromHTML options:
 *     - minInlineSize: unsized/percentage/exact-floor kept, ribbon + pixel dropped
 *     - baseUrl: a relative src is resolved before validation
 *     - imagesOnly: no <video>, no iframe — the feed-body call has no options
 *     - requireDeclaredSize: only images that declare a numeric dimension
 *   parseRSSFeed:
 *     - order is og:image → feed-level media → article images; cover stays og
 *     - an extensionless avatar never becomes the cover on a media-less feed
 *     - a failed page fetch parses exactly as before
 *     - the skip list still skips (no fetch at all)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("rss-parser", () => {
  const MockParser = vi.fn()
  MockParser.prototype.parseURL = vi.fn()
  return { default: MockParser }
})

import RSSParser from "rss-parser"
import {
  ARTICLE_IMAGE_MAX,
  ITEM_FETCH_CONCURRENCY,
  extractArticleContent,
  extractMediaFromHTML,
  parseRSSFeed,
} from "@/lib/parsers/rss"

const mockFetch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", mockFetch)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Readability drops an article under 500 characters of text, so every fixture
 * below carries this paragraph between images — a thin fixture would stay red
 * for the wrong reason.
 */
const PROSE =
  "<p>" +
  "A curator reads more than a thousand items a day and most of them waste the minute they cost. ".repeat(12) +
  "</p>"

const OG = "https://cdn.example.com/og/cover.jpg"
/** The extensionless author avatar Readability keeps ahead of the project images. */
const AVATAR = "https://pps.services.adobe.com/api/profile/158482803"

function projectImage(n: number, size = "1400"): string {
  return `https://mir-s3-cdn-cf.behance.net/project_modules/${size}/project-${n}.jpg`
}

function page(body: string, extraHead = ""): string {
  return `<!doctype html><html><head><title>Project</title>${extraHead}</head><body><article><h1>Project</h1>${body}</article></body></html>`
}

/**
 * A Behance-shaped project page (RAD-340), trimmed to the structure that
 * matters: the info block and the module grid are SIBLINGS inside one wrapper,
 * and the page has NO `<article>` tag — which is what makes Readability's
 * container the text block and keeps the grid out of `article.content`, no
 * matter how long the description is (measured against the real pages of ten
 * failing projects before this fixture was written).
 */
function behancePage(opts: { modules: number }): string {
  const modules = Array.from(
    { length: opts.modules },
    (_, i) => `<div class="module"><a href="#"><img src="${projectImage(i)}" width="1400" height="854"></a></div>`
  ).join("")
  return `<!doctype html><html><head><title>Project</title></head><body class="logged-out">
  <main><div id="site-content" class="site-content"><div class="Project-wrapper"><div class="Project-main">
    <div class="project-content-wrap">
      <div class="ProjectInfo-projectFooter qa-project-info">
        <h2>Project Title</h2>
        <div class="desc">${PROSE}</div>
        <p>Published: today</p>
      </div>
      <div id="primary-project-content" class="project-styles">
        ${modules}
        <img src="${AVATAR}">
        <img src="https://a5.behance.net/abc/img/site/blank.png">
        <img src="https://a5.behance.net/abc/icons/ribbons/1x/network.png" width="31" height="57">
      </div>
    </div>
  </div></div></div></main>
</body></html>`
}

function htmlResponse(html: string, url = "https://example.com/p/1"): Response {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers(),
    text: async () => html,
  } as unknown as Response
}

function feed(items: unknown[]) {
  return { title: "Behance Featured", items } as never
}

describe("extractArticleContent — the article's own images survive the scrape", () => {
  it("returns the body images in document order, and still returns ogImage", async () => {
    mockFetch.mockResolvedValue(
      htmlResponse(
        page(
          `${PROSE}<img src="${projectImage(1)}" width="1400" height="1050">${PROSE}<img src="${projectImage(2)}" width="1400" height="1050">${PROSE}`,
          `<meta property="og:image" content="${OG}">`
        )
      )
    )

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
    expect(result.ogImage).toBe(OG)
    // The scan has to happen before sanitizeHtml: `img` is not an allowed tag.
    expect(result.content).not.toContain("<img")
  })

  it("drops a sized-below ribbon icon and a YouTube embed, keeping the project images", async () => {
    mockFetch.mockResolvedValue(
      htmlResponse(
        page(
          `${PROSE}<img src="https://a5.behance.net/abc/icons/ribbons/1x/network.png" width="31" height="57"><img src="${projectImage(1)}" width="1400" height="1050"><iframe src="https://www.youtube.com/embed/xyz"></iframe>${PROSE}`
        )
      )
    )

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toEqual([projectImage(1)])
    expect(result.mediaUrls.join(" ")).not.toContain("youtube.com")
  })

  it("caps the scan at ARTICLE_IMAGE_MAX, keeping document order", async () => {
    const body = Array.from({ length: 25 }, (_, i) => `${PROSE}<img src="${projectImage(i)}" width="1400" height="1050">`).join("")
    mockFetch.mockResolvedValue(htmlResponse(page(body)))

    const result = await extractArticleContent("https://example.com/p/1")

    expect(ARTICLE_IMAGE_MAX).toBe(24)
    expect(result.mediaUrls).toHaveLength(ARTICLE_IMAGE_MAX)
    expect(result.mediaUrls[0]).toBe(projectImage(0))
    expect(result.mediaUrls[ARTICLE_IMAGE_MAX - 1]).toBe(projectImage(ARTICLE_IMAGE_MAX - 1))
    expect(result.mediaUrls).not.toContain(projectImage(24))
  })

  it("counts distinct images against the cap — a repeated URL does not eat a slot", async () => {
    // 25 tags, 24 distinct: image 0 twice, then 0..23. Without the dedup the
    // first 24 scan slots would hold 23 real frames and drop the last one.
    const body =
      `${PROSE}<img src="${projectImage(0)}" width="1400">${PROSE}<img src="${projectImage(0)}" width="1400">` +
      Array.from({ length: 24 }, (_, i) => `${PROSE}<img src="${projectImage(i)}" width="1400">`).join("")
    mockFetch.mockResolvedValue(htmlResponse(page(body)))

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toHaveLength(ARTICLE_IMAGE_MAX)
    expect(new Set(result.mediaUrls).size).toBe(ARTICLE_IMAGE_MAX)
    expect(result.mediaUrls).toContain(projectImage(23))
  })

  it("returns mediaUrls: [] on every early-return path, never undefined", async () => {
    const empty = { content: "", ogImage: null, mediaUrls: [], mediaFromPageFallback: false }

    const blocked = await extractArticleContent("http://127.0.0.1/secret")
    expect(blocked).toEqual(empty)

    // A redirect that lands on a disallowed host is refused the same way.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: "http://127.0.0.1/",
      headers: new Headers(),
      text: async () => page(PROSE),
    } as unknown as Response)
    expect(await extractArticleContent("https://example.com/p/1")).toEqual(empty)

    mockFetch.mockResolvedValue({
      ok: false,
      status: 307,
      url: "https://example.com/p/1",
      headers: new Headers(),
    } as unknown as Response)
    expect(await extractArticleContent("https://example.com/p/1")).toEqual(empty)

    // Over the 5MB response cap.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://example.com/p/1",
      headers: new Headers({ "content-length": "6000000" }),
      text: async () => "",
    } as unknown as Response)
    expect(await extractArticleContent("https://example.com/p/1")).toEqual(empty)

    // A WAF challenge page that answers 200.
    mockFetch.mockResolvedValue(htmlResponse("<html><body>sucuri_cloudproxy_js</body></html>"))
    expect(await extractArticleContent("https://example.com/p/1")).toEqual(empty)
  })
})

describe("extractArticleContent — page fallback when Readability keeps no images", () => {
  it("recovers the module grid of a text-less portfolio page", async () => {
    // RAD-340: Readability's container is chosen by text; Behance project pages
    // have no <article> tag and the module grid carries no prose, so the
    // article comes back with 0 images while the raw page holds all of them.
    mockFetch.mockResolvedValue(htmlResponse(behancePage({ modules: 3 })))

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toEqual([projectImage(0), projectImage(1), projectImage(2)])
    expect(result.mediaFromPageFallback).toBe(true)
    expect(result.content.length).toBeGreaterThan(0)
  })

  it("admits no unsized page chrome in the fallback", async () => {
    // The fixture's grid also holds the author avatar, Behance's `blank.png`
    // placeholder and the 31×57 ribbon — all page furniture. Only images that
    // declare a real size survive: the modules.
    mockFetch.mockResolvedValue(htmlResponse(behancePage({ modules: 2 })))

    const result = await extractArticleContent("https://example.com/p/1")

    const joined = result.mediaUrls.join(" ")
    expect(joined).not.toContain("pps.services.adobe.com")
    expect(joined).not.toContain("blank.png")
    expect(joined).not.toContain("ribbons")
  })

  it("does not consult the page DOM when the article kept images", async () => {
    // A sized related-content banner outside the article: the article path
    // wins, so the fallback never runs and the banner stays out.
    mockFetch.mockResolvedValue(
      htmlResponse(
        page(`${PROSE}<img src="${projectImage(1)}" width="1400" height="854">${PROSE}`).replace(
          "</body>",
          `<div class="related"><img src="https://cdn.example.com/related/banner.jpg" width="1200" height="630"></div></body>`
        )
      )
    )

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toEqual([projectImage(1)])
    expect(result.mediaFromPageFallback).toBe(false)
  })

  it("caps the fallback list at ARTICLE_IMAGE_MAX", async () => {
    mockFetch.mockResolvedValue(htmlResponse(behancePage({ modules: 30 })))

    const result = await extractArticleContent("https://example.com/p/1")

    expect(result.mediaUrls).toHaveLength(ARTICLE_IMAGE_MAX)
    expect(result.mediaUrls[0]).toBe(projectImage(0))
    expect(result.mediaUrls).not.toContain(projectImage(29))
  })
})

describe("extractMediaFromHTML options", () => {
  it("keeps an <img> that declares no size, an exact floor, or a percentage", () => {
    const html = `
      <img src="https://x/unsized.jpg">
      <img src="https://x/floor.jpg" width="200">
      <img src="https://x/percent.jpg" width="100%">
      <img src="https://x/only-height.jpg" height="1000">
    `
    expect(extractMediaFromHTML(html, { minInlineSize: 200 })).toEqual([
      "https://x/unsized.jpg",
      "https://x/floor.jpg",
      "https://x/percent.jpg",
      "https://x/only-height.jpg",
    ])
  })

  it("drops a ribbon icon, a tracking pixel and anything a hair under the floor", () => {
    const html = `
      <img src="https://a5.behance.net/ribbon.png" width="31" height="57">
      <img src="https://x/pixel.gif" width="1" height="1">
      <img src="https://x/just-under.jpg" width="199">
      <img src="https://x/kept.jpg" width="1400">
    `
    expect(extractMediaFromHTML(html, { minInlineSize: 200 })).toEqual(["https://x/kept.jpg"])
  })

  it("requireDeclaredSize admits only an image that declares a numeric dimension", () => {
    // The whole-page fallback's rule (RAD-340): page chrome is unsized, so an
    // image has to prove its size to ride along; a percentage proves nothing.
    const html = `
      <img src="https://x/sized.jpg" width="1400" height="854">
      <img src="https://x/unsized.jpg">
      <img src="https://x/percentage.jpg" width="100%">
      <img src="https://x/icon.png" width="31" height="57">
      <img src="https://x/height-only.jpg" height="900">
    `
    expect(extractMediaFromHTML(html, { requireDeclaredSize: true, minInlineSize: 200 })).toEqual([
      "https://x/sized.jpg",
      "https://x/height-only.jpg",
    ])
  })

  it("treats a bare 0 as below the floor — a width-less tracking pixel", () => {
    expect(extractMediaFromHTML(`<img src="https://x/zero.gif" width="0">`, { minInlineSize: 200 })).toEqual([])
  })

  it("resolves a relative src against baseUrl before validating", () => {
    expect(
      extractMediaFromHTML(`<img src="/media/one.jpg"><img src="two.jpg">`, {
        baseUrl: "https://example.com/p/1",
      })
    ).toEqual(["https://example.com/media/one.jpg", "https://example.com/p/two.jpg"])
  })

  it("without a baseUrl a relative src cannot become a valid media URL — same as today", () => {
    expect(extractMediaFromHTML(`<img src="/media/one.jpg">`)).toEqual([])
  })

  it("imagesOnly drops <video> and iframe embeds but keeps the images", () => {
    const html = `
      <img src="https://x/one.jpg">
      <video src="https://x/clip.mp4"></video>
      <iframe src="https://www.youtube.com/embed/abc"></iframe>
    `
    expect(extractMediaFromHTML(html, { imagesOnly: true })).toEqual(["https://x/one.jpg"])
  })

  it("without options the feed-body scan is unchanged — videos and embeds still collected", () => {
    const html = `
      <img src="https://x/one.jpg" width="31" height="57">
      <video src="https://x/clip.mp4"></video>
      <iframe src="https://www.youtube.com/embed/abc"></iframe>
    `
    expect(extractMediaFromHTML(html)).toEqual([
      "https://x/one.jpg",
      "https://x/clip.mp4",
      "https://www.youtube.com/embed/abc",
    ])
  })
})

describe("parseRSSFeed — article images append after feed-level media", () => {
  const FEED_URL = "https://feeds.example.com/behance.xml"
  const LINK = "https://www.behance.net/gallery/255684893/slug"
  const BODY_IMAGE = "https://feed.example.com/assets/body.jpg"

  function mockFeedItems(items: unknown[]) {
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue(feed(items))
  }

  it("orders og:image, feed-body image, then article images; the cover stays og:image", async () => {
    mockFeedItems([
      { title: "Project", link: LINK, guid: "g1", content: `<p>Body</p><img src="${BODY_IMAGE}">` },
    ])
    mockFetch.mockResolvedValue(
      htmlResponse(
        page(
          `${PROSE}<img src="${projectImage(1)}" width="1400"><img src="${projectImage(2)}" width="1400">${PROSE}`,
          `<meta property="og:image" content="${OG}">`
        )
      )
    )

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].mediaUrls).toEqual([OG, BODY_IMAGE, projectImage(1), projectImage(2)])
    expect(items[0].thumbnailUrl).toBe(OG)
  })

  it("never lets an extensionless avatar become the cover when the feed has no media", async () => {
    mockFeedItems([{ title: "Project", link: LINK, guid: "g2" }])
    mockFetch.mockResolvedValue(
      htmlResponse(page(`${PROSE}<img src="${AVATAR}"><img src="${projectImage(1)}" width="1400">${PROSE}`))
    )

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].thumbnailUrl).toBe(projectImage(1))
    expect(items[0].thumbnailUrl).not.toBe(AVATAR)
  })

  it("leaves the cover undefined when the feed has no media and the only article image is extensionless", async () => {
    mockFeedItems([{ title: "Project", link: LINK, guid: "g5" }])
    mockFetch.mockResolvedValue(htmlResponse(page(`${PROSE}<img src="${AVATAR}">${PROSE}`)))

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].thumbnailUrl).toBeUndefined()
  })

  it("keeps the feed-level spelling when an article image repeats it", async () => {
    mockFeedItems([
      { title: "Project", link: LINK, guid: "g6", content: `<p>Body</p><img src="${BODY_IMAGE}">` },
    ])
    mockFetch.mockResolvedValue(htmlResponse(page(`${PROSE}<img src="${BODY_IMAGE}" width="1400">${PROSE}`)))

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].mediaUrls).toEqual([BODY_IMAGE])
    expect(items[0].thumbnailUrl).toBe(BODY_IMAGE)
  })

  it("a failed page fetch parses exactly as before — feed-level media and cover untouched", async () => {
    mockFeedItems([
      {
        title: "Project",
        link: LINK,
        guid: "g3",
        content: `<p>Body</p><img src="${BODY_IMAGE}" width="1" height="1">`,
      },
    ])
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))

    const items = await parseRSSFeed(FEED_URL)

    // The feed body keeps its own media through the unguarded scan — including
    // the small one the article scan would have dropped (RAD-336 AC 6).
    expect(items[0].mediaUrls).toEqual([BODY_IMAGE])
    expect(items[0].thumbnailUrl).toBe(BODY_IMAGE)
  })

  it("does not fetch pages on the skip list — every entry stays untouched", async () => {
    const links = [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://www.reddit.com/r/design",
      "https://nitter.net/someone/status/1",
      "https://bsky.app/profile/someone.bsky.social/post/1",
      "https://example.com/paper.pdf",
    ]
    mockFeedItems(
      links.map((link, i) => ({ title: `Item ${i}`, link, guid: `g${i}`, content: `<img src="${BODY_IMAGE}">` }))
    )

    const items = await parseRSSFeed(FEED_URL)

    expect(mockFetch).not.toHaveBeenCalled()
    expect(items).toHaveLength(links.length)
    expect(items[0].mediaUrls).toEqual([BODY_IMAGE])
  })

  it("never promotes a fallback-scraped page image to the cover", async () => {
    // An ordinary text-only article whose page carries a sized site logo. A
    // whole-page scrape has no container, so a logo (or a related-card
    // thumbnail) must not become the card's face — on a media-less feed the
    // old rule would have made exactly that the cover (RAD-340).
    mockFeedItems([{ title: "Article", link: LINK, guid: "g7" }])
    mockFetch.mockResolvedValue(
      htmlResponse(
        page(PROSE).replace(
          "</body>",
          `<div class="site-header"><img src="https://cdn.example.com/brand/logo.png" width="320" height="320"></div></body>`
        )
      )
    )

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].thumbnailUrl).toBeUndefined()
  })

  it("bounds how many article pages are fetched at once", async () => {
    // The loop used to fire all 20 pages at once; each Readability parse is
    // ~1s of SYNCHRONOUS CPU, so the burst blew every fetch's 5s deadline and
    // items silently lost their article images (measured on the live Behance
    // feed: 9–13 of 20 timed out). The limiter keeps a few in flight so each
    // parse finishes inside its own timeout — and more than one, or the
    // article fetches would serialise the whole feed.
    mockFeedItems(
      Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, link: `https://example.com/p/${i}`, guid: `g${i}` }))
    )
    let inFlight = 0
    let maxInFlight = 0
    mockFetch.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight--
      return htmlResponse(page(PROSE))
    })

    await parseRSSFeed(FEED_URL)

    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(ITEM_FETCH_CONCURRENCY)
    expect(maxInFlight).toBeLessThan(12)
  })
})

/**
 * RAD-432 — on Land Book the item's own image is a full-page screenshot of the
 * featured site and the article's og:image is Landbook's branded social card.
 * The cover policy must prefer the screenshot there and stay og-first elsewhere.
 */
describe("parseRSSFeed — Land Book cover policy (RAD-432)", () => {
  const FEED_URL = "https://land-book.com/feed"
  const LINK = "https://land-book.com/websites/102061-relume"
  const SHOT =
    "https://cdn.land-book.com/image/0x0:2880x4320/600x0/filters:format(jpeg)/website/102061/512a0a20d630be65-screenshot-upload?signature=137a0303e549f36fddc0df712db82e7234d25688fdc0be7a75b949d9224b4d43"
  const OG_CARD =
    "https://cdn.land-book.com/website/102061/102061-relume-ai-website-builder-for-marketing-websites-1793868978-og-image.webp"
  const BODY_IMAGE = "https://feed.example.com/assets/body.jpg"

  function mockFeedItems(items: unknown[]) {
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue(feed(items))
  }

  it("stores the full-page screenshot as the cover, not the branded og card", async () => {
    mockFeedItems([{ title: "Relume", link: LINK, guid: "lb1", content: `<p>Site</p><img src="${SHOT}">` }])
    mockFetch.mockResolvedValue(
      htmlResponse(page(PROSE, `<meta property="og:image" content="${OG_CARD}">`))
    )

    const items = await parseRSSFeed(FEED_URL)

    expect(items[0].thumbnailUrl).toBe(SHOT)
    expect(items[0].mediaUrls).toContain(SHOT)
  })

  it("keeps the og:image cover rule for every other feed", async () => {
    // No Landbook URLs here: the preference is scoped by image URL, so an
    // ordinary feed still takes its og:image as the cover.
    mockFeedItems([
      { title: "Post", link: "https://example.com/post", guid: "other1", content: `<p>Body</p><img src="${BODY_IMAGE}">` },
    ])
    mockFetch.mockResolvedValue(
      htmlResponse(page(PROSE, `<meta property="og:image" content="${OG}">`))
    )

    const items = await parseRSSFeed("https://example.com/feed")

    expect(items[0].thumbnailUrl).toBe(OG)
  })
})
