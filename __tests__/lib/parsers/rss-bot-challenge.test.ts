/**
 * RAD-395 — www.behance.net answers prod's article-page fetch with a 200
 * bot-check interstitial ("A required part of this site couldn’t load…").
 *
 * Before the fix `extractArticleContent` treated any 2xx as an article:
 * Readability stored the notice as content, no images were found, nothing was
 * logged, and the post kept only the feed's 404px cover. The fix:
 *
 *   1. a small 2xx page carrying the notice is a FAILED fetch (warn names the host);
 *      a long real article quoting the phrase is still extracted
 *   2. Behance `/gallery/<id>/…` only: a blocked fetch (interstitial, or 403 after
 *      the js_challenge retry) falls back to ONE reader request
 *      `https://r.jina.ai/<url>`, whose markdown yields THIS project's modules
 *      (doc order, deduped by file name, capped at 24)
 *   3. `parseRSSFeed(url, { knownItems })` skips the page fetch for stored items
 *
 * Challenge cookies live in a module-level Map, and these tests hit the real
 * `www.behance.net` origin, so every test re-imports the module after
 * `vi.resetModules()` (see `load()`); the rss-parser mock is re-imported with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("rss-parser", () => {
  const MockParser = vi.fn()
  MockParser.prototype.parseURL = vi.fn()
  return { default: MockParser }
})

const mockFetch = vi.fn()
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
  vi.stubEnv("JINA_API_KEY", undefined)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Fresh module graph per test: no challenge cookie leaks between tests. */
