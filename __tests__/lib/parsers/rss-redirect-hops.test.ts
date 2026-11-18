/**
 * RAD-392 — the article-page fetch owns its redirects and validates every hop.
 *
 * `extractArticleContent` used to call plain `fetch`, which follows redirects
 * on its own; only the FINAL `response.url` was checked with `isAllowedUrl`.
 * A public article URL that 302s to `http://169.254.169.254/…` therefore made
 * the server request the internal address (blind SSRF). The fetch now goes
 * through `safeFetch` (`redirect: "manual"`, every hop validated), and a
 * learned challenge cookie never follows a redirect to another origin.
 *
 * Most mocks never follow redirects themselves — responses are sequenced by the URL
 * passed to fetch. Cookie memory in rss.ts is module-level, so every test uses
 * its own hosts (r1…r8.example.test).
 *
 * Coverage:
 *   1. every fetch passes `redirect: "manual"`
 *   2. an ordinary 301 is followed hop by hop, images come from the final page
 *   3. a relative Location is resolved against the current hop
 *   4. a redirect to a disallowed host is never requested; resolves empty
 *      (4 and 8 use an undici-like mock that follows redirects unless
 *      `redirect: "manual"` — the SSRF only exists because real fetch does)
 *   5. too many redirects → resolves empty after exactly 4 fetches (the request + 3 hops)
 *   6. a learned cookie is dropped on a cross-origin hop, UA kept
 *   7. a same-origin hop keeps the cookie
 *   8. parseRSSFeed end to end: an item redirecting to metadata keeps feed media only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("rss-parser", () => {
  const MockParser = vi.fn()
  MockParser.prototype.parseURL = vi.fn()
  return { default: MockParser }
})

import RSSParser from "rss-parser"
import { extractArticleContent, parseRSSFeed } from "@/lib/parsers/rss"

const mockFetch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const UA = "Mozilla/5.0 (compatible; RadaricBot/1.0)"
const COOKIE = "js_challenge_value=abc123"

function challengeBody(): string {
  return `<!doctype html><html><head><meta name="robots" content="noindex,nofollow"></head><body><script>
             document.cookie = "js_challenge_value=abc123; Path=/";
             window.location.reload();
           </script></body></html>`
}

const PROSE =
  "<p>" +
  "A curator reads more than a thousand items a day and most of them waste the minute they cost. ".repeat(12) +
  "</p>"

function projectImage(n: number, size = "1400"): string {
  return `https://mir-s3-cdn-cf.behance.net/project_modules/${size}/project-${n}.jpg`
}

function page(body: string, extraHead = ""): string {
  return `<!doctype html><html><head><title>Project</title>${extraHead}</head><body><article><h1>Project</h1>${body}</article></body></html>`
}

function projectPage(): string {
  return page(
    `${PROSE}<img src="${projectImage(1)}" width="1400" height="1050">${PROSE}<img src="${projectImage(2)}" width="1400" height="1050">${PROSE}`
  )
}

function htmlResponse(html: string, url: string): Response {
  return { ok: true, status: 200, url, headers: new Headers(), text: async () => html } as unknown as Response
}

function forbiddenResponse(html: string, url: string): Response {
  return { ok: false, status: 403, url, headers: new Headers(), text: async () => html } as unknown as Response
}

function redirectResponse(url: string, location: string, status = 302): Response {
  return {
    ok: false,
    status,
    url,
    headers: new Headers({ location }),
    text: async () => "",
  } as unknown as Response
}

type FetchInit = { headers?: HeadersInit; redirect?: RequestRedirect } | undefined

function cookieOf(init: FetchInit): string | null {
  return new Headers(init?.headers).get("cookie")
}

function userAgentOf(init: FetchInit): string | null {
  return new Headers(init?.headers).get("user-agent")
}

function calledUrls(): string[] {
  return mockFetch.mock.calls.map(([input]) => String(input))
}

/** A host that answers the challenge unless the request carries the cookie. */
function challengingHost() {
  return async (input: unknown, init?: FetchInit) => {
    const url = String(input)
    if (cookieOf(init) === COOKIE) return htmlResponse(projectPage(), url)
    return forbiddenResponse(challengeBody(), url)
  }
}

/**
 * A fetch that behaves like undici: with any `redirect` other than "manual" it
 * follows a 3xx + Location itself (up to 20 hops), requesting each target and
 * returning the final response with its `url`. With `redirect: "manual"` it
 * returns the 3xx as-is. Every URL it actually requests lands in `requested`.
 */
function realisticFetch(
  table: Record<string, (url: string, init?: FetchInit) => Response>,
  requested: string[]
) {
  const route = routes(table)
  return async (input: unknown, init?: FetchInit) => {
    let url = String(input)
    requested.push(url)
    let res = await route(url, init)
    if (init?.redirect === "manual") return res
    for (let hop = 0; hop < 20; hop++) {
      const location = res.headers.get("location")
      if (res.status < 300 || res.status >= 400 || !location) break
      url = new URL(location, url).href
      requested.push(url)
      res = await route(url, init)
    }
    return res
  }
}

/** Route responses by requested URL; unknown URLs 404. */
function routes(table: Record<string, (url: string, init?: FetchInit) => Response>) {
  return async (input: unknown, init?: FetchInit) => {
    const url = String(input)
    const handler = table[url]
    if (handler) return handler(url, init)
    return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" } as unknown as Response
  }
}

