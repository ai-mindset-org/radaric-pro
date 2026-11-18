/**
 * @vitest-environment jsdom
 */

/**
 * RAD-326 — the feed card's "Run parsing" opens its own EventSource on
 * `/api/parse-stream`. A rate-limited request used to surface as a bare
 * transport error ("Connection error"), with the Retry-After thrown away. The
 * route now answers an event-stream caller with an in-band `RATE_LIMITED`
 * frame; the card must say when to try again, keep the feed's own error state
 * clean (the feed is not broken), and not retry on its own.
 *
 * RAD-406 — the same blindness for an expired session and an unverified email:
 * both arrive as in-band frames now, and the card shows a neutral notice that
 * says how to get past them.
 *
 * RAD-407 — a genuine drop is not the end of the run. Parse runs are
 * server-owned and a CDN or reverse proxy can truncate this stream, so the card
 * follows the run through `/api/parse-stream/status` and shows its real result.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react"
import { FeedCard } from "@/components/feeds/feed-card"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readyState = FakeEventSource.OPEN
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
  emit(payload: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(payload) }))
  }
  fail() {
    act(() => {
      this.readyState = FakeEventSource.CLOSED
      this.onerror?.(new Event("error"))
    })
  }
}

const SOURCE = {
  id: "f1",
  type: "RSS" as const,
  url: "https://example.com/feed",
  name: "Example",
  coverUrl: null,
  isActive: true,
  status: "ACTIVE" as const,
}

function clickParse() {
  fireEvent.click(screen.getByRole("button", { name: "Run parsing" }))
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  toast.mockClear()
  toast.error.mockClear()
  toast.warning.mockClear()
  toast.success.mockClear()
  router.refresh.mockClear()
  vi.useRealTimers()
})

describe("FeedCard parse — rate limit (RAD-326)", () => {
  it("says when to try again instead of reporting a connection error", () => {
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    expect(stream.url).toBe("/api/parse-stream?sourceIds=f1")

    stream.emit({
      type: "error",
      code: "RATE_LIMITED",
      retryAfter: 42,
      message: "Too many requests — try again in 42s",
      error: "Too many requests — try again in 42s",
    })

    expect(screen.getByRole("status")).toHaveTextContent("Too many requests — try again in 42s")
    expect(toast.warning).toHaveBeenCalledWith("Too many requests — try again in 42s")
    expect(toast.error).not.toHaveBeenCalled()
    // The feed itself is fine: no persistent error block on the card.
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.body).not.toHaveTextContent(/connection error/i)
    // Closed, not retried.
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeEnabled()
  })


  it("shows a run-level error sent under `error`, not `Unknown error`", () => {
    render(<FeedCard source={SOURCE} />)
    clickParse().emit({ type: "error", error: "Subscription required" })
    expect(screen.getByRole("alert")).toHaveTextContent("Subscription required")
  })
})

type StatusAnswer = { ok: boolean; status?: number; redirected?: boolean; url?: string; body?: unknown }

/** Status answers by call number; the last one repeats. Returns the fetch spy. */
function stubStatus(answers: Array<StatusAnswer | "throw">) {
  let call = 0
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes("/api/parse-stream/status")) throw new Error(`unexpected fetch ${url}`)
    const answer = answers[Math.min(call++, answers.length - 1)]
    if (answer === "throw") throw new TypeError("Failed to fetch")
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 500),
      redirected: answer.redirected ?? false,
      url: answer.url ?? `http://localhost${url}`,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError("Unexpected token '<'")
        return answer.body
      },
    } as unknown as Response
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

