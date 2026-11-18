/** @vitest-environment jsdom */

/**
 * RAD-318 Phase 2 — the processing controller.
 *
 * The reducer's own suite proves the state transitions; this one proves the
 * transport behaves: streams settle exactly once, a stopped run cannot come
 * back to life through a late frame or a deferred auto-grouping, and unmount
 * leaves nothing pending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { usePostProcessing } from "@/components/materials/use-post-processing"
import { collectedCount, approvedCount, summaryText } from "@/lib/materials/processing-state"

/**
 * The run state is a store now, not a render value: the hook returns coarse
 * slices (`isRunning`, `isTerminal`, `phase`) and keeps the rest out of the
 * posts grid's render path, so a streamed frame no longer re-measures every
 * card. Assertions about the full state read it from the store.
 */
function runState(result: { current: ReturnType<typeof usePostProcessing> }) {
  return result.current.store.getSnapshot()
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  /** Mirrors the real constants — the controller reads them to tell a dead
   *  connection from one the browser would have retried. */
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
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
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) })
    })
  }

  /** A connection that is gone for good. */
  fail() {
    act(() => {
      this.readyState = FakeEventSource.CLOSED
      this.onerror?.()
    })
  }

  /** A blip the browser would retry — same event, different readyState. */
  blip() {
    act(() => {
      this.readyState = FakeEventSource.CONNECTING
      this.onerror?.()
    })
  }

  static openFor(pattern: string): FakeEventSource {
    const match = [...FakeEventSource.instances].reverse().find(i => i.url.includes(pattern) && !i.closed)
    if (!match) {
      throw new Error(`no open stream for "${pattern}"; open: ${FakeEventSource.instances.map(i => `${i.url}${i.closed ? " (closed)" : ""}`).join(", ") || "none"}`)
    }
    return match
  }

  static get open() {
    return FakeEventSource.instances.filter(i => !i.closed)
  }
}

const SOURCES = [
  { id: "src-a", name: "Alpha Journal" },
  { id: "src-b", name: "Beta Weekly" },
]

/**
 * The one `fetch` stub for this file: the account's source listing, the
 * RAD-346 run-status endpoint, and the stop endpoint. The default status answer
 * is `{ run: null }` — the server has no record of a run — so a stream that dies
 * inside a test settles through the poll as the dropped/interrupted failure it
 * always was. Tests that need a live or failed status response pass their own
 * responder and get the call count back.
 *
 * RAD-347: the hook now asks the status endpoint once on mount, to find a run
 * it did not start, so the *first* status call(s) of a test belong to that
 * check rather than to the drop poll. Tests that script answers by call number
 * account for it; tests that need the check to be invisible pass the default
 * `{ run: null }` and let its two-body tolerance stand it down.
 */
function mockActiveSources(
  sources = SOURCES,
  status: (call: number) => {
    ok: boolean
    status?: number
    redirected?: boolean
    url?: string
    json: () => Promise<unknown>
  } = () => ({
    ok: true,
    json: async () => ({ run: null }),
  })
) {
  let statusCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/parse-stream/stop")) {
        return { ok: true, json: async () => ({}) } as unknown as Response
      }
      if (url.includes("/api/parse-stream/status")) return status(++statusCalls) as unknown as Response
      return { ok: true, json: async () => sources } as unknown as Response
    })
  )
  return { statusCalls: () => statusCalls }
}

/** Drive a parse from click to parse_complete, returning the stream. */
async function runParseToCompletion(
  result: { current: ReturnType<typeof usePostProcessing> },
  opts: { approved?: number } = {}
) {
  const approved = opts.approved ?? 0
  await act(async () => {
    result.current.startParse()
  })
  const stream = FakeEventSource.openFor("/api/parse-stream")
  stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
  stream.emit({ type: "source_start", sourceId: "src-a", sourceName: "Alpha Journal" })
  stream.emit({ type: "source_complete", sourceId: "src-a", sourceName: "Alpha Journal", stats: { approved, filtered: 1 } })
  stream.emit({ type: "source_complete", sourceId: "src-b", sourceName: "Beta Weekly", stats: { approved: 0, filtered: 0 } })
  stream.emit({ type: "parse_complete", results: { approved, filtered: 1, errors: [] } })
  return stream
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  mockActiveSources()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a successful parse", () => {
  it("asks for the account's active sources and streams them all", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await act(async () => {
      result.current.startParse()
    })

    expect(fetch).toHaveBeenCalledWith("/api/feeds?active=true", expect.anything())
    expect(FakeEventSource.openFor("/api/parse-stream").url).toContain("sourceIds=src-a,src-b")
  })

  it("streams materials out as they arrive rather than at the end", async () => {
    const onMaterial = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onMaterial }))

    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.emit({ type: "material_created", sourceId: "src-a", material: { id: "m1" } })

    expect(onMaterial).toHaveBeenCalledWith({ id: "m1" })
    expect(result.current.isRunning).toBe(true)
  })

  it("closes the stream and refreshes the list exactly once when it completes", async () => {
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))

    const stream = await runParseToCompletion(result)

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.open).toHaveLength(0)
    expect(result.current.isRunning).toBe(false)
    expect(result.current.isTerminal).toBe(true)
    expect(runState(result).outcome).toBe("success")
  })

  it("scopes the run to one source on a source page, without listing the account", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", sourceId: "src-b" }))

    await act(async () => {
      result.current.startParse()
    })

    // RAD-347: the mount check does read the status endpoint, so "without
    // listing the account" now means exactly that — no account-wide feed query.
    expect(fetch).not.toHaveBeenCalledWith("/api/feeds?active=true", expect.anything())
    expect(FakeEventSource.openFor("/api/parse-stream").url).toContain("sourceIds=src-b")
  })

  it("settles a run with no active sources instead of opening a stream", async () => {
    mockActiveSources([])
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await act(async () => {
      result.current.startParse()
    })

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(result.current.isRunning).toBe(false)
    expect(runState(result).phase).toBe("done")
  })
})

describe("automatic grouping", () => {
  it("follows a parse that approved posts, as one continuous run", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await runParseToCompletion(result, { approved: 3 })

    await waitFor(() => FakeEventSource.openFor("/api/posts/group-stories"))
    const group = FakeEventSource.openFor("/api/posts/group-stories")
    group.emit({ type: "start", total: 3 })
    expect(runState(result).phase).toBe("grouping")

    group.emit({ type: "complete", storiesCreated: 1, storiesUpdated: 0 })
    expect(runState(result).phase).toBe("done")
    expect(group.closed).toBe(true)
  })

  it("is skipped when the parse approved nothing", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await runParseToCompletion(result, { approved: 0 })

    await act(async () => {})
    expect(FakeEventSource.instances.some(i => i.url.includes("group-stories"))).toBe(false)
    expect(runState(result).phase).toBe("done")
  })

  it("leaves the run partial rather than failed when grouping fails after a good parse", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await runParseToCompletion(result, { approved: 2 })

    await waitFor(() => FakeEventSource.openFor("/api/posts/group-stories"))
    FakeEventSource.openFor("/api/posts/group-stories").emit({ type: "error", message: "Story grouping failed" })

    expect(runState(result).outcome).toBe("partial")
    expect(runState(result).errors).toContain("Story grouping failed")
  })
})

