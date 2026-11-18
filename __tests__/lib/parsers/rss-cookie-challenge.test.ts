/**
 * RAD-391 — Behance's CDN answers the article-page fetch with a 403 cookie
 * challenge; the parser answers it once and gets the full project page.
 *
 * The challenge body sets `js_challenge_value=<hex>` via `document.cookie` and
 * reloads. Re-requesting the same URL with `Cookie: js_challenge_value=<hex>`
 * returns 200 with the page (verified live). Before the fix
 * `extractArticleContent` threw `HTTP error! status: 403`, `parseRSSFeed`
 * swallowed it and the post kept the feed's single image.
 *
 * Cookie memory is module-level and persists across tests in this file, so
 * EVERY test uses its own host (h1…h9.behance.test) to stay order-independent.
 *
 * Coverage:
 *   1. 403 challenge → one retry on the same URL with the cookie + UA; images returned
 *   2. cookie remembered per host → next page on that host sends it on the first fetch
 *   3. a remembered cookie never goes to a different host
 *   4. at most one retry: a second 403 rejects with `status: 403`, fetch called twice
 *   5. a 403 without a challenge rejects as today, fetch called once
 *   6. a malformed challenge value is not answered, fetch called once
 *   7. parseRSSFeed end to end: the challenged item gets the article images
 *   review follow-ups:
 *   8. a 403 that arrived from another origin (redirect) is not answered and teaches no host
 *   9. a rotated value replaces a stale remembered cookie, still one retry
 *  10. a value longer than 512 chars is not answered
 *  11. a 403 declaring a body over the read cap is not read or answered
 *  12. the per-host memory is bounded — the oldest host is forgotten first
 *  13. a cookie learned over https is not sent to http on the same host (RAD-392)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("rss-parser", () => {
  const MockParser = vi.fn()
  MockParser.prototype.parseURL = vi.fn()
  return { default: MockParser }
})

import RSSParser from "rss-parser"
import { CHALLENGE_COOKIE_HOSTS_MAX, extractArticleContent, parseRSSFeed } from "@/lib/parsers/rss"

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
const CHALLENGE_VALUE =
  "539c48f56299bf3095f90c149d9312b3ceaec5a2575654a88457e8f95af40e1b162046226d5adc9fb33e895a4df92fafb2de5668524ee1b52342ca8f057ada90"
const COOKIE = `js_challenge_value=${CHALLENGE_VALUE}`

/** The real Behance challenge body, verbatim shape. */
function challengeBody(value = CHALLENGE_VALUE): string {
  return `       <!doctype html>
       <html>
         <head>
           <meta name="robots" content="noindex,nofollow">
         </head>
         <body>
           <script>
             document.cookie = "js_challenge_value=${value}; Path=/";
             window.location.reload();
           </script>
         </body>
       </html>`
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
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers(),
    text: async () => html,
  } as unknown as Response
}

function forbiddenResponse(html: string, url: string): Response {
  return {
    ok: false,
    status: 403,
    url,
    headers: new Headers(),
    text: async () => html,
  } as unknown as Response
}

type FetchInit = { headers?: HeadersInit } | undefined

function cookieOf(init: FetchInit): string | null {
  return new Headers(init?.headers).get("cookie")
}

function userAgentOf(init: FetchInit): string | null {
  return new Headers(init?.headers).get("user-agent")
}

/**
 * A Behance-like host: answers the challenge unless the request carries the
 * right cookie, in which case it serves the project page.
 */
function challengingHost() {
  return async (input: unknown, init?: FetchInit) => {
    const url = String(input)
    if (cookieOf(init) === COOKIE) return htmlResponse(projectPage(), url)
    return forbiddenResponse(challengeBody(), url)
  }
}