const running = (processed: number, approved: number, filtered: number, id = "r1") => ({
  ok: true,
  body: { run: { id, startedAt: 1, finishedAt: null, status: "running", total: 1, processed, approved, filtered, results: null } },
})
const finished = (results: Record<string, unknown>, status: "done" | "stopped" = "done", id = "r1") => ({
  ok: true,
  body: {
    run: {
      id,
      startedAt: 1,
      finishedAt: 2,
      status,
      total: 1,
      processed: 1,
      approved: (results.approved as number) ?? 0,
      filtered: (results.filtered as number) ?? 0,
      results,
    },
  },
})

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("FeedCard parse — refused for sign-in or email verification (RAD-406)", () => {
  it("tells a signed-out user to sign in again, with the way to do it, and keeps the notice", async () => {
    vi.useFakeTimers()
    const fetchSpy = stubStatus([{ ok: true, body: { run: null } }])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()

    stream.emit({ type: "error", code: "UNAUTHORIZED", message: "x", error: "x" })

    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent(/sign in again/i)
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/signup")
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/sign in again/i))
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.body).not.toHaveTextContent(/connection/i)
    expect(stream.closed).toBe(true)
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeEnabled()

    // A refusal is not a drop: nothing to follow, nothing to retry — and the
    // notice names no wait, so it does not expire. (The route closes the
    // stream after the frame and the card closed it too, so no transport
    // error follows; none is simulated.)
    await tick(10 * 60_000)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(screen.getByRole("status")).toHaveTextContent(/sign in again/i)
  })

  it("tells an unverified user to verify the email and where to resend the link", () => {
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()

    stream.emit({ type: "error", code: "EMAIL_NOT_VERIFIED", message: "x", error: "x" })

    expect(screen.getByRole("status")).toHaveTextContent(/verify your email.*resend/i)
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/verify your email/i))
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(stream.closed).toBe(true)
  })
})