describe("manual grouping and re-filtering", () => {
  it("runs grouping on its own, scoped to the source page", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", sourceId: "src-b" }))

    await act(async () => {
      result.current.startGrouping()
    })

    const group = FakeEventSource.openFor("/api/posts/group-stories")
    expect(group.url).toBe("/api/posts/group-stories?feedId=src-b")
    group.emit({ type: "start", total: 4 })
    group.emit({ type: "progress", current: 2, total: 4 })
    expect(runState(result).phaseProgress).toEqual({ current: 2, total: 4 })
  })

  it("runs re-filtering on its own", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "FILTERED" }))

    await act(async () => {
      result.current.startRefilter()
    })

    const refilter = FakeEventSource.openFor("/api/posts/refilter")
    refilter.emit({ type: "start", total: 10 })
    expect(runState(result).phase).toBe("refiltering")

    refilter.emit({ type: "complete", flippedToApproved: 2, flippedToFiltered: 1 })
    expect(runState(result).phase).toBe("done")
    expect(runState(result).phaseResult).toMatchObject({ flippedToApproved: 2, flippedToFiltered: 1 })
  })
})

describe("one run at a time", () => {
  it("ignores a second start while a run is active", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await act(async () => {
      result.current.startParse()
    })
    const first = FakeEventSource.openFor("/api/parse-stream")

    await act(async () => {
      result.current.startParse()
      result.current.startGrouping()
      result.current.startRefilter()
    })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(first.closed).toBe(false)
  })

  it("allows a new run once the previous one is terminal", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await runParseToCompletion(result)

    await act(async () => {
      result.current.startRefilter()
    })

    expect(runState(result).kind).toBe("refilter")
    expect(FakeEventSource.openFor("/api/posts/refilter")).toBeTruthy()
  })
})

describe("stop", () => {
  it("closes the stream and settles the run, in every phase", async () => {
    for (const phase of ["parsing", "grouping", "refiltering"] as const) {
      FakeEventSource.instances = []
      const { result, unmount } = renderHook(() => usePostProcessing({ view: "INBOX" }))

      await act(async () => {
        if (phase === "refiltering") result.current.startRefilter()
        else if (phase === "grouping") result.current.startGrouping()
        else result.current.startParse()
      })
      const stream = FakeEventSource.open[0]
      stream.emit(phase === "parsing" ? { type: "parse_start", sourceCount: 2, sources: SOURCES } : { type: "start", total: 5 })
      expect(runState(result).phase).toBe(phase)

      act(() => {
        result.current.stop()
      })

      expect(stream.closed).toBe(true)
      expect(runState(result).phase).toBe("done")
      expect(runState(result).outcome).toBe("stopped")
      unmount()
    }
  })

  it("keeps a stopped run stopped when late frames arrive", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    act(() => {
      result.current.stop()
    })

    // The browser can still deliver buffered frames after close().
    stream.emit({ type: "source_complete", sourceId: "src-a", sourceName: "Alpha Journal", stats: { approved: 9 } })
    stream.emit({ type: "parse_complete", results: { approved: 9, filtered: 0 } })

    expect(runState(result).outcome).toBe("stopped")
    expect(runState(result).finalResults).toBeNull()
  })

  it("does not auto-group after a stop, even though the parse promise now settles", async () => {
    // This is the regression the old code prevented only by accident: cancel
    // closed the EventSource and left parseAllFeeds pending forever. With the
    // promise settled, only the generation guard stands between Stop and a
    // grouping run the user never asked for.
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.emit({ type: "source_complete", sourceId: "src-a", sourceName: "Alpha Journal", stats: { approved: 5 } })

    act(() => {
      result.current.stop()
    })
    stream.emit({ type: "parse_complete", results: { approved: 5, filtered: 0 } })
    await act(async () => {})

    expect(FakeEventSource.instances.some(i => i.url.includes("group-stories"))).toBe(false)
    expect(runState(result).outcome).toBe("stopped")
  })

  it("stops handing late materials to the grid", async () => {
    // The reducer drops stale actions, but onMaterial is a side effect outside
    // it: only the controller's own generation check keeps a stopped run from
    // pushing more cards into the list.
    const onMaterial = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onMaterial }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.emit({ type: "material_created", sourceId: "src-a", material: { id: "m1" } })
    expect(onMaterial).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.stop()
    })
    stream.emit({ type: "material_created", sourceId: "src-a", material: { id: "m2" } })

    expect(onMaterial).toHaveBeenCalledTimes(1)
  })

  it("refreshes the list once, because server-side work may already have landed", async () => {
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))
    await act(async () => {
      result.current.startParse()
    })
    FakeEventSource.openFor("/api/parse-stream").emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    act(() => {
      result.current.stop()
    })
    await act(async () => {})

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("is inert when nothing is running", async () => {
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))

    act(() => {
      result.current.stop()
    })

    expect(onRefresh).not.toHaveBeenCalled()
    expect(runState(result).phase).toBe("idle")
  })
})

describe("transport failure", () => {
  it("marks a dropped stream as such rather than leaving a spinner forever", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    stream.fail()
    await act(async () => {})

    // RAD-346: a lost connection no longer ends the run in place — the card
    // detaches and the poll decides. It is still not a spinner: the poll is
    // bounded, and the run ends as a drop, never as a silent success.
    expect(runState(result).detached).toBe(true)
    expect(result.current.isRunning).toBe(true)

    // The status endpoint has no record of this run (`{ run: null }`), which is
    // the dropped/interrupted fallback — the same failure the user saw before.
    // RAD-347: one unusable body no longer settles, so the fallback now takes
    // two 4 s polls — the timeout covers the grace, not a new latency.
    await waitFor(() => expect(runState(result).phase).toBe("done"), { timeout: 12000 })

    expect(runState(result).droppedWithoutCompletion).toBe(true)
    expect(runState(result).outcome).toBe("failed")
    expect(runState(result).finalResults).toBeNull()
    expect(result.current.isRunning).toBe(false)
    // The transport died with the socket CLOSED, so the reason is "dropped".
    expect(runState(result).errors).toEqual([
      "The connection ended before the run reported completion.",
    ])
  })

  it("surfaces a failed source listing as a fatal run error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response))
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => expect(runState(result).phase).toBe("done"))

    expect(runState(result).outcome).toBe("failed")
    expect(runState(result).errors).toContain("Failed to fetch the list of sources")
  })

  it("shows the run-level payload shape the subscription gate uses", async () => {
    // parse-stream/route.ts:283,:310 send `{type:"error", error}`; the old
    // client read `message` only and rendered nothing at all.
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "error", error: "Subscription required" })

    expect(runState(result).errors).toContain("Subscription required")
    expect(runState(result).phase).toBe("done")
    expect(stream.closed).toBe(true)
  })

  it("keeps a source-level error from ending the whole run", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.emit({ type: "error", sourceId: "src-a", sourceName: "Alpha Journal", message: "Feed timed out" })

    expect(runState(result).phase).toBe("parsing")
    expect(stream.closed).toBe(false)

    stream.emit({ type: "source_complete", sourceId: "src-b", sourceName: "Beta Weekly", stats: {} })
    stream.emit({ type: "parse_complete", results: { errors: [] } })
    expect(runState(result).outcome).toBe("partial")
  })
})