describe("extractArticleContent — answers Behance's 403 cookie challenge", () => {
  it("AC-1: re-fetches the same URL once with the challenge cookie and returns the page images", async () => {
    const url = "https://h1.behance.test/gallery/1/slug"
    mockFetch.mockImplementation(challengingHost())

    const result = await extractArticleContent(url)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [retryUrl, retryInit] = mockFetch.mock.calls[1]
    expect(String(retryUrl)).toBe(url)
    expect(cookieOf(retryInit)).toBe(COOKIE)
    expect(userAgentOf(retryInit)).toBe(UA)
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
  })

  it("AC-2: remembers the cookie per host — the next page on that host sends it on its first fetch", async () => {
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://h2.behance.test/gallery/1/first")

    mockFetch.mockClear()
    const result = await extractArticleContent("https://h2.behance.test/gallery/2/second")

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [firstUrl, firstInit] = mockFetch.mock.calls[0]
    expect(String(firstUrl)).toBe("https://h2.behance.test/gallery/2/second")
    expect(cookieOf(firstInit)).toBe(COOKIE)
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])
  })

  it("AC-3: never sends a remembered cookie to a different host", async () => {
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://h3.behance.test/gallery/1/slug")
    // Positive control: the cookie was actually learned for h3.
    expect(cookieOf(mockFetch.mock.calls[1]?.[1])).toBe(COOKIE)

    mockFetch.mockReset()
    mockFetch.mockImplementation(async (input: unknown) => htmlResponse(projectPage(), String(input)))
    await extractArticleContent("https://other-h3.example.test/article/1")

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBeNull()
  })

  it("AC-4: retries at most once — a second 403 challenge rejects with status 403 after exactly two fetches", async () => {
    const url = "https://h4.behance.test/gallery/1/slug"
    mockFetch.mockImplementation(async (input: unknown) => forbiddenResponse(challengeBody(), String(input)))

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBe(COOKIE)
  })

  it("EC-5: a 403 with no challenge in the body rejects as today, after exactly one fetch", async () => {
    const url = "https://h5.behance.test/gallery/1/slug"
    mockFetch.mockImplementation(async (input: unknown) =>
      forbiddenResponse("<html><body><h1>Forbidden</h1></body></html>", String(input))
    )

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("EC-6: a malformed challenge value is not answered — no retry, rejects with status 403", async () => {
    const url = "https://h6.behance.test/gallery/1/slug"
    mockFetch.mockImplementation(async (input: unknown) =>
      forbiddenResponse(
        `<html><body><script>document.cookie = "js_challenge_value=ab<c; Path=/"; window.location.reload();</script></body></html>`,
        String(input)
      )
    )

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe("extractArticleContent — challenge edge cases (review follow-ups)", () => {
  it("EC-8: a 403 challenge that arrived from another origin is not answered and teaches neither host", async () => {
    const url = "https://h8.behance.test/gallery/1/slug"
    const landing = "https://other-h8.example.test/landing"
    // The request redirected: the challenge came from `landing`, not from `url`.
    mockFetch.mockImplementation(async () => forbiddenResponse(challengeBody(), landing))

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockReset()
    mockFetch.mockImplementation(async (input: unknown) => htmlResponse(projectPage(), String(input)))
    await extractArticleContent("https://h8.behance.test/gallery/2/slug")
    await extractArticleContent("https://other-h8.example.test/article/2")

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBeNull()
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBeNull()
  })

  it("EC-9: a rotated challenge value replaces the stale cookie — one retry, then the new value is remembered", async () => {
    const newValue = "f00dfeed"
    const newCookie = `js_challenge_value=${newValue}`
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://h9.behance.test/gallery/1/slug")

    // The host now wants a different value.
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (input: unknown, init?: FetchInit) => {
      const url = String(input)
      if (cookieOf(init) === newCookie) return htmlResponse(projectPage(), url)
      return forbiddenResponse(challengeBody(newValue), url)
    })
    const result = await extractArticleContent("https://h9.behance.test/gallery/2/slug")

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBe(COOKIE)
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBe(newCookie)
    expect(result.mediaUrls).toEqual([projectImage(1), projectImage(2)])

    mockFetch.mockClear()
    await extractArticleContent("https://h9.behance.test/gallery/3/slug")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBe(newCookie)
  })

  it("EC-10: a value longer than 512 characters is not answered", async () => {
    const url = "https://h10.behance.test/gallery/1/slug"
    mockFetch.mockImplementation(async (input: unknown) =>
      forbiddenResponse(challengeBody("a".repeat(513)), String(input))
    )

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("EC-11: a 403 that declares a body over the read cap is neither read nor answered", async () => {
    const url = "https://h11.behance.test/gallery/1/slug"
    const text = vi.fn(async () => challengeBody())
    mockFetch.mockImplementation(async (input: unknown) => ({
      ok: false,
      status: 403,
      url: String(input),
      headers: new Headers({ "content-length": "5000000" }),
      text,
    }))

    await expect(extractArticleContent(url)).rejects.toThrow(/status: 403/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(text).not.toHaveBeenCalled()
  })

  it("EC-12: remembers at most CHALLENGE_COOKIE_HOSTS_MAX hosts, forgetting the oldest first", async () => {
    mockFetch.mockImplementation(challengingHost())
    const hosts = Array.from({ length: CHALLENGE_COOKIE_HOSTS_MAX + 1 }, (_, i) => `cap-${i}.behance.test`)
    for (const host of hosts) await extractArticleContent(`https://${host}/gallery/1/slug`)

    mockFetch.mockReset()
    mockFetch.mockImplementation(async (input: unknown) => htmlResponse(projectPage(), String(input)))
    await extractArticleContent(`https://${hosts[0]}/gallery/2/slug`)
    await extractArticleContent(`https://${hosts[hosts.length - 1]}/gallery/2/slug`)

    expect(cookieOf(mockFetch.mock.calls[0][1])).toBeNull()
    expect(cookieOf(mockFetch.mock.calls[1][1])).toBe(COOKIE)
  })

  it("EC-13: a cookie learned over https is not sent in the clear to http on the same host", async () => {
    mockFetch.mockImplementation(challengingHost())
    await extractArticleContent("https://h13.behance.test/gallery/1/slug")
    // Positive control: the cookie was actually learned for https://h13.
    expect(cookieOf(mockFetch.mock.calls[1]?.[1])).toBe(COOKIE)

    mockFetch.mockReset()
    mockFetch.mockImplementation(async (input: unknown) => htmlResponse(projectPage(), String(input)))
    await extractArticleContent("http://h13.behance.test/gallery/2/slug")

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(cookieOf(mockFetch.mock.calls[0][1])).toBeNull()
  })
})

describe("parseRSSFeed — a challenged Behance item keeps its project gallery", () => {
  it("AC-7: the item whose page first answers the 403 challenge gets the article images", async () => {
    const link = "https://h7.behance.test/gallery/255684893/slug"
    const feedImage = "https://feed.h7.example.test/assets/crop-404.jpg"
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Behance Featured",
      items: [{ title: "Project", link, guid: "g1", content: `<p>Body</p><img src="${feedImage}">` }],
    } as never)
    mockFetch.mockImplementation(challengingHost())

    const items = await parseRSSFeed("https://feeds.example.com/behance.xml")

    expect(items).toHaveLength(1)
    expect(items[0].mediaUrls).toEqual([feedImage, projectImage(1), projectImage(2)])
  })
})