describe("extractArticleContent — owns redirects (RAD-392)", () => {
  it("AC-1: every fetch it makes passes redirect: \"manual\"", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://r1.example.test/a": (u) => redirectResponse(u, "https://r1.example.test/b"),
        "https://r1.example.test/b": (u) => htmlResponse(projectPage(), u),
      })
    )

    await extractArticleContent("https://r1.example.test/a").catch(() => undefined)

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1)
    for (const [, init] of mockFetch.mock.calls) {
      expect((init as FetchInit)?.redirect).toBe("manual")
    }
  })

  it("AC-2: follows an ordinary 301 hop by hop and returns the final page's images", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://r2.example.test/a": (u) => redirectResponse(u, "https://r2-cdn.example.test/final", 301),
        "https://r2-cdn.example.test/final": (u) => htmlResponse(projectPage(), u),
      })
    )

    const result = await extractArticleContent("https://r2.example.test/a")

    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
    expect(calledUrls()).toEqual(["https://r2.example.test/a", "https://r2-cdn.example.test/final"])
  })

  it("AC-3: resolves a relative Location against the current hop", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://r3.example.test/a": (u) => redirectResponse(u, "/moved"),
        "https://r3.example.test/moved": (u) => htmlResponse(projectPage(), u),
      })
    )

    const result = await extractArticleContent("https://r3.example.test/a")

    expect(calledUrls()).toEqual(["https://r3.example.test/a", "https://r3.example.test/moved"])
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
  })

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://metadata.google.internal/computeMetadata/v1/",
  ])("AC-4: never requests a redirect target on a disallowed host (%s) and resolves empty", async (target) => {
    const start = `https://r4-${Math.abs(hash(target))}.example.test/a`
    const requested: string[] = []
    mockFetch.mockImplementation(
      realisticFetch(
        {
          [start]: (u) => redirectResponse(u, target),
          // The internal target answers, so a follow-through is observable.
          [target]: (u) => htmlResponse(page(`${PROSE}<img src="${projectImage(9)}" width="1400" height="1050">`), u),
        },
        requested
      )
    )

    const result = await extractArticleContent(start)

    expect(requested).not.toContain(target)
    expect(requested).toEqual([start])
    expect(result.mediaUrls).toEqual([])
    expect(result.content).toBe("")
  })

  it("AC-5: stops after too many redirects — resolves empty after exactly 4 fetches", async () => {
    let n = 0
    mockFetch.mockImplementation(async (input: unknown) =>
      redirectResponse(String(input), `https://r5-hop${++n}.example.test/next`)
    )

    const result = await extractArticleContent("https://r5.example.test/start")

    expect(result.mediaUrls).toEqual([])
    expect(result.content).toBe("")
    expect(mockFetch).toHaveBeenCalledTimes(4) // the request + safeFetch's 3 hops
  })

  it("AC-6: a learned cookie is not sent to another origin after a redirect; the User-Agent still is", async () => {
    // Teach r6 its challenge cookie.
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://r6.example.test/learn")
    expect(cookieOf(mockFetch.mock.calls.at(-1)?.[1])).toBe(COOKIE) // positive control

    mockFetch.mockReset()
    mockFetch.mockImplementation(
      routes({
        "https://r6.example.test/next": (u) => redirectResponse(u, "https://elsewhere-r6.example.test/page"),
        "https://elsewhere-r6.example.test/page": (u) => htmlResponse(projectPage(), u),
      })
    )

    const result = await extractArticleContent("https://r6.example.test/next")

    expect(calledUrls()).toEqual(["https://r6.example.test/next", "https://elsewhere-r6.example.test/page"])
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBe(COOKIE)
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBeNull()
    expect(userAgentOf(mockFetch.mock.calls[1][1])).toBe(UA)
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
  })

  it("AC-7: a same-origin redirect keeps the cookie on both hops", async () => {
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://r7.example.test/learn")
    expect(cookieOf(mockFetch.mock.calls.at(-1)?.[1])).toBe(COOKIE) // positive control

    mockFetch.mockReset()
    mockFetch.mockImplementation(
      routes({
        "https://r7.example.test/a": (u) => redirectResponse(u, "https://r7.example.test/b"),
        "https://r7.example.test/b": (u, init) =>
          cookieOf(init) === COOKIE ? htmlResponse(projectPage(), u) : forbiddenResponse(challengeBody(), u),
      })
    )

    const result = await extractArticleContent("https://r7.example.test/a")

    expect(calledUrls()).toEqual(["https://r7.example.test/a", "https://r7.example.test/b"])
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBe(COOKIE)
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBe(COOKIE)
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
  })
})

describe("parseRSSFeed — an item whose link redirects to an internal host (RAD-392)", () => {
  it("AC-8: the item keeps only its feed-level media and the metadata URL is never requested", async () => {
    const link = "https://r8.example.test/article/1"
    const metadata = "http://169.254.169.254/latest/meta-data/"
    const feedImage = "https://feed.r8.example.test/assets/crop-404.jpg"
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Feed",
      items: [{ title: "Item", link, guid: "g1", content: `<p>Body</p><img src="${feedImage}">` }],
    } as never)
    const requested: string[] = []
    mockFetch.mockImplementation(
      realisticFetch(
        {
          [link]: (u) => redirectResponse(u, metadata),
          [metadata]: (u) => htmlResponse(page(`${PROSE}<img src="${projectImage(9)}" width="1400" height="1050">`), u),
        },
        requested
      )
    )

    const items = await parseRSSFeed("https://feeds.example.com/r8.xml")

    expect(requested).not.toContain(metadata)
    expect(items).toHaveLength(1)
    expect(items[0].url).toBe(link)
    expect(items[0].mediaUrls).toEqual([feedImage])
  })
})

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
