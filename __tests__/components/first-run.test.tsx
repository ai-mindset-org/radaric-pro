/** @vitest-environment jsdom */

/**
 * RAD-318 Phase 5 — the automatic first parse, and BUG-12's silent failure.
 *
 * Two histories meet in this file.
 *
 * BUG-12 (AC-1, AC-2): the first run used to be able to produce no feedback at
 * all — thirty polls returning nothing, or a failed POST, and the user was told
 * neither. Those cases are user-visible behaviour and survive the transport
 * change; they are asserted here against the module that now owns them.
 *
 * RAD-318: the run is server-owned and the card only observes it. A new user
 * who clicks the sidebar five seconds in must keep their ingestion *and* keep
 * their eligibility for a retry if it really was lost — the old code wrote the
 * onboarding flag at kickoff, so a run killed mid-flight left them permanently
 * ineligible, looking at an empty Posts screen. Every test here renders in
 * StrictMode, which nothing in this repository did before: the ref guard that
 * was supposed to prevent a double start had never been exercised under
 * double-invocation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, act, waitFor, cleanup } from "@testing-library/react"
import { StrictMode } from "react"
import { toast } from "sonner"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("@/components/materials/material-card", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  MaterialCard: ({ material }: any) => <div data-testid="material-card">{material.title}</div>,
}))

import { MaterialsList } from "@/components/materials/materials-list"
import { reportFirstResults, STILL_PROCESSING_MESSAGE } from "@/lib/materials/first-run"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
}

/** Resolves only when the test says so — a parse the server is still running. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let fetchMock: ReturnType<typeof vi.fn>
const parseCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/parse")
const settingsCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/user-settings")

beforeEach(() => {
  sessionStorage.clear()
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderFirstVisit(sourceCount = 5) {
  return render(
    <StrictMode>
      <MaterialsList
        initialMaterials={[]}
        totalCount={0}
        serverCounts={{ filter: { INBOX: 0, APPROVED: 0, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 0 } }}
        firstRunSourceCount={sourceCount}
      />
    </StrictMode>
  )
}

describe("the run starts once, and the server owns it", () => {
  it("sends exactly one POST /api/parse under StrictMode's double mount", async () => {
    const parse = deferred()
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    expect(parseCalls()).toHaveLength(1)
  })

  it("shows the run on the processing card without inventing progress", async () => {
    const parse = deferred()
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit(5)
    await act(async () => {})

    expect(await screen.findByTestId("processing-card")).toBeInTheDocument()
    expect(screen.getByText(/collecting posts from 5 sources/i)).toBeInTheDocument()
    // No per-source frames exist for an observed run, so no bar claims a ratio.
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("opens no SSE stream — the card watches, it does not drive", async () => {
    const parse = deferred()
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it("does not start when there are no active sources", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit(0)
    await act(async () => {})

    expect(parseCalls()).toHaveLength(0)
    expect(screen.queryByTestId("processing-card")).toBeNull()
  })
})

describe("onboarding eligibility", () => {
  it("is not spent at kickoff — only once the server has answered", async () => {
    const parse = deferred()
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    // Mid-run: the flag must still be unset, or a user who navigates away now
    // is permanently ineligible for the retry.
    expect(settingsCalls()).toHaveLength(0)

    await act(async () => {
      parse.resolve()
    })

    await waitFor(() => expect(settingsCalls()).toHaveLength(1))
    expect(JSON.parse(String(settingsCalls()[0][1]?.body))).toEqual({ onboardingBannerDismissed: true })
  })

  it("survives navigation away mid-run: nothing client-side can abort the run", async () => {
    const parse = deferred()
    const fetches: { url: string; signal: AbortSignal | undefined }[] = []
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      fetches.push({ url: String(url), signal: init?.signal ?? undefined })
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = renderFirstVisit()
    await act(async () => {})
    unmount()

    // Nothing client-side can stop it: the request that owns the run carries no
    // abort signal. Scoped to `/api/parse` — RAD-347's mount check attaches one
    // to its own status request, which is not the run.
    expect(fetches.filter(f => f.url === "/api/parse").map(f => f.signal)).toEqual([undefined])

    await act(async () => {
      parse.resolve()
    })

    // The server finished it, so onboarding is complete even though nobody was
    // watching — the ingestion the user navigated away from is theirs.
    await waitFor(() => expect(settingsCalls()).toHaveLength(1))
  })

  it("leaves eligibility intact when the server answers, but answers no", async () => {
    // A 402 from the paywall, a 401, a 500 — all answers, none of them a run.
    // Treating "the server responded" as success would spend the one-shot
    // retry on a run that never happened and report an empty success on a
    // screen with no posts: the same bug as writing the flag at kickoff,
    // moved from "too early" to "on failure".
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") {
        return { ok: false, status: 402, json: async () => ({ error: "Subscription required" }) }
      }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/could not/i))
    expect(screen.getByText(/subscription required/i)).toBeInTheDocument()
    expect(settingsCalls()).toHaveLength(0)
  })

  it("names the failure generically when the body carries no reason", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    await waitFor(() => expect(screen.getByText(/could not start collecting your posts/i)).toBeInTheDocument())
    expect(settingsCalls()).toHaveLength(0)
  })

  it("leaves eligibility intact when the request itself fails", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") throw new Error("Network error")
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    // AC-2: the user is told, rather than left looking at nothing.
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(STILL_PROCESSING_MESSAGE))
    expect(settingsCalls()).toHaveLength(0)
    expect(await screen.findByText(STILL_PROCESSING_MESSAGE)).toBeInTheDocument()
  })
})

describe("a manual run and the automatic one cannot overlap", () => {
  it("occupies the card with the observed run, so no manual run can be started over it", async () => {
    const parse = deferred()
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/parse") return parse.promise.then(() => ({ ok: true, json: async () => ({}) }))
      if (String(url).startsWith("/api/feeds?active=true")) {
        return { ok: true, json: async () => [{ id: "feed-a", name: "Alpha" }] }
      }
      return { ok: true, json: async () => ({ materials: [], total: 0 }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    renderFirstVisit()
    await act(async () => {})

    // The primary's accessible name follows the phase, and it is disabled
    // because the observed run owns the card. There is deliberately no click
    // here: clicking a disabled button dispatches nothing, so it would assert
    // the mock's silence rather than the guard. The race the guard actually
    // protects — a manual start landing before the automatic kickoff's
    // microtask — is driven at the hook level, in use-post-processing.test.tsx.
    const primary = screen.getByRole("button", { name: "Parsing…" })
    expect(primary).toBeDisabled()

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(parseCalls()).toHaveLength(1)
  })
})

describe("BUG-12: the silent first run", () => {
  it("AC-1: says so after thirty polls return nothing", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ materials: { total: 0, approved: 0 } }) }))
    vi.stubGlobal("fetch", fetchMock)

    // Injected clock: the real one would make this a five-minute test.
    await reportFirstResults(async () => {})

    expect(toast.info).toHaveBeenCalledWith(STILL_PROCESSING_MESSAGE)
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/stats")).toHaveLength(30)
  })

  it("reports the first results as soon as posts exist, and stops polling", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ materials: { total: 12, approved: 5 } }) }))
    vi.stubGlobal("fetch", fetchMock)

    await reportFirstResults(async () => {})

    expect(toast.success).toHaveBeenCalledWith(
      "First results: 12 posts found, 5 matched your interests.",
      expect.anything()
    )
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/stats")).toHaveLength(1)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it("keeps polling through a failed stats read rather than treating it as a verdict", async () => {
    let calls = 0
    fetchMock = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error("offline")
      return { ok: true, json: async () => ({ materials: { total: 4, approved: 1 } }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    await reportFirstResults(async () => {})

    expect(calls).toBe(3)
    expect(toast.success).toHaveBeenCalled()
  })
})
