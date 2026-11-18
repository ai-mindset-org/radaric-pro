/**
 * Source validation mechanics — lib/feed-validation, lib/parsers/rss
 * (fetchFeedSummary), lib/parsers/telegram (probeTelegramEntity) and the pure
 * classifier.
 *
 * The governing rule under test: only a DEFINITIVE answer may reject a source.
 * Anything that's our own infrastructure failing has to fail open, or a user
 * gets blocked from adding a perfectly good feed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { classifyEntity, isUnreadableKind, isUsernameNotFoundError } from "@/lib/telegram-kind"
import { normalizeTelegramInput } from "@/lib/validations/feed"
// The real GramJS username parser — the thing that actually decides whether a
// resolve ever leaves the process.
import { parseUsername } from "telegram/Utils"
// The real conversion GramJS runs on every RPC failure. Hand-shaping
// {errorMessage: "FLOOD_WAIT_42"} invents a shape the library cannot produce —
// it buckets classed errors, so the real FloodWaitError says only "FLOOD".
// Building errors through this is what makes these tests about GramJS rather
// than about our assumptions.
import { RPCMessageToError } from "telegram/errors"

/** The error GramJS would raise for a given wire error string. */
function gramjsError(code: string): Error {
  return RPCMessageToError({ errorMessage: code, errorCode: 400 } as never, {
    className: "ResolveUsername",
  } as never)
}
import { fetchFeedSummary, FEED_HEADERS, productionFeedHeaders } from "@/lib/parsers/rss"
import { safeFetch } from "@/lib/url-validation"
import { probeTelegramEntity } from "@/lib/telegram-worker-client"
import { validateRssSource, validateTelegramSource } from "@/lib/feed-validation"

const ATOM_WITH_ENTRIES = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from thing</title>
  <entry><title>v1.0</title><id>1</id></entry>
  <entry><title>v1.1</title><id>2</id></entry>
</feed>`

// The shape github.com/<repo>/releases.atom actually returns for a repo that
// has never cut a release: valid Atom, zero entries.
const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from dit-2026</title>
</feed>`

const fetchMock = vi.fn()

/** A Response whose body is read via getReader(), the way fetchFeedSummary caps it. */
function ok(body: string, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    body: streamOf(body),
  }
}

/**
 * Route responses by URL instead of by call order.
 *
 * Call-order mocking is what let an earlier version of this file claim the
 * error-page probe worked: it made ONE url answer 404 on the first fetch and
 * 200 on the second, which no real server does. Keying on the URL means a page
 * answers the same way however many times it's asked — so a test can't encode
 * an assumption the code doesn't honour.
 */
function serve(routes: Record<string, () => unknown>) {
  return (input: string) => {
    const url = String(input)
    const route = routes[url] ?? routes[url.replace(/\/$/, "")]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return Promise.resolve(route())
  }
}

/** A non-2xx response that still carries a body, the way a real WAF/404 page does. */
function status(code: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status: code,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    body: streamOf(body),
  }
}