async function load() {
  vi.resetModules()
  const RSSParser = (await import("rss-parser")).default
  const rss = await import("@/lib/parsers/rss")
  return { RSSParser, ...rss }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const READER = "https://r.jina.ai/"
const PROJECT_ID = "249266497"
const GALLERY = `https://www.behance.net/gallery/${PROJECT_ID}/Our-very-first-painting-exhibition`
const CDN = "https://mir-s3-cdn-cf.behance.net"

const NOTICE_CURLY =
  "A required part of this site couldn’t load. This may be due to a browser extension, network issues, or browser settings. Please check your connection, disable any ad blockers, or try using a different browser."
const NOTICE_STRAIGHT = NOTICE_CURLY.replace("’", "'")

/** The real interstitial's shape: a notice paragraph and the fingerprint script. */
function interstitial(notice = NOTICE_CURLY): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Behance</title>
    <style>body{font-family:sans-serif;margin:0;padding:48px;color:#191919}p{max-width:560px;line-height:1.5}</style>
  </head>
  <body>
    <div class="container">
      <p>${notice}</p>
    </div>
    <script src="/_fs-ch-1T1wmsGaOgGaSxcX/script.js"></script>
  </body>
</html>`
}

const PROSE =
  "<p>" +
  "A curator reads more than a thousand items a day and most of them waste the minute they cost. ".repeat(12) +
  "</p>"

function articlePage(body: string): string {
  return `<!doctype html><html><head><title>Article</title></head><body><article><h1>Article</h1>${body}</article></body></html>`
}

/** A project-module file name in Behance's shape: `<6 hex><project id>.<hex>.jpg`. */
function moduleFile(n: number, projectId = PROJECT_ID): string {
  const prefix = (0x2d0277 + n).toString(16).padStart(6, "0").slice(-6)
  return `${prefix}${projectId}.6a04${(0x10000 + n).toString(16)}e06.jpg`
}

function moduleUrl(n: number, size = "1400_webp", projectId = PROJECT_ID): string {
  return `${CDN}/project_modules/${size}/${moduleFile(n, projectId)}`
}

const AVATAR = "https://pps.services.adobe.com/api/profile/158482803/avatar.jpg?size=115"
const PROJECT_COVER_404 = `${CDN}/projects/404/7c1a0b${PROJECT_ID}.6a0404805ce06.jpg`
const OTHER_PROJECT_MODULE = moduleUrl(1, "1400_webp", "255684893")

/**
 * r.jina.ai output for the project. `count` project modules, plus: a 404 cover
 * of THIS project, the author avatar, the first module again at another size,
 * and a module of another project — none of which may reach mediaUrls.
 */
function readerMarkdown(count = 3): string {
  const modules = Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const size = n === 2 ? "max_3840_webp" : "1400_webp"
    const img = `![Image ${n + 1}: shopping mall graphic design](${moduleUrl(n, size)})`
    return n === 1
      ? `[${img}](${GALLERY}/modules/1443653593)\n\nSelected to exhibit at a Starfield center in Korea...`
      : img
  })
  // The duplicate of module 1 and the other project's module sit after module 2.
  modules.splice(2, 0, `![Image dup](${moduleUrl(1, "max_1200_webp")})`, `[![More from the owner](${OTHER_PROJECT_MODULE})](https://www.behance.net/gallery/255684893/Other)`)
  return `Title: Our very first painting exhibition - MOMENT SERIES

URL Source: ${GALLERY}

Markdown Content:
[![Image 1: Studio Moment](${AVATAR})](https://www.behance.net/studiomoment)

![Cover](${PROJECT_COVER_404})

${modules.join("\n\n")}

Published: October 2, 2026
`
}

function respond(body: string, status: number, url: string): Response {
  const res = new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
  Object.defineProperty(res, "url", { value: url })
  return res
}

type FetchInit = { headers?: HeadersInit } | undefined
type Handler = (url: string, init: FetchInit) => Response | Promise<Response>

/** Route each fetch: reader requests to `reader`, everything else to `direct`. */
function serve(direct: Handler, reader: Handler = () => respond(readerMarkdown(), 200, "")) {
  mockFetch.mockImplementation(async (input: unknown, init?: FetchInit) => {
    const url = String(input)
    return url.startsWith(READER) ? reader(url, init) : direct(url, init)
  })
}

function readerCalls(): Array<[string, FetchInit]> {
  return mockFetch.mock.calls
    .filter(([input]) => String(input).startsWith(READER))
    .map(([input, init]) => [String(input), init as FetchInit])
}

function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map(([input]) => String(input))
}

function warnText(): string {
  return warnSpy.mock.calls
    .map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "))
    .join("\n")
}

const CHALLENGE_VALUE = "539c48f56299bf3095f90c149d9312b3"
const COOKIE = `js_challenge_value=${CHALLENGE_VALUE}`
const challengeBody = `<!doctype html><html><head><meta name="robots" content="noindex,nofollow"></head><body><script>
  document.cookie = "js_challenge_value=${CHALLENGE_VALUE}; Path=/";
  window.location.reload();
</script></body></html>`

function cookieOf(init: FetchInit): string | null {
  return new Headers(init?.headers).get("cookie")
}

// Module 2 arrives as max_3840_webp and is stored at 1400_webp (RAD-395).
const EXPECTED_GALLERY = [moduleUrl(1), moduleUrl(2), moduleUrl(3)]

// ---------------------------------------------------------------------------
// 1. Interstitial detection
// ---------------------------------------------------------------------------

describe("extractArticleContent — a 2xx bot-check interstitial is a failed fetch", () => {
  it.each([
    ["curly apostrophe", NOTICE_CURLY],
    ["straight apostrophe", NOTICE_STRAIGHT],
  ])("AC-1: a non-Behance interstitial (%s) yields no content, no reader call, and a warn naming the host", async (_label, notice) => {
    const { extractArticleContent } = await load()
    const url = "https://news.example.test/2026/10/story"
    serve((u) => respond(interstitial(notice), 200, u))

    const result = await extractArticleContent(url)

    expect(result).toEqual({ content: "", ogImage: null, mediaUrls: [], mediaFromPageFallback: false })
    expect(readerCalls()).toEqual([])
    expect(warnText()).toContain("news.example.test")
  })

  it("AC-1: a long real article (> 50 000 chars) quoting the notice is still extracted, while the short interstitial is not", async () => {
    const { extractArticleContent } = await load()
    const longBody = `${PROSE}<p>One reader wrote: “${NOTICE_CURLY}”</p>` + PROSE.repeat(60)
    const longPage = articlePage(longBody)
    expect(longPage.length).toBeGreaterThan(50_000)
    serve((u) =>
      u.includes("/long/") ? respond(longPage, 200, u) : respond(interstitial(), 200, u)
    )

    const blocked = await extractArticleContent("https://blog.example.test/short/1")
    const article = await extractArticleContent("https://blog.example.test/long/1")

    expect(blocked.content).toBe("")
    expect(article.content).toContain("One reader wrote")
    expect(article.content).toContain("A curator reads more than a thousand items a day")
  })
})

// ---------------------------------------------------------------------------
// 2. Behance reader fallback
// ---------------------------------------------------------------------------

describe("extractArticleContent — Behance gallery falls back to the reader when blocked", () => {
  it("AC-2: a 200 interstitial on a gallery URL → ONE reader GET on r.jina.ai/<url>; mediaUrls are this project's modules", async () => {
    const { extractArticleContent } = await load()
    serve((u) => respond(interstitial(), 200, u))

    const result = await extractArticleContent(GALLERY)

    expect(readerCalls().map(([u]) => u)).toEqual([`${READER}${GALLERY}`])
    expect(result).toEqual({
      content: "",
      ogImage: null,
      mediaUrls: EXPECTED_GALLERY,
      mediaFromPageFallback: false,
    })
    expect(warnText()).toContain("www.behance.net")
  })

  it("AC-2: a 403 that is still 403 after the js_challenge retry falls back to the reader", async () => {
    const { extractArticleContent } = await load()
    serve((u) => respond(challengeBody, 403, u))

    const result = await extractArticleContent(GALLERY)

    // Existing retry contract kept: the direct URL is tried twice, the 2nd with the cookie.
    const direct = mockFetch.mock.calls.filter(([input]) => String(input) === GALLERY)
    expect(direct).toHaveLength(2)
    expect(cookieOf(direct[1][1] as FetchInit)).toBe(COOKIE)
    expect(readerCalls().map(([u]) => u)).toEqual([`${READER}${GALLERY}`])
    expect(result.mediaUrls).toEqual(EXPECTED_GALLERY)
    expect(result.content).toBe("")
  })

  it("AC-2: a max_3840_webp module is stored at 1400_webp; a max_1200_webp module keeps its size", async () => {
    const { extractArticleContent } = await load()
    const markdown = [
      `![a](${moduleUrl(1, "max_3840_webp")})`,
      `![b](${moduleUrl(2, "max_1200_webp")})`,
    ].join("\n\n")
    serve((u) => respond(interstitial(), 200, u), () => respond(markdown, 200, ""))

    const result = await extractArticleContent(GALLERY)

    expect(result.mediaUrls).toEqual([moduleUrl(1, "1400_webp"), moduleUrl(2, "max_1200_webp")])
  })

  it("AC-2: dedupes by file name (first size wins) and caps at 24 project modules, in document order", async () => {
    const { extractArticleContent } = await load()
    serve((u) => respond(interstitial(), 200, u), () => respond(readerMarkdown(30), 200, ""))

    const result = await extractArticleContent(GALLERY)

    const expected = Array.from({ length: 24 }, (_, i) => moduleUrl(i + 1))
    expect(result.mediaUrls).toEqual(expected)
    expect(result.mediaUrls).not.toContain(moduleUrl(1, "max_1200_webp"))
    expect(result.mediaUrls).not.toContain(OTHER_PROJECT_MODULE)
    expect(result.mediaUrls).not.toContain(AVATAR)
    expect(result.mediaUrls).not.toContain(PROJECT_COVER_404)
  })

  it("AC-2: JINA_API_KEY set → the reader request carries `Authorization: Bearer <key>`", async () => {
    vi.stubEnv("JINA_API_KEY", "jina_test_key_123")
    const { extractArticleContent } = await load()
    serve((u) => respond(interstitial(), 200, u))

    await extractArticleContent(GALLERY)

    const calls = readerCalls()
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0][1]?.headers).get("authorization")).toBe("Bearer jina_test_key_123")
  })

  it("AC-2: JINA_API_KEY unset → the reader request has no Authorization header", async () => {
    vi.stubEnv("JINA_API_KEY", undefined)
    const { extractArticleContent } = await load()
    serve((u) => respond(interstitial(), 200, u))

    await extractArticleContent(GALLERY)

    const calls = readerCalls()
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0][1]?.headers).get("authorization")).toBeNull()
  })

  it("AC-2: the reader is NOT called when the direct fetch succeeds (normal page, or solved js_challenge) — only for the blocked one", async () => {
    const { extractArticleContent } = await load()
    const okPage = articlePage(`${PROSE}<img src="${moduleUrl(7)}" width="1400" height="1050">${PROSE}`)
    const solved = `https://www.behance.net/gallery/${PROJECT_ID}/solved`
    const plain = `https://www.behance.net/gallery/${PROJECT_ID}/plain`
    serve((u, init) => {
      if (u === plain) return respond(okPage, 200, u)
      if (u === solved) return cookieOf(init) === COOKIE ? respond(okPage, 200, u) : respond(challengeBody, 403, u)
      return respond(interstitial(), 200, u)
    })

    const plainResult = await extractArticleContent(plain)
    const solvedResult = await extractArticleContent(solved)
    expect(readerCalls()).toEqual([])
    expect(plainResult.mediaUrls).toEqual([moduleUrl(7)])
    expect(solvedResult.mediaUrls).toEqual([moduleUrl(7)])

    // Positive control: the same harness DOES reach the reader for a blocked gallery.
    await extractArticleContent(GALLERY)
    expect(readerCalls().map(([u]) => u)).toEqual([`${READER}${GALLERY}`])
  })

  it("AC-2: a non-Behance host still 403 after the challenge retry keeps throwing and never reaches the reader (Behance control does)", async () => {
    const { extractArticleContent } = await load()
    serve((u) => respond(challengeBody, 403, u))

    await expect(extractArticleContent("https://portfolio.example.test/gallery/1/slug")).rejects.toThrow(/status: 403/)
    expect(readerCalls()).toEqual([])

    const result = await extractArticleContent(GALLERY)
    expect(readerCalls().map(([u]) => u)).toEqual([`${READER}${GALLERY}`])
    expect(result.mediaUrls).toEqual(EXPECTED_GALLERY)
  })

  it.each([
    ["429 from the reader", () => respond("Too Many Requests", 429, "")],
    ["network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["markdown with no project modules", () =>
      respond(`Title: Behance\n\nURL Source: ${GALLERY}\n\nMarkdown Content:\n![Avatar](${AVATAR})\n\n![Other](${OTHER_PROJECT_MODULE})\n`, 200, "")],
    ["the reader itself got the interstitial", () =>
      respond(`Title: Behance\n\nURL Source: ${GALLERY}\n\nMarkdown Content:\n${NOTICE_CURLY}\n`, 200, "")],
  ])("ERR-1: reader failure (%s) resolves with empty content and no media, and warns", async (_label, reader) => {
    const { extractArticleContent } = await load()
    serve((u) => respond(interstitial(), 200, u), reader as Handler)

    const result = await extractArticleContent(GALLERY)

    expect(readerCalls()).toHaveLength(1)
    expect(result).toEqual({ content: "", ogImage: null, mediaUrls: [], mediaFromPageFallback: false })
    expect(warnSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. knownItems — stored items are not re-fetched
// ---------------------------------------------------------------------------

describe("parseRSSFeed — knownItems skips the page fetch for stored items", () => {
  it("AC-3: knownItems is called once, before any page fetch, with one {url, externalId} per item; known items (by url or externalId) are returned but not fetched", async () => {
    const { RSSParser, parseRSSFeed } = await load()
    const knownByUrl = GALLERY
    const knownByGuid = "https://news.example.test/known-by-guid"
    const fresh = "https://news.example.test/fresh"
    const feedImg = "https://feed.example.test/img/cover-a.jpg"
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Mixed",
      items: [
        { title: "A", link: knownByUrl, guid: "guid-a", content: `<p>Feed body A</p><img src="${feedImg}">` },
        { title: "B", link: knownByGuid, guid: "guid-b", content: "<p>Feed body B</p>" },
        { title: "C", link: fresh, content: "<p>Feed body C</p>" },
      ],
    } as never)

    const order: string[] = []
    serve((u) => {
      order.push(`fetch ${u}`)
      return respond(articlePage(`${PROSE}<p>Full article text</p>`), 200, u)
    })
    const knownItems = vi.fn(async (candidates: { url: string; externalId: string }[]) => {
      order.push("knownItems")
      expect(candidates).toEqual([
        { url: knownByUrl, externalId: "guid-a" },
        { url: knownByGuid, externalId: "guid-b" },
        { url: fresh, externalId: fresh },
      ])
      return new Set([knownByUrl, "guid-b"])
    })

    const items = await parseRSSFeed("https://feeds.example.test/mixed.xml", { knownItems })

    expect(knownItems).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe("knownItems")
    expect(fetchedUrls()).toEqual([fresh])
    expect(items.map((i) => i.url)).toEqual([knownByUrl, knownByGuid, fresh])
    expect(items[0].mediaUrls).toEqual([feedImg])
    expect(items[0].content).toContain("Feed body A")
    expect(items[1].content).toContain("Feed body B")
    expect(items[2].content).toContain("Full article text")
  })

  it("AC-3: a knownItems lookup that rejects fails open — every item is still fetched and returned", async () => {
    const { RSSParser, parseRSSFeed } = await load()
    const a = "https://news.example.test/a"
    const b = "https://news.example.test/b"
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Feed",
      items: [
        { title: "A", link: a, content: "<p>A</p>" },
        { title: "B", link: b, content: "<p>B</p>" },
      ],
    } as never)
    serve((u) => respond(articlePage(`${PROSE}<p>Full article text</p>`), 200, u))
    const knownItems = vi.fn(async () => {
      throw new Error("P2024 pool timeout")
    })

    const items = await parseRSSFeed("https://feeds.example.test/feed.xml", { knownItems })

    expect(items.map((i) => i.url)).toEqual([a, b])
    expect(fetchedUrls().sort()).toEqual([a, b])
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe("extractArticleContent — reader edge cases", () => {
  it("a module of another project whose id merely contains this id is not part of the gallery", async () => {
    const { extractArticleContent } = await load()
    // 24926649 is a substring of 249266497 — a shorter, older project id.
    const shortId = "24926649"
    const gallery = `https://www.behance.net/gallery/${shortId}/Older`
    const markdown = [`![x](${moduleUrl(1, "1400_webp", PROJECT_ID)})`, `![y](${moduleUrl(2, "1400_webp", shortId)})`].join("\n\n")
    serve((u) => respond(interstitial(), 200, u), () => respond(markdown, 200, ""))

    const result = await extractArticleContent(gallery)

    expect(result.mediaUrls).toEqual([moduleUrl(2, "1400_webp", shortId)])
  })

  it("an animated .gif module keeps its max_3840_webp URL (no 1400 rendition is assumed)", async () => {
    const { extractArticleContent } = await load()
    const gif = `${CDN}/project_modules/max_3840_webp/aa0001${PROJECT_ID}.6a04aa.gif`
    serve((u) => respond(interstitial(), 200, u), () => respond(`![g](${gif})`, 200, ""))

    const result = await extractArticleContent(GALLERY)

    expect(result.mediaUrls).toEqual([gif])
  })

  it("a gallery link without www and with a fragment reaches the reader as the canonical page URL", async () => {
    const { extractArticleContent } = await load()
    const bare = `https://behance.net/gallery/${PROJECT_ID}/Our-very-first-painting-exhibition#modules`
    serve((u) => respond(interstitial(), 200, u))

    const result = await extractArticleContent(bare)

    expect(readerCalls().map(([u]) => u)).toEqual([
      `${READER}https://behance.net/gallery/${PROJECT_ID}/Our-very-first-painting-exhibition`,
    ])
    expect(result.mediaUrls).toEqual(EXPECTED_GALLERY)
  })

  it("a reader response that redirects to an internal host is refused without requesting it", async () => {
    const { extractArticleContent } = await load()
    serve(
      (u) => respond(interstitial(), 200, u),
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })
    )

    const result = await extractArticleContent(GALLERY)

    expect(result.mediaUrls).toEqual([])
    expect(fetchedUrls()).not.toContain("http://169.254.169.254/latest")
  })

  it("at most two reader requests are in flight at once across concurrent extractions", async () => {
    const { extractArticleContent } = await load()
    let inFlight = 0
    let peak = 0
    serve(
      (u) => respond(interstitial(), 200, u),
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return respond(readerMarkdown(), 200, "")
      }
    )
    const ids = ["256352877", "256362535", "215482017", "256519655", "251333757"]

    const results = await Promise.all(ids.map((id) => extractArticleContent(`https://www.behance.net/gallery/${id}/x`)))

    expect(readerCalls()).toHaveLength(5)
    expect(peak).toBe(2)
    expect(results).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// 5. End to end through parseRSSFeed
// ---------------------------------------------------------------------------

describe("parseRSSFeed — a Behance item behind the interstitial still gets its gallery", () => {
  it("AC-5: mediaUrls = feed cover + reader gallery modules; content is the feed prose, never the notice", async () => {
    const { RSSParser, parseRSSFeed } = await load()
    const cover = `${CDN}/projects/404/0a1b2c${PROJECT_ID}.6a0404805ce06.jpg`
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Behance Featured",
      items: [
        {
          title: "Our very first painting exhibition",
          link: GALLERY,
          guid: GALLERY,
          content: `<img src='${cover}'/><br/>Selected to exhibit at a Starfield center in Korea, our first painting series.`,
          contentSnippet: "Selected to exhibit at a Starfield center in Korea, our first painting series.",
        },
      ],
    } as never)
    serve((u) => respond(interstitial(), 200, u))

    const items = await parseRSSFeed("https://feeds.feedburner.com/behance/vorr")

    expect(items).toHaveLength(1)
    expect(items[0].mediaUrls).toEqual([cover, ...EXPECTED_GALLERY])
    expect(items[0].thumbnailUrl).toBe(cover)
    expect(items[0].content).toContain("Selected to exhibit at a Starfield center in Korea")
    expect(items[0].content).not.toMatch(/couldn.t load/)
    expect(readerCalls().map(([u]) => u)).toEqual([`${READER}${GALLERY}`])
  })
})