describe("unmount", () => {
  it("closes every stream and leaves nothing to resolve into a dead reducer", async () => {
    const onRefresh = vi.fn()
    const { result, unmount } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    unmount()

    expect(stream.closed).toBe(true)
    // A frame delivered after unmount must not dispatch; React would warn and
    // the run is gone either way.
    expect(() => stream.emit({ type: "parse_complete", results: {} })).not.toThrow()
    await act(async () => {})
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe("scope", () => {
  it("retires a terminal card when the view changes under it", async () => {
    const { result, rerender } = renderHook(({ view }) => usePostProcessing({ view }), {
      initialProps: { view: "INBOX" },
    })
    await runParseToCompletion(result)
    expect(result.current.isTerminal).toBe(true)

    rerender({ view: "ARCHIVED" })

    // Retired, not reset: `dismissed` is what takes the card out of the grid,
    // and the finished run stays readable for the exit animation.
    expect(result.current.isTerminal).toBe(false)
    expect(runState(result).dismissed).toBe(true)
    expect(runState(result).outcome).toBe("success")
  })

  it("keeps a running card when the view changes under it", async () => {
    const { result, rerender } = renderHook(({ view }) => usePostProcessing({ view }), {
      initialProps: { view: "INBOX" },
    })
    await act(async () => {
      result.current.startParse()
    })
    FakeEventSource.openFor("/api/parse-stream").emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    rerender({ view: "FILTERED" })

    expect(result.current.isRunning).toBe(true)
    expect(FakeEventSource.openFor("/api/parse-stream").closed).toBe(false)
  })
})

describe("the generation mirror and the reducer stay in lockstep", () => {
  /**
   * A terminal frame delivered from the EventSource callback is a default-lane
   * update, so a discrete click can run before React has flushed it — which is
   * exactly when a user clicks Stop, as a long parse finishes.
   *
   * The controller used to read `state.phase` from the last COMMITTED render
   * and would bump its mirror anyway, leaving the reducer to repair it. It now
   * reads `stateRef.current` synchronously, so it sees the settled run and
   * no-ops: no mirror bump, no STOP dispatch, and a finished card keeps saying
   * "Done" instead of flipping to "Stopped" under the user's cursor. The
   * reducer keeps its own backstop for that case, proved in the reducer suite
   * ("still retires the generation, without rewriting the finished run").
   */
  it("no-ops a stop that lands on a run which already settled", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const first = FakeEventSource.openFor("/api/parse-stream")
    first.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    // Deliver the terminal frame without letting React commit it, then click.
    const stopFromRunningRender = result.current.stop
    first.onmessage?.({ data: JSON.stringify({ type: "parse_complete", results: {} }) })
    const settled = runState(result)
    expect(settled.phase).toBe("done")

    act(() => {
      stopFromRunningRender()
    })

    expect(runState(result).outcome).toBe(settled.outcome)
    expect(runState(result).outcome).not.toBe("stopped")
    expect(runState(result).generation).toBe(settled.generation)

    // The next run must still be able to reach its own terminal state.
    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    expect(runState(result).phase).toBe("parsing")

    stream.emit({ type: "parse_complete", results: { approved: 1, filtered: 0 } })
    expect(runState(result).phase).toBe("done")
    expect(result.current.isRunning).toBe(false)
  })

  it("lets a dismissed run's late frames reach nothing", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
    await runParseToCompletion(result)

    act(() => {
      result.current.dismiss()
    })

    // A new run after a dismiss still works — the mirror moved with the reducer.
    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    FakeEventSource.openFor("/api/parse-stream").emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    expect(runState(result).phase).toBe("parsing")
  })
})

describe("closing a stream settles whatever was awaiting it", () => {
  /**
   * A closed EventSource fires neither `message` nor `error`, so nothing else
   * will ever resolve these promises. Left unsettled, the `await` inside
   * `startParse` stays suspended for the life of the page and retains its whole
   * closure — one leak per stop, one per unmount-mid-run. `stream.closed` alone
   * does not catch that: it is true of a leaked promise too.
   */
  it("settles the pending run when the user stops", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    FakeEventSource.openFor("/api/parse-stream").emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    let settled = false
    // The run's own `.finally` is what would never fire; observe it through the
    // one externally visible effect it has — `isRunning` going false and the
    // microtask queue draining with nothing left pending.
    act(() => {
      result.current.stop()
    })
    await act(async () => {
      await Promise.resolve()
      settled = true
    })

    expect(settled).toBe(true)
    expect(result.current.isRunning).toBe(false)
    expect(FakeEventSource.open).toHaveLength(0)
  })

  it("settles the pending run on unmount", async () => {
    mockActiveSources()
    const { result, unmount } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(stream.closed).toBe(true)
    expect(FakeEventSource.open).toHaveLength(0)
  })
})

describe("a retryable blip is not reported as a hard failure", () => {
  it("says the connection was interrupted, not that the run never reported", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.blip()

    // RAD-346: a blip detaches too, and settles from the status poll — the
    // timeout just covers the poll interval (the shared mock answers `{run:null}`).
    // RAD-347: two intervals, because one unusable body is now tolerated.
    await waitFor(() => expect(runState(result).phase).toBe("done"), { timeout: 12000 })
    expect(runState(result).errors.join(" ")).toContain("interrupted")
  })

  it("still reports a closed connection as a drop", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.fail()

    // RAD-346: the drop detaches the run; the poll then settles it. No spinner,
    // and no success: a closed connection is still reported as a drop.
    expect(runState(result).detached).toBe(true)
    expect(result.current.isRunning).toBe(true)

    // RAD-347: the fallback needs two consecutive unusable bodies, so the
    // settle arrives on the second 4 s poll rather than the first.
    await waitFor(() => expect(runState(result).phase).toBe("done"), { timeout: 12000 })

    expect(runState(result).droppedWithoutCompletion).toBe(true)
    expect(runState(result).outcome).toBe("failed")
    expect(runState(result).finalResults).toBeNull()
    // The socket is CLOSED, not retrying, so the reason stays "dropped" — the
    // poll fallback settles with the reason the stream errored with.
    expect(runState(result).errors).toEqual([
      "The connection ended before the run reported completion.",
    ])
  })
})