function streamOf(body: string | Uint8Array) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  let sent = false
  return {
    // ReadableStream#cancel — fetchFeedSummary calls this to release the socket
    // on the paths where it returns without reading.
    cancel: async () => {},
    getReader: () => ({
      read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
      cancel: async () => {},
    }),
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("classifyEntity", () => {
  it("distinguishes a bot from a human user", () => {
    expect(classifyEntity({ className: "User", bot: true })).toBe("bot")
    expect(classifyEntity({ className: "User" })).toBe("user")
  })

  it("distinguishes a broadcast channel from a supergroup", () => {
    expect(classifyEntity({ className: "Channel" })).toBe("channel")
    expect(classifyEntity({ className: "Channel", megagroup: true })).toBe("megagroup")
  })

  it("falls back to unknown for entities it doesn't model", () => {
    // A real-but-unclassifiable entity must never be mistaken for a user and
    // rejected — ChannelForbidden, gigagroups, future classNames.
    expect(classifyEntity({ className: "ChannelForbidden" })).toBe("unknown")
    expect(classifyEntity({})).toBe("unknown")
  })

  it("treats only bots and users as unreadable", () => {
    expect(isUnreadableKind("bot")).toBe(true)
    expect(isUnreadableKind("user")).toBe(true)
    expect(isUnreadableKind("channel")).toBe(false)
    expect(isUnreadableKind("megagroup")).toBe(false)
    expect(isUnreadableKind("unknown")).toBe(false)
  })
})

describe("isUsernameNotFoundError", () => {
  // These strings are copied from the INSTALLED GramJS, not imagined. The
  // common dead-handle case never reaches the caller as an RPCError at all:
  // GramJS catches USERNAME_NOT_OCCUPIED and rethrows a bare Error.

  it("recognizes the plain Error GramJS rethrows for a dead handle", () => {
    // node_modules/telegram/client/users.js:407
    expect(isUsernameNotFoundError(new Error(`No user has "nosuchchannel" as username`))).toBe(true)
  })

  it("does NOT treat 'cannot find any entity' as Telegram's answer", () => {
    // client/users.js:414. GramJS throws this LOCALLY — no network call — for
    // every username its own VALID_USERNAME_RE rejects, and that regex is
    // stricter than ours (see the parity test below). Treating it as definitive
    // rejects real channels on the strength of our own parsing gap.
    expect(isUsernameNotFoundError(new Error(`Cannot find any entity corresponding to "my__channel"`))).toBe(false)
  })

  it("real channel handles our normalizer accepts must never reach a definitive reject", () => {
    // Drives the INSTALLED GramJS parser rather than a belief about it: a
    // 4-char collectible handle is valid Telegram and accepted by
    // normalizeTelegramInput, yet GramJS declines to resolve it without asking
    // Telegram. It must fail open, or the channel is unaddable via POST and PATCH.
    // (Leading digits, "__" and a trailing "_" are no longer accepted at all —
    // RAD-364 aligned the normalizer with Telegram's grammar.)
    for (const username of ["ab12"]) {
      expect(normalizeTelegramInput(`https://t.me/${username}`)).toBe(`https://t.me/${username}`)
      expect(parseUsername(username).username, `${username}: GramJS would resolve this`).toBeUndefined()
      // …so the only error it can produce is the local throw, which must not reject.
      expect(
        isUsernameNotFoundError(new Error(`Cannot find any entity corresponding to "${username}"`)),
        `${username}: our regex gap became a confident "no such channel"`
      ).toBe(false)
    }
  })

  it("recognizes the real RPCErrors Telegram raises for a dead handle", () => {
    // Both stay unclassed, so GramJS preserves the code on .errorMessage.
    expect(isUsernameNotFoundError(gramjsError("USERNAME_INVALID"))).toBe(true)
    expect(isUsernameNotFoundError(gramjsError("USERNAME_NOT_OCCUPIED"))).toBe(true)
  })

  it("does NOT treat our own failures as a verdict on the input", () => {
    // Built through GramJS's real conversion. A fabricated
    // {errorMessage: "FLOOD_WAIT_42"} would test a shape that cannot occur:
    // GramJS classes this one into FloodWaitError, whose errorMessage is the
    // coarse bucket "FLOOD" — so the flood-wait fail-open would go unexercised.
    const flood = gramjsError("FLOOD_WAIT_42")
    expect((flood as unknown as { errorMessage: string }).errorMessage).toBe("FLOOD") // pins the premise
    expect(flood.message).toContain("42 seconds") // the detail lives only here
    expect(isUsernameNotFoundError(flood)).toBe(false)

    expect(isUsernameNotFoundError(gramjsError("CHANNEL_PRIVATE"))).toBe(false)
    expect(isUsernameNotFoundError(gramjsError("AUTH_KEY_DUPLICATED"))).toBe(false)
    expect(isUsernameNotFoundError(new Error("ECONNREFUSED"))).toBe(false)
    expect(isUsernameNotFoundError("not an error at all")).toBe(false)
    expect(isUsernameNotFoundError(undefined)).toBe(false)
  })
})

describe("fetchFeedSummary", () => {
  it("sends exactly the headers the production parser is configured with", async () => {
    // rss-parser only applies constructor headers inside parseURL, so probing
    // without them means validation sees a different server response than
    // parseRSSFeed does, and UA-gated feeds get rejected at the door while
    // working fine once added.
    //
    // Asserted against productionFeedHeaders(), which reads back off the parser
    // INSTANCE — comparing to the FEED_HEADERS literal would compare the
    // constant to itself and pass even if the parser were reconfigured away
    // from it, which is the divergence this exists to prevent.
    fetchMock.mockResolvedValueOnce(ok(ATOM_WITH_ENTRIES))
    await fetchFeedSummary("https://example.com/feed.xml")

    expect(fetchMock.mock.calls[0][1].headers).toEqual(productionFeedHeaders())
  })

  it("configures the production parser with a browser User-Agent, not rss-parser's default", () => {
    // The tripwire: rss-parser defaults to UA "rss-parser"/Accept
    // "application/rss+xml", which Cloudflare-fronted feeds 403. Read through
    // the parser, so reconfiguring it fails here.
    const sent = productionFeedHeaders()
    expect(sent["User-Agent"]).toContain("Mozilla/5.0")
    expect(sent["Accept"]).toBe(FEED_HEADERS["Accept"])
    expect(sent["Accept"]).toContain("application/rss+xml")
  })

  it("counts entries in a populated feed", async () => {
    fetchMock.mockResolvedValueOnce(ok(ATOM_WITH_ENTRIES))
    const r = await fetchFeedSummary("https://example.com/feed.xml")
    expect(r).toEqual({ ok: true, itemCount: 2 })
  })

  it("reports a valid but entry-less feed as ok with 0 items", async () => {
    fetchMock.mockResolvedValueOnce(ok(ATOM_EMPTY))
    const r = await fetchFeedSummary("https://github.com/aji-ai/dit-2026/releases.atom")
    expect(r).toEqual({ ok: true, itemCount: 0 })
  })

  it("reports a fetched non-feed as not_a_feed", async () => {
    fetchMock.mockResolvedValueOnce(ok("<!doctype html><html><body>hi</body></html>"))
    const r = await fetchFeedSummary("https://example.com/page")
    expect(r).toEqual({ ok: false, reason: "not_a_feed" })
  })

  it("reports a 403 as http_error, NOT as not-a-feed", async () => {
    // A WAF/Cloudflare 403 body would parse as "not a feed" and hard-reject a
    // live feed. The status decides the reason, never the body.
    fetchMock.mockResolvedValueOnce(status(403, "<html>Access denied</html>"))
    const r = await fetchFeedSummary("https://example.com/feed.xml")
    expect(r).toEqual({ ok: false, reason: "http_error" })
  })

  it("forwards the caller's signal, so an outer deadline reaches the socket", async () => {
    // The seam that makes validateRssSource's total bound real rather than
    // decorative — asserting the signal is merely *present* proves nothing,
    // since safeFetch sets one either way.
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    fetchMock.mockImplementation((_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return new Promise(() => {})
    })
    void fetchFeedSummary("https://example.com/feed.xml", { signal: controller.signal })
    await vi.waitUntil(() => seen !== undefined)
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })

  it("reports a nonexistent INPUT hostname as dns_not_found, not unreachable", async () => {
    // Shape verified against real undici: `TypeError: fetch failed` wrapping
    // `.cause.code = "ENOTFOUND"`. This is a fact about THEIR domain, so it may
    // reject — collapsing it into "unreachable" is how a typo'd hostname gets
    // saved as a source that can never produce a post.
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND exmaple.com"), {
        code: "ENOTFOUND",
        hostname: "exmaple.com",
      }),
    })
    fetchMock.mockRejectedValueOnce(err)
    expect(await fetchFeedSummary("https://exmaple.com/feed.xml")).toEqual({ ok: false, reason: "dns_not_found" })
  })

  it("does NOT blame the input when a REDIRECT TARGET's hostname is the dead one", async () => {
    // The user's host resolves and 301s to a CDN whose DNS record lapsed.
    // safeFetch throws from anywhere in its redirect loop, so attributing the
    // ENOTFOUND to the input would hard-reject a live feed with "feeds.example.com
    // doesn't exist — check for a typo": false, and not a typo the user can fix.
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND cdn.dead.net"), {
        code: "ENOTFOUND",
        hostname: "cdn.dead.net",
      }),
    })
    fetchMock.mockRejectedValueOnce(err)
    expect(await fetchFeedSummary("https://feeds.example.com/rss")).toEqual({ ok: false, reason: "unreachable" })
  })

  it("fails open on an ENOTFOUND it cannot attribute to any host", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })
    fetchMock.mockRejectedValueOnce(err)
    expect(await fetchFeedSummary("https://example.com/feed.xml")).toEqual({ ok: false, reason: "unreachable" })
  })

  it("treats a TEMPORARY dns failure as unreachable, not as a verdict", async () => {
    // EAI_AGAIN is the resolver having a bad moment — our problem, fails open.
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo EAI_AGAIN example.com"), { code: "EAI_AGAIN" }),
    })
    fetchMock.mockRejectedValueOnce(err)
    expect(await fetchFeedSummary("https://example.com/feed.xml")).toEqual({ ok: false, reason: "unreachable" })
  })

  it("reports a network throw as unreachable rather than propagating", async () => {
    // safeFetch's inner fetch is unguarded, so a DNS blip would otherwise
    // escape as a 500 out of the create route.
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const r = await fetchFeedSummary("https://gone.example.com/feed.xml")
    expect(r).toEqual({ ok: false, reason: "unreachable" })
  })

  it("refuses a response that declares an oversized content-length", async () => {
    fetchMock.mockResolvedValueOnce(ok(ATOM_WITH_ENTRIES, { "content-length": "9000000" }))
    const r = await fetchFeedSummary("https://example.com/huge.xml")
    expect(r).toEqual({ ok: false, reason: "unreachable" })
  })

  it("stops reading an oversized body that declares no length", async () => {
    // Chunked responses (what most feed CDNs send) carry no content-length, so
    // the header check alone would let an unbounded body into memory.
    const chunk = new Uint8Array(1_000_000)
    let served = 0
    const cancel = vi.fn(async () => {})
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (served++ < 10 ? { done: false, value: chunk } : { done: true, value: undefined }),
          cancel,
        }),
      },
    })
    const r = await fetchFeedSummary("https://example.com/chunked.xml")
    expect(r).toEqual({ ok: false, reason: "unreachable" })
    expect(cancel).toHaveBeenCalled() // stopped early, didn't drain it
    expect(served).toBeLessThan(10)
  })

  it("reports an empty body as unreachable, not as a non-feed", async () => {
    // A truncated/204-shaped response is our side failing to get the bytes.
    // Handing "" to the parser would throw and brand a live feed dead.
    fetchMock.mockResolvedValueOnce(ok(""))
    const r = await fetchFeedSummary("https://example.com/feed.xml")
    expect(r).toEqual({ ok: false, reason: "unreachable" })
  })

  it("decodes by the declared charset — a UTF-16 feed must not be branded 'not a feed'", async () => {
    // This guards a REJECTION, not cosmetics. UTF-16 bytes forced through a
    // UTF-8 decoder come out as garbage, parseString throws, and a live feed is
    // refused at the door with "that isn't an RSS or Atom feed".
    const xml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-16"?><rss version="2.0"><channel><title>Новости</title><item><title>a</title></item><item><title>b</title></item></channel></rss>`,
      "utf16le"
    )
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/xml; charset=utf-16le" : null) },
      body: streamOf(new Uint8Array(xml)),
    })

    expect(await fetchFeedSummary("https://example.ru/rss")).toEqual({ ok: true, itemCount: 2 })
  })

  it("survives a single-byte charset it decodes wrong rather than rejecting", async () => {
    // windows-1251 mojibake only garbles text nodes; the structure is ASCII, so
    // the parse still succeeds and the count is still right. Documents the
    // boundary: decodeBody's job is preventing a false NOT_A_FEED, not prettiness.
    const xml = Buffer.concat([
      Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>`, "latin1"),
      Buffer.from([0xcd, 0xee, 0xe2, 0xee, 0xf1, 0xf2, 0xe8]), // "Новости" in cp1251
      Buffer.from(`</title><item><title>a</title></item></channel></rss>`, "latin1"),
    ])
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/xml; charset=windows-1251" : null) },
      body: streamOf(new Uint8Array(xml)),
    })

    expect(await fetchFeedSummary("https://example.ru/rss")).toEqual({ ok: true, itemCount: 1 })
  })

  it("falls back to UTF-8 when the declared charset is unknown", async () => {
    fetchMock.mockResolvedValueOnce(ok(ATOM_WITH_ENTRIES, { "content-type": "text/xml; charset=bogus-9000" }))
    const r = await fetchFeedSummary("https://example.com/feed.xml")
    expect(r).toMatchObject({ ok: true, itemCount: 2 })
  })

  it("refuses to fetch an internal address (SSRF guard)", async () => {
    const r = await fetchFeedSummary("http://localhost:3001/feed")
    expect(r).toEqual({ ok: false, reason: "blocked" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("safeFetch signal composition", () => {
  it("aborts the in-flight hop when the caller's signal fires", async () => {
    // safeFetch composes its per-hop timeout with the caller's signal. Asserting
    // `signal` is defined would pass even if the caller's were dropped on the
    // floor — the abort has to actually propagate.
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    fetchMock.mockImplementation((_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return new Promise(() => {})
    })
    void safeFetch("https://example.com/feed.xml", { signal: controller.signal })
    await vi.waitUntil(() => seen !== undefined)
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })
})

describe("validateRssSource", () => {
  it("accepts a feed and reports how much is in it", async () => {
    fetchMock.mockResolvedValueOnce(ok(ATOM_WITH_ENTRIES))
    const r = await validateRssSource("https://example.com/feed.xml")
    expect(r).toEqual({ ok: true, itemCount: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("accepts a valid but entry-less feed — the reported releases.atom case", async () => {
    // The whole point of the caveat: this is a real feed, so it must be
    // creatable. It just can't produce anything yet, and the user has to know.
    fetchMock.mockResolvedValueOnce(ok(ATOM_EMPTY))
    expect(await validateRssSource("https://example.com/releases.atom")).toEqual({ ok: true, itemCount: 0 })
  })

  it("rejects a page that fetched cleanly and isn't a feed", async () => {
    fetchMock.mockImplementation(
      serve({ "https://example.com/page": () => ok("<!doctype html><html><body>nothing</body></html>") })
    )
    expect(await validateRssSource("https://example.com/page")).toEqual({ ok: false, code: "NOT_A_FEED" })
  })

  it("rejects a domain that doesn't exist", async () => {
    const err = new TypeError("fetch failed")
    Object.defineProperty(err, "cause", { value: { code: "ENOTFOUND", hostname: "nonexistent.example" } })
    fetchMock.mockRejectedValue(err)
    expect(await validateRssSource("https://nonexistent.example/feed")).toEqual({
      ok: false,
      code: "DNS_NOT_FOUND",
    })
  })

  it("rejects a blocked address with its own code, not as 'not a feed'", async () => {
    // Definitive (the parser could never fetch it either) but NOT evidence about
    // whether a feed lives there — a self-hosted FreshRSS on a private address
    // IS a feed. Telling that user "paste the direct feed URL, often
    // 192.168.1.10/feed" is false and loops them forever.
    expect(await validateRssSource("http://192.168.1.10:8080/rss")).toEqual({
      ok: false,
      code: "FEED_UNREACHABLE_BY_POLICY",
    })
    expect(await validateRssSource("http://169.254.169.254/latest/meta-data")).toEqual({
      ok: false,
      code: "FEED_UNREACHABLE_BY_POLICY",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails open when it can't reach the URL at all", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    expect(await validateRssSource("https://example.com/feed.xml")).toEqual({ ok: "unknown" })
  })

  it("fails open on a temporary DNS failure — that's a resolver blip, not a verdict", async () => {
    const err = new TypeError("fetch failed")
    Object.defineProperty(err, "cause", { value: { code: "EAI_AGAIN" } })
    fetchMock.mockRejectedValue(err)
    expect(await validateRssSource("https://example.com/feed.xml")).toEqual({ ok: "unknown" })
  })

  it("fails open on a 403 rather than rejecting a WAF'd feed", async () => {
    fetchMock.mockResolvedValue(status(403, "<html>Access denied</html>"))
    expect(await validateRssSource("https://example.com/feed.xml")).toEqual({ ok: "unknown" })
  })

  it("fails open when the fetch never returns at all", async () => {
    // The backstop for the case a signal can't cover. Fail-open by construction:
    // a slow-but-real feed must stay addable.
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(() => new Promise(() => {}))
      const pending = validateRssSource("https://slow.example/feed.xml")
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await pending).toEqual({ ok: "unknown" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("follows an ordinary redirect chain", async () => {
    fetchMock.mockImplementation(
      serve({
        "http://example.com/feed": () => ({
          ok: false,
          status: 301,
          headers: { get: (k: string) => (k.toLowerCase() === "location" ? "https://example.com/feed" : null) },
        }),
        "https://example.com/feed": () => ok(ATOM_WITH_ENTRIES),
      })
    )
    expect(await validateRssSource("http://example.com/feed")).toEqual({ ok: true, itemCount: 2 })
  })
})

describe("probeTelegramEntity", () => {
  it("makes exactly one request even when the worker is reconnecting", async () => {
    // Must not go through fetchWorkerWithRetry: 6 retries backing off to a 30s
    // cap is ~75s of sleeping, and it counts 503 — a reconnecting worker — as
    // transient. A user waiting on "Add feed" gets one short attempt.
    //
    // Mocked as 503, NOT 200: fetchWorkerWithRetry also fetches exactly once on
    // a success, so asserting one call against a 200 passes identically under
    // the implementation this forbids. The retry storm is only visible on the
    // failure path.
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "reconnecting" })
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A hard network failure is the other retry trigger.
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns the entity kind on success", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kind: "bot", name: "Нейро" }) })
    expect(await probeTelegramEntity("https://t.me/example_bot")).toEqual({
      status: "found",
      kind: "bot",
      name: "Нейро",
    })
  })

  it("treats a MARKED 404 as Telegram saying the username doesn't exist", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "USERNAME_NOT_FOUND" }),
    })
    expect(await probeTelegramEntity("nosuchchannel")).toEqual({ status: "not_found" })
  })

  it("treats a BARE 404 as unavailable — that's the worker's route fallthrough", async () => {
    // worker.ts ends its route chain with a plain writeHead(404). A stale
    // container still bound to 3001 mid-rolling-deploy, or one built before this
    // endpoint existed, answers that for /telegram/channel-info — and reading it
    // as "no such username" makes every real channel unaddable.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
  })

  it("treats a 404 whose body isn't JSON as unavailable", async () => {
    // The fallthrough sends the text "Not Found", not JSON.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError("Unexpected token N")
      },
    })
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
  })

  it("treats a reconnecting worker (503) as unavailable", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
  })

  it("treats FLOOD_WAIT and other 500s as unavailable, never as grounds to reject", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
  })

  it("treats a missing worker (ECONNREFUSED) as unavailable", async () => {
    // The everyday local case — `next dev` runs no worker.
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    expect(await probeTelegramEntity("durov")).toEqual({ status: "unavailable" })
  })

  it("defaults an unlabelled kind to unknown rather than guessing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: "Something" }) })
    expect(await probeTelegramEntity("x")).toMatchObject({ status: "found", kind: "unknown" })
  })
})

describe("validateTelegramSource", () => {
  function probeReturns(body: unknown, status = 200) {
    fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body })
  }

  it("rejects a bot — the reported bug", async () => {
    probeReturns({ kind: "bot", name: "Нейропросвещение" })
    expect(await validateTelegramSource("https://t.me/example_bot")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_IS_BOT",
    })
  })

  it("rejects a personal account with its own code", async () => {
    probeReturns({ kind: "user", name: "Some Person" })
    expect(await validateTelegramSource("https://t.me/someperson")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_IS_USER",
    })
  })

  it("rejects a username Telegram says doesn't exist", async () => {
    probeReturns({ error: "USERNAME_NOT_FOUND" }, 404)
    expect(await validateTelegramSource("https://t.me/nosuchchannel")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_NOT_FOUND",
    })
  })

  it("fails open on an unmarked 404 — the wrong worker is not a verdict", async () => {
    probeReturns({}, 404)
    expect(await validateTelegramSource("https://t.me/durov")).toEqual({ verdict: "unknown" })
  })

  it("accepts a broadcast channel", async () => {
    probeReturns({ kind: "channel", name: "Durov's Channel" })
    expect(await validateTelegramSource("https://t.me/durov")).toEqual({ verdict: "ok" })
  })

  it("accepts a public supergroup — it has readable history", async () => {
    probeReturns({ kind: "megagroup", name: "Some Group" })
    expect(await validateTelegramSource("https://t.me/somegroup")).toEqual({ verdict: "ok" })
  })

  it("accepts an entity it couldn't classify", async () => {
    probeReturns({ kind: "unknown", name: "?" })
    expect(await validateTelegramSource("https://t.me/mystery")).toEqual({ verdict: "ok" })
  })

  it("fails open when the worker is unavailable", async () => {
    // The regression that matters most: the worker reconnects periodically, and
    // failing closed would break Telegram feed creation for minutes at a time.
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    expect(await validateTelegramSource("https://t.me/durov")).toEqual({ verdict: "unknown" })
  })
})
