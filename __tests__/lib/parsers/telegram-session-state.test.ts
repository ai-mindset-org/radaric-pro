/**
 * Telegram session state mapping — RAD-328.
 *
 * The decoy this replaces: the old `checkTelegramSession` fell back to "a
 * session string exists in the database" when the worker was unreachable, so
 * the settings UI reported an authorized account while every parse request was
 * failing. An unreachable worker must read as `unknown`, never as active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { checkTelegramSession, getTelegramSessionState } from "@/lib/parsers/telegram"
import { db } from "@/lib/db"

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn() },
  },
}))

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe("getTelegramSessionState (RAD-328)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports active when the worker reports a live session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: true, state: "active" }))
    expect(await getTelegramSessionState()).toBe("active")
  })

  it("passes the worker's lifecycle states through", async () => {
    for (const state of ["starting", "invalid", "unconfigured"] as const) {
      fetchMock.mockResolvedValue(jsonResponse({ valid: false, state }))
      expect(await getTelegramSessionState()).toBe(state)
    }
  })

  it("reports unknown for an older worker that only answers valid:false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: false }))
    expect(await getTelegramSessionState()).toBe("unknown")
  })

  it("reports unknown for an unrecognized state string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: false, state: "banana" }))
    expect(await getTelegramSessionState()).toBe("unknown")
  })

  it("reports unknown for the worker's exhausted-retries state", async () => {
    // The worker's `unavailable` is deliberately not a UI state — the badge
    // stays conservative rather than claiming it will connect.
    fetchMock.mockResolvedValue(jsonResponse({ valid: false, state: "unavailable" }))
    expect(await getTelegramSessionState()).toBe("unknown")
  })

  it("reports unknown when the worker answers non-2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false))
    expect(await getTelegramSessionState()).toBe("unknown")
  })

  it("reports unknown when the worker is unreachable — never inferred from the database", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    vi.mocked(db.settings.findFirst).mockResolvedValue({ telegramSessionString: "present" } as never)
    expect(await getTelegramSessionState()).toBe("unknown")
    expect(db.settings.findFirst).not.toHaveBeenCalled()
  })

  it("checkTelegramSession is true only for an active session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: true, state: "active" }))
    expect(await checkTelegramSession()).toBe(true)

    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    expect(await checkTelegramSession()).toBe(false)
  })
})

/**
 * RAD-359 plan D9: a timed-out worker call must NOT be retried. The old
 * behaviour re-ran the whole parse up to six times, and each re-run starts new
 * media downloads behind a response nobody will read — doubling R2 writes and
 * Telegram load on the single shared session.
 */
describe("fetchWorkerWithRetry — no retry on timeout (RAD-359)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fails once on a TimeoutError instead of re-running the parse", async () => {
    const timeout = new Error("The operation was aborted due to timeout")
    timeout.name = "TimeoutError"
    fetchMock.mockRejectedValue(timeout)

    const { parseTelegramChannel } = await import("@/lib/parsers/telegram")
    await expect(parseTelegramChannel("@ch", 10)).rejects.toThrow(/timed out/i)
    // One session probe (no-account fallback check), then exactly one parse attempt.
    const parseCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/telegram/parse-channel"))
    expect(parseCalls).toHaveLength(1)
  })
})
