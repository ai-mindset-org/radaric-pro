/**
 * Telegram probe — end-to-end over a REAL HTTP wire, no GramJS session.
 *
 * The unit suites mock `fetch` (telegram-worker-client) or mock
 * `validateTelegramSource` (the route). Neither exercises the actual bytes
 * crossing between the Next process and the worker — which is exactly where the
 * reported bug lived (a bot resolving to a clean 200). This test stands up a
 * real http.Server shaped like the worker's `/telegram/channel-info` handler
 * and drives the REAL probeTelegramEntity + validateTelegramSource through it.
 *
 * The only thing NOT real here is the GramJS client — the session, and the one
 * thing we cannot exercise before deploy without booting a second client on
 * prod's session (AUTH_KEY_DUPLICATED). The server runs the worker's REAL
 * handlers (`channelInfo`, `parseChannelResponse` from telegram-proxy.ts) over a
 * stub client whose getEntity / getInputEntity answer with REAL Api entities and
 * a REAL RPC error. So everything the handler does after resolution — the
 * RAD-364 channel gate, classification, the marked 404 — is the real code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"

vi.mock("@/lib/db", () => ({ db: {} }))

import { channelInfo, parseChannelResponse } from "@/lib/story-aggregator/telegram-proxy"
import { makeClient } from "../story-aggregator/offline-gramjs"

// The client reads WORKER_HEALTH_PORT into a module-const at import, so the port
// must be set before it is imported. Each distinct port therefore needs a fresh
// module instance — vi.resetModules() + a dynamic import, not a cache-busting
// query suffix (which the @/ alias resolver doesn't honour).
let probeTelegramEntity: typeof import("@/lib/telegram-worker-client").probeTelegramEntity
let validateTelegramSource: typeof import("@/lib/feed-validation").validateTelegramSource

/** Freshly import the probe client bound to the given worker port. */
async function probeClientOn(port: number | string) {
  process.env.WORKER_HEALTH_PORT = String(port)
  vi.resetModules()
  return (await import("@/lib/telegram-worker-client")).probeTelegramEntity
}

/**
 * The live session, offline: a real StringSession cache inside a real
 * TelegramClient; only the network answers are stubbed (real Api objects).
 * See __tests__/story-aggregator/offline-gramjs.ts.
 */
const { client: offlineClient, getMessages } = makeClient()

function send(res: http.ServerResponse, answer: { status: number; body: unknown }) {
  if (typeof answer.body === "string") {
    res.writeHead(answer.status)
    res.end(answer.body)
  } else {
    res.writeHead(answer.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(answer.body))
  }
}

/**
 * A server wired like the worker: the route table, the 503 while reconnecting,
 * the bare-404 fallthrough — and behind them the REAL handlers.
 */
function makeWorker(opts: { down?: boolean; bare404?: boolean } = {}) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "", "http://localhost")
    if (u.pathname === "/telegram/parse-channel" && req.method === "POST") {
      let body = ""
      for await (const chunk of req) body += chunk
      send(res, await parseChannelResponse(offlineClient, JSON.parse(body)))
      return
    }
    if (u.pathname !== "/telegram/channel-info") {
      // The worker's own route-table fallthrough: a BARE 404, no marker.
      res.writeHead(404)
      res.end("Not found")
      return
    }
    if (opts.bare404) {
      res.writeHead(404)
      res.end("Not found")
      return
    }
    if (opts.down) {
      res.writeHead(503)
      res.end("GramJS client not available")
      return
    }
    send(res, await channelInfo(offlineClient, u.searchParams.get("username") ?? "", false))
  })
}