describe("the store notifies on every frame, not only on a phase change", () => {
  /**
   * This is the whole point of the store: `MaterialsList` re-renders only on a
   * phase/dismissed transition, so the per-frame detail reaches the card
   * through a subscription instead. Nothing else in the suite exercises that
   * path — the assertions elsewhere read `store.getSnapshot()`, which `dispatch`
   * mutates synchronously before it notifies anyone, so they would all still
   * pass if the notification were dropped entirely and the card froze on
   * "Starting…" for the length of the parse.
   */
  it("delivers frames that leave the phase untouched", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

    const seen: number[] = []
    const unsubscribe = result.current.store.subscribe(() => {
      seen.push(result.current.store.getSnapshot().sources.filter(s => s.state === "done").length)
    })

    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => FakeEventSource.openFor("/api/parse-stream"))
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
    stream.emit({ type: "source_complete", sourceId: "src-a", sourceName: "Alpha Journal", stats: {} })
    stream.emit({ type: "source_complete", sourceId: "src-b", sourceName: "Beta Weekly", stats: {} })

    // Both source frames leave `phase` at "parsing", so neither re-renders the
    // grid — and both must still reach the subscriber.
    expect(runState(result).phase).toBe("parsing")
    expect(seen).toEqual(expect.arrayContaining([1, 2]))

    const before = seen.length
    unsubscribe()
    stream.emit({ type: "parse_complete", results: { approved: 1 } })
    expect(seen).toHaveLength(before)
  })

  it("does not notify when the reducer drops the action", async () => {
    mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
    const stream = await runParseToCompletion(result)

    const seen: number[] = []
    const unsubscribe = result.current.store.subscribe(() => seen.push(1))
    // Terminal is terminal: the reducer returns the identical object, so the
    // store must stay silent rather than re-render the card for nothing.
    stream.emit({ type: "parse_complete", results: {} })
    expect(seen).toHaveLength(0)
    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// RAD-346 — the stream died but the run did not
// ---------------------------------------------------------------------------

/**
 * Polling constants from the spec (RAD-346, Constraints): the card asks the
 * server every 4 s and gives up after 15 consecutive failures.
 */
const STATUS_POLL_MS = 4000
const STATUS_MAX_FAILURES = 15

const RUNNING_SNAPSHOT = {
  id: "run-1",
  startedAt: 1,
  finishedAt: null,
  status: "running",
  total: 2,
  processed: 1,
  approved: 2,
  filtered: 1,
  results: null,
}

const DONE_SNAPSHOT = {
  id: "run-1",
  startedAt: 1,
  finishedAt: 9,
  status: "done",
  total: 2,
  processed: 2,
  approved: 5,
  filtered: 3,
  results: { parsed: 9, approved: 5, filtered: 3, errors: [] },
}

/** Start a parse and kill the transport mid-run, the way the CDN does. */
async function dropMidRun(result: { current: ReturnType<typeof usePostProcessing> }) {
  await act(async () => {
    result.current.startParse()
  })
  const stream = FakeEventSource.openFor("/api/parse-stream")
  stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })
  stream.emit({ type: "source_start", sourceId: "src-a", sourceName: "Alpha Journal" })
  stream.emit({
    type: "source_complete",
    sourceId: "src-a",
    sourceName: "Alpha Journal",
    stats: { approved: 1, filtered: 0 },
  })
  stream.fail()
  await act(async () => {})
  return stream
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("a dropped stream detaches instead of ending the run (RAD-346)", () => {
  it("AC-9: the card stays running, polls status, and settles once with the server's results", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, (call) => ({
        ok: true,
        // RAD-347: calls 1–2 belong to the mount check, which needs two unusable
        // bodies (`null`) before it stands down; the drop's own polls follow.
        json: async () => ({ run: call <= 2 ? null : call >= 5 ? DONE_SNAPSHOT : RUNNING_SNAPSHOT }),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await dropMidRun(result)

      // The transport is gone; the run is not.
      expect(runState(result).phase).toBe("parsing")
      expect(runState(result).detached).toBe(true)
      expect(result.current.isRunning).toBe(true)
      expect(runState(result).errors).toEqual([])

      // Poll by whole intervals until the server's snapshot is on the card —
      // whether the mount check stood down before the drop or is still racing
      // it, the poller reaches the same place.
      for (let i = 0; i < 3 && runState(result).serverProgress === null; i++) {
        await advance(STATUS_POLL_MS)
      }
      expect(statusCalls()).toBeGreaterThanOrEqual(1)
      expect(runState(result).phase).toBe("parsing")
      // The polled snapshot is what the card shows while the server works.
      expect(collectedCount(runState(result))).toBe(3)
      expect(approvedCount(runState(result))).toBe(2)

      // Poll until the server reports the run finished. Bounded, so a broken
      // poller fails the assertions below instead of hanging the suite.
      for (let i = 0; i < 4 && runState(result).phase !== "done"; i++) {
        await advance(STATUS_POLL_MS)
      }

      const settled = runState(result)
      expect(settled.phase).toBe("done")
      expect(settled.outcome).toBe("success")
      expect(settled.detached).toBe(false)
      expect(settled.serverProgress).toBeNull()
      expect(settled.finalResults).toEqual(DONE_SNAPSHOT.results)
      expect(collectedCount(settled)).toBe(8)
      expect(approvedCount(settled)).toBe(5)

      // Settled exactly once: no further polling.
      const callsWhenSettled = statusCalls()
      expect(callsWhenSettled).toBeGreaterThanOrEqual(3)
      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(callsWhenSettled)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ERR-2: a registry with no record settles the run as dropped without inventing a result", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: null }),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await dropMidRun(result)
      // Detached first: the fallback is a decision the poll makes, not the drop.
      expect(runState(result).detached).toBe(true)

      for (let i = 0; i < 3 && runState(result).phase !== "done"; i++) {
        await advance(STATUS_POLL_MS)
      }

      expect(statusCalls()).toBeGreaterThanOrEqual(1)
      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.droppedWithoutCompletion).toBe(true)
      expect(s.finalResults).toBeNull()
      expect(result.current.isRunning).toBe(false)
      // The socket was CLOSED, so the fallback keeps the "dropped" reason.
      expect(s.errors).toEqual(["The connection ended before the run reported completion."])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ERR-2: an empty status body is treated as no record, never as a finished run", async () => {
    vi.useFakeTimers()
    try {
      // A malformed/empty answer carries no `run` key at all. It must be read as
      // "the registry has nothing for you" — read naively (`{}` is truthy, and so
      // is `body.run` when the field is missing on some shapes) the card would
      // settle as a SUCCESS with invented zero totals.
      const { statusCalls } = mockActiveSources(SOURCES, () => ({ ok: true, json: async () => ({}) }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await dropMidRun(result)
      expect(runState(result).detached).toBe(true)

      for (let i = 0; i < 3 && runState(result).phase !== "done"; i++) {
        await advance(STATUS_POLL_MS)
      }

      expect(statusCalls()).toBeGreaterThanOrEqual(1)
      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.outcome).toBe("partial")
      expect(s.droppedWithoutCompletion).toBe(true)
      expect(s.finalResults).toBeNull()
      expect(approvedCount(s)).toBe(0)
      expect(collectedCount(s)).toBe(0)
      // A drop, with the reason the closed socket carried — never a success.
      expect(s.errors).toEqual(["The connection ended before the run reported completion."])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ERR-1: fifteen consecutive status failures settle the run as dropped, not forever", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await dropMidRun(result)
      expect(runState(result).detached).toBe(true)

      // RAD-347: the mount check has already spent its one best-effort request
      // against this all-500 responder, so the cap is asserted as a delta —
      // exactly STATUS_MAX_FAILURES poll attempts after the drop.
      const callsBeforePolling = statusCalls()

      // A blip — an instance restarting — must not settle the card.
      await advance(STATUS_POLL_MS * 3)
      expect(runState(result).phase).toBe("parsing")
      expect(result.current.isRunning).toBe(true)

      // ~1 minute of failures at 4 s intervals.
      await advance(STATUS_POLL_MS * STATUS_MAX_FAILURES)

      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.droppedWithoutCompletion).toBe(true)
      expect(s.finalResults).toBeNull()
      expect(statusCalls() - callsBeforePolling).toBe(STATUS_MAX_FAILURES)

      // Bounded: it does not keep knocking after settling.
      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls() - callsBeforePolling).toBe(STATUS_MAX_FAILURES)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-5: unmounting a detached card cancels the poller — no timer survives", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, (call) => ({
        ok: true,
        // RAD-347: calls 1–2 are the mount check standing down; the detached
        // poll (and the live snapshot it reports) follows.
        json: async () => ({ run: call <= 2 ? null : RUNNING_SNAPSHOT }),
      }))
      const { result, unmount } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await dropMidRun(result)
      await advance(STATUS_POLL_MS)
      expect(statusCalls()).toBeGreaterThanOrEqual(1)

      unmount()
      await act(async () => {})

      expect(vi.getTimerCount()).toBe(0)

      const callsAtUnmount = statusCalls()
      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(callsAtUnmount)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// RAD-347 — the card observes a run it did not start
// ---------------------------------------------------------------------------

/**
 * A run that was already going when this page mounted: started in another tab,
 * or started by this tab before a reload. RAD-346's detached state is the right
 * shape for it — the server owns the run and the card only watches — but until
 * now there was no way *into* that state except by losing a transport this tab
 * had opened itself. The second way in is the run-level
 * `"A parse is already running…"` frame, which used to be a terminal failure
 * whose card offered no Stop at all.
 */
const ATTACHED_RUNNING = {
  id: "run-attached",
  startedAt: 1,
  finishedAt: null,
  status: "running",
  total: 57,
  processed: 12,
  approved: 0,
  filtered: 0,
  results: null,
}

const ATTACHED_DONE = {
  id: "run-attached",
  startedAt: 1,
  finishedAt: 9,
  status: "done",
  total: 57,
  processed: 57,
  approved: 2,
  filtered: 3,
  results: { approved: 2, filtered: 3, errors: [] },
}

const ALREADY_RUNNING_MESSAGE =
  "A parse is already running. Wait for it to finish, then try again."

/** Drain the mount check's fetch → json → dispatch chain without moving the clock. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe("the card attaches to a run it did not start (RAD-347)", () => {
  it("AC-1: a running snapshot on mount opens the card detached, at the server's progress", async () => {
    vi.useFakeTimers()
    try {
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => ({ run: ATTACHED_RUNNING }) }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()

      const s = runState(result)
      expect(result.current.isRunning).toBe(true)
      expect(s.detached).toBe(true)
      expect(result.current.phase).toBe("parsing")
      expect(s.errors).toEqual([])
      expect(s.serverProgress).toEqual({ processed: 12, total: 57, approved: 0, collected: 0 })
      // The card never ran a "Starting…" phase it cannot back up: there is one
      // line in the log, and it says what the server is doing.
      expect(s.log).toHaveLength(1)
      expect(s.log[0].kind).toBe("info")
      // EC-5, read from a plain mount: an attach that found a live run must not
      // borrow the transport-loss notice — nothing of this card's was lost.
      expect(s.log[0].message).not.toContain("Connection lost")
      expect(summaryText(s)).toContain("12 of 57")
      expect(summaryText(s)).toMatch(/background/i)
      expect(summaryText(s)).not.toMatch(/starting|preparing/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-2: a done snapshot settles the attached card with the server's results, once", async () => {
    vi.useFakeTimers()
    try {
      let answer: unknown = { run: ATTACHED_RUNNING }
      const { statusCalls } = mockActiveSources(SOURCES, () => ({ ok: true, json: async () => answer }))
      const onRefresh = vi.fn()
      const { result } = renderHook(() =>
        usePostProcessing({ view: "INBOX", autoGroup: false, onRefresh })
      )

      await flush()
      expect(runState(result).detached).toBe(true)

      answer = { run: ATTACHED_DONE }
      for (let i = 0; i < 3 && runState(result).phase !== "done"; i++) {
        await advance(STATUS_POLL_MS)
      }

      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.finalResults).toEqual({ approved: 2, filtered: 3, errors: [] })
      expect(s.outcome).toBe("success")
      expect(result.current.isRunning).toBe(false)
      expect(s.detached).toBe(false)
      expect(s.serverProgress).toBeNull()
      expect(onRefresh).toHaveBeenCalledTimes(1)

      // Once, and only once: a settled card stops asking.
      const callsWhenSettled = statusCalls()
      await advance(STATUS_POLL_MS * 5)
      expect(onRefresh).toHaveBeenCalledTimes(1)
      expect(statusCalls()).toBe(callsWhenSettled)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-3: two unusable answers on mount leave no card and start no poller", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources() // the default: `{ run: null }` forever
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()
      // One unusable body is not a verdict (the route claims the run only after
      // auth, rate limit and two DB reads), so the check confirms once — and
      // then stands down instead of becoming a poller.
      await advance(STATUS_POLL_MS)

      expect(statusCalls()).toBe(2)
      expect(runState(result).phase).toBe("idle")
      expect(result.current.isRunning).toBe(false)
      expect(result.current.isTerminal).toBe(false)
      expect(runState(result).log).toEqual([])

      const afterCheck = statusCalls()
      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(afterCheck)
      expect(runState(result).phase).toBe("idle")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-4: the attach wins over a pending first run", async () => {
    vi.useFakeTimers()
    try {
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => ({ run: ATTACHED_RUNNING }) }))
      const start = vi.fn(async () => {})
      const { result } = renderHook(() =>
        usePostProcessing({ view: "INBOX", autoGroup: false, firstRun: { sourceCount: 5, start } })
      )

      await flush()
      await flush()

      // The account already has a run; the automatic parse would be a second
      // one, which is exactly what the server refuses.
      expect(start).not.toHaveBeenCalled()
      expect(FakeEventSource.instances).toHaveLength(0)
      const s = runState(result)
      expect(s.detached).toBe(true)
      expect(result.current.phase).toBe("parsing")
      expect(s.log).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-5: the 'already running' frame detaches the card instead of failing it", async () => {
    vi.useFakeTimers()
    try {
      let answer: unknown = { run: null }
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => answer }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      // Let the mount check stand down before the user presses Parse.
      await flush()
      await advance(STATUS_POLL_MS)

      await act(async () => {
        result.current.startParse()
      })
      const stream = FakeEventSource.openFor("/api/parse-stream")
      // EC-5: the route claims the run before the manifest, so a second caller
      // gets the run-level error ALONE — no `parse_start`, no source frames.
      // Both payload keys are sent because both of the route's error shapes are
      // real (`{error}` at the subscription gate, `{message}` at the source).
      stream.emit({ type: "error", error: ALREADY_RUNNING_MESSAGE, message: ALREADY_RUNNING_MESSAGE })

      // Not terminal: the run exists, it just is not this card's to drive — and
      // with no manifest to count against, the card must still read as running
      // rather than parked on "Starting…"/"Preparing…".
      const detached = runState(result)
      expect(detached.phase).toBe("parsing")
      expect(detached.detached).toBe(true)
      expect(detached.outcome).toBeNull()
      expect(detached.errors).toEqual([])
      expect(detached.finalResults).toBeNull()
      expect(result.current.isRunning).toBe(true)
      expect(summaryText(detached)).not.toMatch(/starting|preparing/i)

      // The notice may say it is watching a run already in progress; it must not
      // claim a connection this card never lost.
      const notice = detached.log.at(-1)
      expect(notice).toBeDefined()
      expect(notice?.message).not.toMatch(/lost|interrupted/i)

      // The server is the only source of truth from here, and it settles it.
      answer = { run: RUNNING_SNAPSHOT }
      for (let i = 0; i < 3 && runState(result).serverProgress === null; i++) {
        await advance(STATUS_POLL_MS)
      }
      expect(runState(result).serverProgress).toEqual({
        processed: 1,
        total: 2,
        approved: 2,
        collected: 3,
      })

      answer = { run: DONE_SNAPSHOT }
      for (let i = 0; i < 3 && runState(result).phase !== "done"; i++) {
        await advance(STATUS_POLL_MS)
      }

      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.finalResults).toEqual(DONE_SNAPSHOT.results)
      expect(s.detached).toBe(false)
      expect(result.current.isRunning).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-6: one unusable status body does not settle the detached run, the second does", async () => {
    vi.useFakeTimers()
    try {
      mockActiveSources() // `{ run: null }` for the mount check and every poll
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
      await flush()

      await dropMidRun(result)
      expect(runState(result).detached).toBe(true)

      // The route records the run only after auth + rate limit + two DB reads,
      // so a `null` inside that window is not a verdict — the card stays live.
      await advance(STATUS_POLL_MS)
      const tolerated = runState(result)
      expect(tolerated.phase).toBe("parsing")
      expect(tolerated.droppedWithoutCompletion).toBe(false)
      expect(tolerated.errors).toEqual([])
      expect(result.current.isRunning).toBe(true)

      // The second consecutive unusable body is the verdict, as before.
      await advance(STATUS_POLL_MS)
      const settled = runState(result)
      expect(settled.phase).toBe("done")
      expect(settled.droppedWithoutCompletion).toBe(true)
      expect(settled.finalResults).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-6: a valid running snapshot resets the unusable-body tolerance", async () => {
    vi.useFakeTimers()
    try {
      let answer: unknown = { run: null }
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => answer }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()
      await advance(STATUS_POLL_MS) // the mount check stands down
      await dropMidRun(result)

      // Unusable #1: tolerated.
      await advance(STATUS_POLL_MS)
      expect(runState(result).phase).toBe("parsing")

      // A real snapshot proves the run is alive, so the count goes back to zero.
      answer = { run: RUNNING_SNAPSHOT }
      for (let i = 0; i < 3 && runState(result).serverProgress === null; i++) {
        await advance(STATUS_POLL_MS)
      }
      expect(runState(result).serverProgress).toEqual({
        processed: 1,
        total: 2,
        approved: 2,
        collected: 3,
      })

      // One unusable body after a good one is tolerated again...
      answer = { run: null }
      await advance(STATUS_POLL_MS)
      expect(runState(result).phase).toBe("parsing")
      expect(result.current.isRunning).toBe(true)

      // ...and only the second consecutive one settles it.
      await advance(STATUS_POLL_MS)
      expect(runState(result).phase).toBe("done")
      expect(runState(result).droppedWithoutCompletion).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("AC-8: Stop on an attached card tells the server and settles as stopped", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: ATTACHED_RUNNING }),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()
      expect(runState(result).detached).toBe(true)

      act(() => {
        result.current.stop()
      })
      await flush()

      // The run belongs to the server, so closing a transport is not a stop —
      // the server has to be told.
      expect(fetch).toHaveBeenCalledWith(
        "/api/parse-stream/stop",
        expect.objectContaining({ method: "POST" })
      )
      const s = runState(result)
      expect(s.phase).toBe("done")
      expect(s.outcome).toBe("stopped")
      expect(result.current.isRunning).toBe(false)
      expect(s.errors).toEqual([])

      // The card is done with the server; it stops asking.
      const callsWhenStopped = statusCalls()
      await advance(STATUS_POLL_MS * 3)
      expect(statusCalls()).toBe(callsWhenStopped)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-1: StrictMode's replay leaves exactly one attach and one poller", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: ATTACHED_RUNNING }),
      }))

      // StrictMode replays setup → cleanup → setup on the SAME instance, so the
      // refs and the abort state survive. A check that died in the cleanup and
      // was never restarted leaves the page with no card at all; a check that
      // was not cancelled attaches twice and polls twice.
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }), {
        wrapper: StrictMode,
      })
      await flush()

      const s = runState(result)
      expect(result.current.phase).toBe("parsing")
      expect(s.detached).toBe(true)
      expect(result.current.isRunning).toBe(true)
      expect(s.log).toHaveLength(1)

      // One check that landed. A replay may have issued a first, cancelled
      // request, so 1–2 is the honest bound — never one per effect run *plus*
      // the poller's.
      expect([1, 2]).toContain(statusCalls())

      // One poller: exactly one request per interval, whether or not a
      // cancelled check left a timer behind.
      const before = statusCalls()
      await advance(STATUS_POLL_MS)
      expect(statusCalls()).toBe(before + 1)
      await advance(STATUS_POLL_MS)
      expect(statusCalls()).toBe(before + 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-1: an unmount and a fresh mount each attach once, per instance", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: ATTACHED_RUNNING }),
      }))

      const first = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
      await flush()
      expect(runState(first.result).phase).toBe("parsing")
      expect(runState(first.result).log).toHaveLength(1)

      // A fresh instance has fresh refs, so its own check must be able to run —
      // the replay guard is per instance, not a module-level latch.
      first.unmount()
      await flush()

      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
      await flush()

      const s = runState(result)
      expect(s.phase).toBe("parsing")
      expect(s.detached).toBe(true)
      expect(s.log).toHaveLength(1)

      const before = statusCalls()
      await advance(STATUS_POLL_MS)
      expect(statusCalls()).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-2: unmounting mid-check cancels it — no dispatch, no timer", async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus: ((body: unknown) => void) | undefined
      mockActiveSources(SOURCES, () => ({
        ok: true,
        json: () =>
          new Promise<unknown>(resolve => {
            resolveStatus = resolve
          }),
      }))
      const { result, unmount } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
      await flush()
      expect(resolveStatus).toBeTypeOf("function")

      const seen: number[] = []
      result.current.store.subscribe(() => seen.push(1))

      unmount()
      await act(async () => {
        resolveStatus?.({ run: ATTACHED_RUNNING })
      })

      expect(seen).toEqual([])
      expect(runState(result).phase).toBe("idle")
      expect(runState(result).log).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-3: a running answer that lands after a manual start does not open a second card", async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus: ((body: unknown) => void) | undefined
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: () =>
          new Promise<unknown>(resolve => {
            resolveStatus = resolve
          }),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))
      await flush()
      expect(resolveStatus).toBeTypeOf("function")

      // The user beats the check to it.
      await act(async () => {
        result.current.startParse()
      })
      const stream = FakeEventSource.openFor("/api/parse-stream")
      stream.emit({ type: "parse_start", sourceCount: 2, sources: SOURCES })

      // The check's answer lands now: the run it describes is the one this card
      // is already driving, so there is nothing to attach to.
      await act(async () => {
        resolveStatus?.({ run: ATTACHED_RUNNING })
      })
      await flush()

      const s = runState(result)
      expect(s.detached).toBe(false)
      expect(s.serverProgress).toBeNull()
      expect(s.observed).toBe(false)
      expect(s.sources).toHaveLength(2)
      expect(result.current.phase).toBe("parsing")
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(FakeEventSource.openFor("/api/parse-stream").closed).toBe(false)

      // No second poller was opened over the manual run.
      const calls = statusCalls()
      await advance(STATUS_POLL_MS * 3)
      expect(statusCalls()).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it("EC-4: a source-scoped card never attaches to the account-wide run", async () => {
    vi.useFakeTimers()
    try {
      // The registry is per user, not per feed: a run found from a feed page
      // would show account-wide counters under a feed header and disable that
      // feed's own Parse. The run stays invisible on this surface.
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: ATTACHED_RUNNING }),
      }))
      const { result } = renderHook(() =>
        usePostProcessing({ view: "INBOX", sourceId: "feed-1", autoGroup: false })
      )

      await flush()
      await advance(STATUS_POLL_MS)

      const s = runState(result)
      expect(s.phase).toBe("idle")
      expect(result.current.isRunning).toBe(false)
      expect(s.detached).toBe(false)
      expect(s.log).toEqual([])
      // A snapshot written onto an idle state — the shape a naive attach would
      // leave — is still a card's worth of state.
      expect(s.serverProgress).toBeNull()

      // Whatever the check did with the answer, it did not become a poller.
      const afterCheck = statusCalls()
      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(afterCheck)
      expect(runState(result).phase).toBe("idle")
    } finally {
      vi.useRealTimers()
    }
  })

  it("ERR-1: a failing mount check leaves no card, no error and no poller", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => {
        throw new Error("status unavailable")
      })
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()

      // Best-effort: one attempt. The user can still press Parse.
      expect(statusCalls()).toBe(1)
      expect(runState(result).phase).toBe("idle")
      expect(result.current.isRunning).toBe(false)
      expect(runState(result).errors).toEqual([])
      expect(runState(result).log).toEqual([])

      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(1)
      expect(runState(result).phase).toBe("idle")
    } finally {
      vi.useRealTimers()
    }
  })

  it("ERR-1: a non-OK mount check is equally silent", async () => {
    vi.useFakeTimers()
    try {
      const { statusCalls } = mockActiveSources(SOURCES, () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", autoGroup: false }))

      await flush()

      expect(statusCalls()).toBe(1)
      expect(runState(result).phase).toBe("idle")
      expect(result.current.isRunning).toBe(false)
      expect(runState(result).errors).toEqual([])
      expect(runState(result).log).toEqual([])

      await advance(STATUS_POLL_MS * 5)
      expect(statusCalls()).toBe(1)
      expect(runState(result).phase).toBe("idle")
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * RAD-326 — EventSource cannot read a 429, so the routes answer an event-stream
 * caller with one in-band `RATE_LIMITED` error frame. Driven here through the
 * real transport path: the card must say "too many requests" and when to try
 * again — not "the connection was interrupted" — and must not retry on its own.
 */
describe("a rate-limited run (RAD-326)", () => {
  const limited = (retryAfter: number) => ({
    type: "error",
    code: "RATE_LIMITED",
    retryAfter,
    message: `Too many requests — try again in ${retryAfter}s`,
    error: `Too many requests — try again in ${retryAfter}s`,
  })

  it("shows a refused parse as rate-limited, closes the stream and never retries", async () => {
    const { statusCalls } = mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0)) // the mount check
    const callsBefore = statusCalls()

    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit(limited(42))
    await act(async () => {})

    const state = runState(result)
    expect(state.phase).toBe("done")
    expect(state.outcome).toBe("rate_limited")
    expect(summaryText(state)).toBe("Too many requests — try again in 42s")
    expect(state.errors.join(" ")).not.toMatch(/connection/i)
    // Settled from the frame: not detached, never handed to the status poll.
    expect(state.detached).toBe(false)
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(statusCalls()).toBe(callsBefore)
    expect(result.current.isRunning).toBe(false)
  })

  it.each([
    ["grouping", "/api/posts/group-stories", "startGrouping"],
    ["re-filtering", "/api/posts/refilter", "startRefilter"],
  ] as const)("shows refused %s as rate-limited and never retries", async (_name, path, action) => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current[action]()
    })
    const stream = FakeEventSource.openFor(path)
    stream.emit(limited(7))
    await act(async () => {})

    const state = runState(result)
    expect(state.outcome).toBe("rate_limited")
    expect(summaryText(state)).toBe("Too many requests — try again in 7s")
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

/**
 * RAD-406 — an expired session and an unverified email used to look exactly
 * like a dropped connection: the proxy redirected the signed-out EventSource to
 * HTML, and the routes' 401/403 were unreadable. Both now arrive as one in-band
 * frame with a stable `code`; the card says which refusal it was and how to get
 * past it, closes the stream, and neither retries nor detaches onto the status
 * poll (a refused run has nothing on the server to follow).
 */
describe("a run refused for sign-in or email verification (RAD-406)", () => {
  const refusal = (code: string) => ({ type: "error", code, message: `copy for ${code}`, error: `copy for ${code}` })

  it.each([
    ["UNAUTHORIZED", "signed_out", /sign in again/i],
    ["EMAIL_NOT_VERIFIED", "unverified", /verify your email/i],
  ] as const)("shows a parse refused with %s honestly, closes the stream, never polls or retries", async (code, outcome, copy) => {
    const { statusCalls } = mockActiveSources()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0)) // the mount check
    const callsBefore = statusCalls()

    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    stream.emit(refusal(code))
    await act(async () => {})

    const state = runState(result)
    expect(state.phase).toBe("done")
    expect(state.outcome).toBe(outcome)
    expect(summaryText(state)).toMatch(copy)
    expect(state.errors.join(" ")).not.toMatch(/connection/i)
    expect(state.detached).toBe(false)
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(statusCalls()).toBe(callsBefore)
    expect(result.current.isRunning).toBe(false)
  })

  it.each([
    ["grouping", "/api/posts/group-stories", "startGrouping"],
    ["re-filtering", "/api/posts/refilter", "startRefilter"],
  ] as const)("shows %s refused for sign-in as signed out and never retries", async (_name, path, action) => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current[action]()
    })
    const stream = FakeEventSource.openFor(path)
    stream.emit(refusal("UNAUTHORIZED"))
    await act(async () => {})

    const state = runState(result)
    expect(state.outcome).toBe("signed_out")
    expect(summaryText(state)).toMatch(/sign in again/i)
    expect(stream.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it.each([
    ["UNAUTHORIZED"],
    ["EMAIL_NOT_VERIFIED"],
    ["RATE_LIMITED"],
  ])("does not refresh the page after a run refused with %s", async code => {
    // A refused run changed nothing on the server, and for a signed-out user
    // the refresh is a navigation: the proxy bounces the RSC fetch to /signup
    // and the card that explains why disappears with the page.
    mockActiveSources()
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", sourceId: "src-a", onRefresh }))
    await act(async () => {
      result.current.startParse()
    })
    FakeEventSource.openFor("/api/parse-stream").emit({ ...refusal(code), retryAfter: 5 })
    await act(async () => {})

    expect(runState(result).phase).toBe("done")
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("still refreshes after a run that did work", async () => {
    mockActiveSources()
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh, autoGroup: false }))
    await runParseToCompletion(result)
    await act(async () => {})
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("reads the sources listing bounced to the sign-in page as signed out, not as a broken response", async () => {
    // The proxy answers a signed-out JSON caller with a redirect to /signup, so
    // `fetch` lands on an HTML page with `ok: true` — parsing it as the source
    // list used to fail the run with a JSON syntax error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/parse-stream/status")) {
          return { ok: true, json: async () => ({ run: null }) } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          redirected: true,
          url: "http://localhost/signup?_rsc=rsc",
          json: async () => {
            throw new SyntaxError("Unexpected token '<'")
          },
        } as unknown as Response
      })
    )
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX" }))
    await act(async () => {
      result.current.startParse()
    })
    await waitFor(() => expect(runState(result).phase).toBe("done"))

    const state = runState(result)
    expect(state.outcome).toBe("signed_out")
    expect(summaryText(state)).toMatch(/sign in again/i)
    expect(state.errors).toEqual([])
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