describe("FeedCard parse — a dropped stream follows the server-owned run (RAD-407)", () => {
  it("keeps parsing after a drop and shows the run's real result when it finishes", async () => {
    vi.useFakeTimers()
    const fetchSpy = stubStatus([running(0, 1, 0), finished({ approved: 2, filtered: 1, errors: [] })])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    stream.emit({ type: "source_start", sourceId: "f1", sourceName: "Example" })
    stream.fail()

    // Not a failure: the run is still going on the server.
    expect(toast.error).not.toHaveBeenCalled()
    expect(document.body).not.toHaveTextContent(/connection error/i)
    expect(screen.getByRole("button", { name: "Parsing..." })).toBeDisabled()
    expect(document.body).toHaveTextContent(/still parsing on the server/i)

    await tick(4000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Parsing..." })).toBeDisabled()

    await tick(4000)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(document.body).toHaveTextContent("Done: 3 new posts")
    expect(toast.success).toHaveBeenCalledWith("Parsing complete: 3 new posts")
    expect(router.refresh).toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeEnabled()
    // Followed, never reconnected: one stream for the whole run.
    expect(FakeEventSource.instances).toHaveLength(1)

    await tick(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("shows the run's own error when the server finished it with one", async () => {
    vi.useFakeTimers()
    stubStatus([finished({ approved: 0, filtered: 0, errors: ["Example: feed returned 404"] })])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    stream.emit({ type: "parse_start", sourceCount: 1, sources: [{ id: "f1", name: "Example" }], runId: "r1" })
    stream.fail()

    await tick(4000)
    expect(screen.getByRole("alert")).toHaveTextContent("Example: feed returned 404")
    expect(toast.error).toHaveBeenCalledWith("Error: Example: feed returned 404")
    expect(document.body).not.toHaveTextContent(/connection error/i)
  })

  it("says honestly when the server has no record of the run", async () => {
    vi.useFakeTimers()
    stubStatus([{ ok: true, body: { run: null } }])
    render(<FeedCard source={SOURCE} />)
    clickParse().fail()

    // One unusable body is a race (the route may still be claiming the run).
    await tick(4000)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("button", { name: "Parsing..." })).toBeDisabled()

    await tick(4000)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(/lost the connection/i)
    expect(alert).toHaveTextContent(/no record of this parse/i)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeEnabled()
  })

  it("gives up with an honest error only after the status check keeps failing", async () => {
    vi.useFakeTimers()
    const fetchSpy = stubStatus(["throw"])
    render(<FeedCard source={SOURCE} />)
    clickParse().fail()

    await tick(4000 * 14)
    expect(fetchSpy).toHaveBeenCalledTimes(14)
    expect(screen.queryByRole("alert")).toBeNull()

    await tick(4000)
    expect(fetchSpy).toHaveBeenCalledTimes(15)
    expect(screen.getByRole("alert")).toHaveTextContent(/lost the connection/i)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it("stops following when the card unmounts", async () => {
    vi.useFakeTimers()
    const fetchSpy = stubStatus([running(0, 0, 0)])
    const { unmount } = render(<FeedCard source={SOURCE} />)
    clickParse().fail()
    await tick(4000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    unmount()
    await tick(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

const MANIFEST = { type: "parse_start", sourceCount: 1, sources: [{ id: "f1", name: "Example" }] }

describe("FeedCard parse — a follow reports only its own run (RAD-407)", () => {
  it("never reports an earlier run's results when the stream died before parse_start", async () => {
    // The registry keeps the user's last run for 15 minutes. A stream that dies
    // before the server's first frame gives the card no id, and the first poll
    // answers with that earlier, finished run.
    vi.useFakeTimers()
    stubStatus([finished({ approved: 5, filtered: 0, errors: [] }, "done", "r-old")])
    render(<FeedCard source={SOURCE} />)
    clickParse().fail()

    await tick(4000)
    expect(screen.getByRole("button", { name: "Parsing..." })).toBeDisabled()
    await tick(4000)

    expect(document.body).not.toHaveTextContent(/5 new posts/)
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/no record of this parse/i)
  })

  it("after parse_start, another run's snapshot is not this run's result", async () => {
    vi.useFakeTimers()
    stubStatus([finished({ approved: 5, filtered: 0, errors: [] }, "done", "r-old")])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    stream.emit({ ...MANIFEST, runId: "r-new" })
    stream.fail()

    await tick(8000)
    expect(document.body).not.toHaveTextContent(/5 new posts/)
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/no record of this parse/i)
  })

  it("after parse_start, waits past another run's snapshot and settles on its own", async () => {
    vi.useFakeTimers()
    stubStatus([
      finished({ approved: 5, filtered: 0, errors: [] }, "done", "r-old"),
      finished({ approved: 2, filtered: 0, errors: [] }, "done", "r-new"),
    ])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    stream.emit({ ...MANIFEST, runId: "r-new" })
    stream.fail()

    await tick(8000)
    expect(document.body).toHaveTextContent("Done: 2 new posts")
    expect(toast.success).toHaveBeenCalledWith("Parsing complete: 2 new posts")
    expect(toast.success).toHaveBeenCalledTimes(1)
  })
})

describe("FeedCard parse — the session ends while following a run (RAD-406)", () => {
  it.each([
    ["a 401", { ok: false, status: 401, body: { error: "Unauthorized" } }],
    ["a redirect to the sign-in page", { ok: true, redirected: true, url: "http://localhost/signup?_rsc=1" }],
  ] as Array<[string, StatusAnswer]>)("reads %s from the status check as signed out, at once", async (_, answer) => {
    vi.useFakeTimers()
    const fetchSpy = stubStatus([answer])
    render(<FeedCard source={SOURCE} />)
    const stream = clickParse()
    stream.emit({ ...MANIFEST, runId: "r1" })
    stream.fail()

    await tick(4000)
    expect(screen.getByRole("status")).toHaveTextContent(/sign in again/i)
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/signup")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
    // Signed out, a refresh would navigate away and take the notice with it.
    expect(router.refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeEnabled()

    await tick(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("FeedCard parse — the refusal notice is announced (RAD-406)", () => {
  it("keeps one live region mounted and fills it, rather than inserting a region with text", () => {
    render(<FeedCard source={SOURCE} />)
    const region = screen.getByRole("status")
    expect(region).toBeEmptyDOMElement()

    clickParse().emit({ type: "error", code: "EMAIL_NOT_VERIFIED", message: "x", error: "x" })

    expect(screen.getByRole("status")).toBe(region)
    expect(region).toHaveTextContent(/verify your email/i)
  })
})