const servers: http.Server[] = []
function listen(server: http.Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)))
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("Telegram probe over a real HTTP wire", () => {
  beforeAll(async () => {
    // Pin the client's target port to a live stub BEFORE the module loads.
    const port = await listen(makeWorker())
    process.env.WORKER_HEALTH_PORT = String(port)
    ;({ probeTelegramEntity } = await import("@/lib/telegram-worker-client"))
    ;({ validateTelegramSource } = await import("@/lib/feed-validation"))
  })
  afterAll(async () => {
    await Promise.all(servers.map(close))
  })

  it("rejects the bot end-to-end — the reported example_bot case", async () => {
    // The whole point: a bot must NOT resolve to a clean success.
    expect(await validateTelegramSource("https://t.me/example_bot")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_IS_BOT",
    })
  })

  it("rejects a personal account with its own code", async () => {
    expect(await validateTelegramSource("https://t.me/pavel")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_IS_USER",
    })
  })

  it("accepts a broadcast channel", async () => {
    expect(await validateTelegramSource("https://t.me/durov")).toEqual({ verdict: "ok" })
  })

  it("accepts a public supergroup — it has readable history", async () => {
    expect(await validateTelegramSource("https://t.me/publicchat")).toEqual({ verdict: "ok" })
  })

  it("rejects a username Telegram states doesn't exist (marked 404)", async () => {
    expect(await validateTelegramSource("https://t.me/ghost_nosuch")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_NOT_FOUND",
    })
  })

  it("also exposes the raw probe kind for the bot", async () => {
    expect(await probeTelegramEntity("example_bot")).toEqual({ status: "refused", kind: "bot" })
  })

  it("FAILS OPEN when the worker is reconnecting (503) — never rejects a real channel", async () => {
    const port = await listen(makeWorker({ down: true }))
    const probe = await probeClientOn(port)
    expect(await probe("durov")).toEqual({ status: "unavailable" })
  })

  it("FAILS OPEN on a BARE 404 — a stale/old worker is not Telegram's verdict", async () => {
    // The exact regression the marker guards: a worker built before this
    // endpoint existed answers a bare 404 for EVERY username. Must not reject.
    const port = await listen(makeWorker({ bare404: true }))
    const probe = await probeClientOn(port)
    expect(await probe("durov")).toEqual({ status: "unavailable" })
  })

  it("the worker refuses the self alias before resolving anything (RAD-364)", async () => {
    // The API never probes this (it fails normalization), but the endpoint
    // must stand on its own: a 422 marked refusal, never a 200 about the
    // operator's own account — and the probe reads it as a refusal, not "found".
    const port = await listen(makeWorker())
    const probe = await probeClientOn(port)
    expect(await probe("self")).toEqual({ status: "refused", kind: "unknown" })
  })

  it("a basic group or a private group is refused as invalid input, never accepted (RAD-364)", async () => {
    // Before the refused state, a marked 422 of kind group/unknown mapped to
    // "found" and validateTelegramSource accepted it.
    expect(await validateTelegramSource("https://t.me/oldgroup")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_INVALID_INPUT",
    })
    expect(await validateTelegramSource("https://t.me/Family")).toEqual({
      verdict: "reject",
      code: "TELEGRAM_INVALID_INPUT",
    })
  })

  it("FAILS OPEN when the worker process is down entirely (ECONNREFUSED)", async () => {
    // Point the client at a port nothing is listening on.
    const probe = await probeClientOn(1)
    expect(await probe("durov")).toEqual({ status: "unavailable" })
  })
})

describe("parse-channel refusal over a real HTTP wire (RAD-364)", () => {
  // lib/parsers/telegram.ts reads WORKER_HEALTH_PORT at import, like the probe.
  async function parserOn(port: number) {
    process.env.WORKER_HEALTH_PORT = String(port)
    vi.resetModules()
    return (await import("@/lib/parsers/telegram")).parseTelegramChannel
  }

  it.each(["https://t.me/pavel", "https://t.me/example_bot", "https://t.me/me", "+79991234567", "https://t.me/Family"])(
    "%s fails as a source — one attempt, the refusal as the error, no messages read",
    async (url) => {
      getMessages.mockClear()
      const port = await listen(makeWorker())
      const parse = await parserOn(port)
      const fetchSpy = vi.spyOn(globalThis, "fetch")
      try {
        await expect(parse(url, 20, true)).rejects.toThrow(/Failed to parse Telegram channel: .*(not a Telegram channel|not a public Telegram channel)/)
        // A 422 is not transient: exactly one call to the worker, no retry.
        expect(fetchSpy.mock.calls.filter(([u]) => String(u).endsWith("/telegram/parse-channel"))).toHaveLength(1)
      } finally {
        fetchSpy.mockRestore()
      }
      expect(getMessages).not.toHaveBeenCalled()
    }
  )

  it("a channel still parses end-to-end", async () => {
    const port = await listen(makeWorker())
    const parse = await parserOn(port)
    const items = await parse("https://t.me/durov", 20, true)
    expect(items.map((i) => i.url)).toEqual(["https://t.me/durov/2", "https://t.me/durov/1"])
  })
})