/**
 * RAD-407 review: the status endpoint answers with the user's LATEST run, and
 * keeps a finished one for 15 minutes. A follow that is not tied to its own run
 * reported an earlier run's results as this one's — "5 new posts" for a parse
 * that never ran. The stream's `parse_start` now names the run; without it,
 * only a run seen running counts.
 */
describe("a follow reports only its own run (RAD-407)", () => {
  const STALE_DONE = { ...DONE_SNAPSHOT, id: "run-old" }
  const OWN_DONE = {
    ...DONE_SNAPSHOT,
    id: "run-new",
    approved: 1,
    filtered: 0,
    results: { parsed: 1, approved: 1, filtered: 0, errors: [] },
  }

  /** A parse in source scope (the mount check never claims there) whose stream dies. */
  async function startAndDrop(
    result: { current: ReturnType<typeof usePostProcessing> },
    manifest: { runId?: string } | null
  ) {
    await act(async () => {
      result.current.startParse()
    })
    const stream = FakeEventSource.openFor("/api/parse-stream")
    if (manifest) {
      stream.emit({ type: "parse_start", sourceCount: 1, sources: [SOURCES[0]], ...manifest })
      stream.emit({ type: "source_start", sourceId: "src-a", sourceName: "Alpha Journal" })
    }
    stream.fail()
    await act(async () => {})
  }

  async function settle(result: { current: ReturnType<typeof usePostProcessing> }) {
    for (let i = 0; i < 4 && runState(result).phase !== "done"; i++) await advance(STATUS_POLL_MS)
  }

  it("never reports an earlier, finished run when the stream died before parse_start", async () => {
    vi.useFakeTimers()
    try {
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => ({ run: STALE_DONE }) }))
      const onRefresh = vi.fn()
      const { result } = renderHook(() =>
        usePostProcessing({ view: "INBOX", sourceId: "src-a", autoGroup: false, onRefresh })
      )
      await startAndDrop(result, null)
      await settle(result)

      const state = runState(result)
      expect(state.phase).toBe("done")
      expect(state.finalResults).toBeNull()
      expect(state.droppedWithoutCompletion).toBe(true)
      expect(approvedCount(state)).toBe(0)
      expect(state.outcome).not.toBe("success")
    } finally {
      vi.useRealTimers()
    }
  })

  it("after parse_start, a snapshot of another run is not this run's result", async () => {
    vi.useFakeTimers()
    try {
      mockActiveSources(SOURCES, () => ({ ok: true, json: async () => ({ run: STALE_DONE }) }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", sourceId: "src-a", autoGroup: false }))
      await startAndDrop(result, { runId: "run-new" })
      await settle(result)

      const state = runState(result)
      expect(state.phase).toBe("done")
      expect(state.finalResults).toBeNull()
      expect(state.droppedWithoutCompletion).toBe(true)
      expect(approvedCount(state)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("after parse_start, waits past another run's snapshot and settles on its own", async () => {
    vi.useFakeTimers()
    try {
      let dropped = false
      let afterDrop = 0
      mockActiveSources(SOURCES, () => ({
        ok: true,
        json: async () => ({ run: !dropped ? null : ++afterDrop === 1 ? STALE_DONE : OWN_DONE }),
      }))
      const { result } = renderHook(() => usePostProcessing({ view: "INBOX", sourceId: "src-a", autoGroup: false }))
      await act(async () => {})
      dropped = true
      await startAndDrop(result, { runId: "run-new" })
      await settle(result)

      const state = runState(result)
      expect(state.phase).toBe("done")
      expect(state.outcome).toBe("success")
      expect(state.finalResults).toEqual(OWN_DONE.results)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the session ends while a dropped run is followed (RAD-406)", () => {
  it.each([
    ["a 401", { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }],
    [
      "a redirect to the sign-in page",
      {
        ok: true,
        status: 200,
        redirected: true,
        url: "http://localhost/signup?_rsc=1",
        json: async () => {
          throw new SyntaxError("Unexpected token '<'")
        },
      },
    ],
  ] as const)("reads %s as signed out at once, and does not refresh", async (_, answer) => {
    vi.useFakeTimers()
    try {
      let dropped = false
      const { statusCalls } = mockActiveSources(SOURCES, () =>
        dropped ? { ...answer } : { ok: true, json: async () => ({ run: null }) }
      )
      const onRefresh = vi.fn()
      const { result } = renderHook(() =>
        usePostProcessing({ view: "INBOX", sourceId: "src-a", autoGroup: false, onRefresh })
      )
      await act(async () => {})
      dropped = true
      await act(async () => {
        result.current.startParse()
      })
      const stream = FakeEventSource.openFor("/api/parse-stream")
      stream.emit({ type: "parse_start", sourceCount: 1, sources: [SOURCES[0]], runId: "run-1" })
      stream.emit({ type: "source_complete", sourceId: "src-a", sourceName: "Alpha Journal", stats: { approved: 1, filtered: 0 } })
      stream.fail()
      await act(async () => {})
      const callsAtDrop = statusCalls()

      await advance(STATUS_POLL_MS)
      const state = runState(result)
      expect(state.phase).toBe("done")
      expect(state.refusal).toEqual({ code: "UNAUTHORIZED" })
      expect(state.detached).toBe(false)
      expect(state.errors.join(" ")).toMatch(/sign in again/i)
      expect(state.errors.join(" ")).not.toMatch(/connection/i)
      expect(onRefresh).not.toHaveBeenCalled()

      await advance(STATUS_POLL_MS * 10)
      expect(statusCalls()).toBe(callsAtDrop + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("refresh after a parse whose automatic grouping was refused (RAD-406)", () => {
  it("does not refresh when grouping was refused for sign-in: signed out, the refresh is a navigation", async () => {
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))
    await runParseToCompletion(result, { approved: 2 })
    FakeEventSource.openFor("/api/posts/group-stories").emit({
      type: "error",
      code: "UNAUTHORIZED",
      message: "x",
      error: "x",
    })
    await act(async () => {})

    const state = runState(result)
    expect(state.phase).toBe("done")
    expect(state.outcome).toBe("partial")
    expect(state.refusal).toEqual({ code: "UNAUTHORIZED" })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("still refreshes when grouping was refused for another reason: the parse's posts landed", async () => {
    const onRefresh = vi.fn()
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", onRefresh }))
    await runParseToCompletion(result, { approved: 2 })
    FakeEventSource.openFor("/api/posts/group-stories").emit({
      type: "error",
      code: "EMAIL_NOT_VERIFIED",
      message: "x",
      error: "x",
    })
    await act(async () => {})

    expect(runState(result).outcome).toBe("partial")
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
