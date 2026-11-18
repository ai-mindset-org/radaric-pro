/**
 * @vitest-environment jsdom
 */

/**
 * RAD-318 Phase 1a — the regression net that did not exist.
 *
 * `components/materials/materials-list.tsx` is ~1780 lines and, before this
 * file and the RAD-317 tests, was rendered by zero of the repository's vitest
 * files. The posts redesign restructures its toolbar, its processing feedback
 * and its query paths, so these tests pin the behaviour that must survive that
 * restructuring. They were written as *characterization* against the old
 * component; three of them pinned defects the rework fixes, and those
 * assertions were flipped when it did — the behaviour they describe is the
 * behaviour, not a snapshot.
 *
 * jsdom has no EventSource, so one is installed here. The fake is the only
 * honest way to drive the SSE lifecycle: the real client opens the stream
 * inside `parseAllFeeds` and never exposes it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for DOM globals and SSE payloads */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

vi.mock("@/components/materials/material-card", () => ({
  MaterialCard: ({ material }: any) => <div data-testid="material-card">{material.title}</div>,
}))

import { MaterialsList } from "@/components/materials/materials-list"

// ---------------------------------------------------------------- EventSource

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static openFor(pattern: string) {
    return FakeEventSource.instances.filter(i => i.url.includes(pattern))
  }

  url: string
  closed = false
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  /** Deliver one server event, wrapped in act() so React flushes it. */
  async emit(payload: unknown) {
    await act(async () => {
      this.onmessage?.({ data: JSON.stringify(payload) })
    })
  }

  async fail() {
    await act(async () => {
      this.onerror?.()
    })
  }
}

// -------------------------------------------------------------------- fixture

function material(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Post ${id}`,
    url: `https://example.com/${id}`,
    content: "body",
    contentEntities: null,
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED",
    aiConfidence: 0.9,
    aiReasoning: null,
    userStatus: "NEW",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    storyId: null,
    story: null,
    feed: { id: "feed-a", name: "Source A", type: "RSS" },
    ...over,
  } as any
}

const SOURCES = [
  { id: "feed-a", name: "Source A" },
  { id: "feed-b", name: "Source B" },
]

let fetchMock: ReturnType<typeof vi.fn>

function stubFetch() {
  fetchMock = vi.fn(async (input: any) => {
    const url = String(input)
    if (url.startsWith("/api/feeds?active=true")) {
      return { ok: true, json: async () => SOURCES }
    }
    return { ok: true, json: async () => ({ materials: [], total: 0 }) }
  })
  vi.stubGlobal("fetch", fetchMock)
}

beforeEach(() => {
  sessionStorage.clear()
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as any)
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderPostsView() {
  return render(
    <MaterialsList
      initialMaterials={[material("m1"), material("m2")]}
      totalCount={2}
      serverCounts={{
        filter: { INBOX: 2, APPROVED: 2, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 2 },
      }}
    />
  )
}

/** Click Run parsing and wait until the stream is open. */
async function startRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /run\s*parsing/i }))
  await waitFor(() => expect(FakeEventSource.openFor("/api/parse-stream").length).toBe(1))
  return FakeEventSource.openFor("/api/parse-stream")[0]
}

// ----------------------------------------------------------------------------

describe("MaterialsList characterization — parse run over SSE", () => {
  it("opens one stream for the active sources and reports progress to completion", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)

    // The denominator today comes from a separate /api/feeds call, not from the
    // stream itself — RAD-318 replaces this with a `parse_start` manifest.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/feeds?active=true"))).toBe(true)
    expect(stream.url).toContain("sourceIds=feed-a,feed-b")

    await stream.emit({ type: "source_start", sourceName: "Source A" })
    await stream.emit({ type: "items_fetched", count: 4 })
    await stream.emit({
      type: "material_created",
      material: material("new-1", { title: "Streamed post" }),
      progress: { current: 1, total: 4 },
    })
    await stream.emit({ type: "source_complete", sourceName: "Source A", stats: { approved: 1, filtered: 0 } })

    // A streamed material reaches the grid before the run finishes.
    expect(await screen.findByText("Streamed post")).toBeTruthy()

    await stream.emit({ type: "parse_complete", results: { errors: [] } })

    // parse_complete settles the run: the client closes the stream itself.
    await waitFor(() => expect(stream.closed).toBe(true))
  })

  it("auto-starts story grouping when the run approved anything", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "source_complete", sourceName: "Source A", stats: { approved: 2, filtered: 0 } })
    await stream.emit({ type: "parse_complete", results: { errors: [] } })

    // Grouping is a *second* stream opened after the parse promise resolves.
    await waitFor(() => expect(FakeEventSource.openFor("/api/posts/group-stories").length).toBe(1))
    const group = FakeEventSource.openFor("/api/posts/group-stories")[0]

    await group.emit({ type: "start", total: 2 })
    await group.emit({ type: "complete", storiesCreated: 1, storiesUpdated: 0 })
    await waitFor(() => expect(group.closed).toBe(true))
  })

  it("does not start grouping when nothing was approved", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "source_complete", sourceName: "Source A", stats: { approved: 0, filtered: 3 } })
    await stream.emit({ type: "parse_complete", results: { errors: [] } })

    await waitFor(() => expect(stream.closed).toBe(true))
    expect(FakeEventSource.openFor("/api/posts/group-stories").length).toBe(0)
  })

  it("surfaces run errors reported in parse_complete", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "parse_complete", results: { errors: ["Source B: fetch failed"] } })

    expect(await screen.findByText(/Source B: fetch failed/)).toBeTruthy()
  })

  it("ignores a second start while a run is active", async () => {
    const user = userEvent.setup()
    renderPostsView()

    await startRun(user)
    // The primary is disabled for the duration of the run, so a second click
    // cannot open a second stream.
    const primary = screen.getAllByRole("button").find(b => /parsing/i.test(b.textContent || ""))!
    expect(primary.hasAttribute("disabled")).toBe(true)
    await user.click(primary)
    expect(FakeEventSource.openFor("/api/parse-stream").length).toBe(1)
  })

  it("stop closes the transport and returns the toolbar to idle", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "source_start", sourceName: "Source A" })

    await user.click(screen.getByRole("button", { name: /stop/i }))

    expect(stream.closed).toBe(true)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run\s*parsing/i }).hasAttribute("disabled")).toBe(false)
    )
  })

  it("shows a run-level error payload instead of saying nothing", async () => {
    // app/api/parse-stream/route.ts sends {type:"error", error:"Subscription required"}
    // for run-level failures (:283, :310) while source-level errors send
    // {type:"error", message} (:509). The old client read data.message only, so
    // a Lite user hitting the Twitter gate was told nothing at all. The reducer
    // normalizes both shapes and the card renders the reason.
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "error", error: "Subscription required" })

    expect(await screen.findByText(/Subscription required/)).toBeTruthy()
  })

  it("names the toolbar controls the way they read", async () => {
    // `<span class="hidden sm:inline">Run </span>Parsing` computed to
    // "RunParsing" — the accname algorithm trims each text node before joining,
    // so a screen reader was told a word that does not exist. The controls now
    // carry explicit labels.
    const { computeAccessibleName } = await import("dom-accessibility-api")
    renderPostsView()

    const names = screen.getAllByRole("button").map(b => computeAccessibleName(b))
    expect(names).toContain("Run parsing")
    expect(names).not.toContain("RunParsing")
    expect(names).not.toContain("AIRules")
  })

  it("renders the initial materials without fetching", async () => {
    renderPostsView()
    expect(screen.getAllByTestId("material-card").length).toBe(2)
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/posts?")).length).toBe(0)
  })

  it("keeps streamed posts on screen through completion", async () => {
    // handleParse used to end with setStreamedMaterials([]) + router.refresh(),
    // so the grid emptied of streamed posts and only refilled when the server
    // component re-rendered — a blank flash at the moment the run succeeded.
    // They now stay, deduplicated by id, until authoritative data arrives.
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({
      type: "material_created",
      material: material("new-9", { title: "Streamed and kept" }),
      progress: { current: 1, total: 1 },
    })
    expect(await screen.findByText("Streamed and kept")).toBeTruthy()

    await stream.emit({ type: "source_complete", sourceName: "Source A", stats: { approved: 0, filtered: 1 } })
    await stream.emit({ type: "parse_complete", results: { errors: [] } })

    await waitFor(() => expect(stream.closed).toBe(true))
    expect(screen.getByText("Streamed and kept")).toBeTruthy()
  })

})

describe("MaterialsList — dismissing the processing card", () => {
  it("returns focus to Run parsing rather than dropping it on the document", async () => {
    const user = userEvent.setup()
    renderPostsView()

    const stream = await startRun(user)
    await stream.emit({ type: "parse_complete", results: { errors: [] } })

    // The terminal card is still a grid cell, and the card itself has taken
    // focus onto its heading.
    const dismiss = await screen.findByRole("button", { name: /dismiss/i })
    await user.click(dismiss)

    // Dismiss removes the cell. Without an explicit handoff the browser drops
    // focus to `body` and a keyboard user loses their position on the page.
    await waitFor(() => expect(screen.queryByTestId("processing-card")).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run parsing" }))
  })
})

describe("MaterialsList — the empty view under a live run", () => {
  /**
   * A first run over an account with nothing in it showed both halves of the
   * contradiction at once: the processing card collecting posts, and directly
   * below it an empty state telling the user to "run parsing" under a disabled
   * "Parsing..." button — with two "Run parsing" controls on screen. The card
   * is the screen's guidance while a run is live; the empty state is guidance
   * for a screen with nothing happening on it.
   */
  function renderEmptyView() {
    return render(
      <MaterialsList
        initialMaterials={[]}
        totalCount={0}
        serverCounts={{
          filter: { INBOX: 0, APPROVED: 0, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 0 },
        }}
      />
    )
  }

  it("takes 'No posts' down while the run is live, and restores it once it settles", async () => {
    const user = userEvent.setup()
    renderEmptyView()

    // With nothing on screen the empty state is the guidance.
    expect(screen.getByText("No posts")).toBeTruthy()

    // The toolbar's control, not the empty state's twin: before the run both
    // are named "Run parsing".
    const toolbarRun = screen
      .getAllByRole("button", { name: /run\s*parsing/i })
      .find(button => button.getAttribute("aria-label") === "Run parsing")
    expect(toolbarRun, "the toolbar's Run parsing control is on screen").toBeTruthy()
    await user.click(toolbarRun!)
    await waitFor(() => expect(FakeEventSource.openFor("/api/parse-stream").length).toBe(1))
    const stream = FakeEventSource.openFor("/api/parse-stream")[0]

    expect(screen.queryByText("No posts")).toBeNull()
    // The card took its place: the run is reported, not a blank screen.
    expect(screen.getByTestId("processing-card")).toBeTruthy()

    await stream.emit({ type: "parse_complete", results: { errors: [] } })
    await waitFor(() => expect(stream.closed).toBe(true))

    // Settled and still empty: the guidance is honest again.
    expect(await screen.findByText("No posts")).toBeTruthy()
  })
})

describe("MaterialsList — what an older version left in sessionStorage", () => {
  /**
   * Acceptance matrix, "persisted legacy view/type". Every value here was
   * written by a shipped version of this app and is still sitting in real
   * users' browsers. Normalization happens after mount, deliberately — reading
   * storage in a `useState` initializer made the first client render differ
   * from the server and triggered React #418, which could blank the list on
   * iOS Safari.
   */
  it("folds a stored APPROVED view into Inbox instead of selecting a view the menu cannot check", async () => {
    sessionStorage.setItem("radaric-materials-filter", "APPROVED")
    renderPostsView()

    // The heading is the view trigger; APPROVED must not survive as its own view.
    expect(await screen.findByRole("button", { name: /inbox/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approved/i })).toBeNull()
    // And it is rewritten, so the next visit does not re-normalize.
    await waitFor(() => expect(sessionStorage.getItem("radaric-materials-filter")).toBe("INBOX"))
  })

  it("migrates the legacy INTEREST source type to EVENT_TRIGGER", async () => {
    sessionStorage.setItem("radaric-materials-source-type", JSON.stringify(["INTEREST"]))
    renderPostsView()

    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem("radaric-materials-source-type")!)).toEqual(["EVENT_TRIGGER"])
    )
  })

  it("falls back to all types when the stored selection is empty or unrecognisable", async () => {
    sessionStorage.setItem("radaric-materials-source-type", JSON.stringify(["PODCAST", "MASTODON"]))
    const { unmount } = renderPostsView()

    // An unknown type is not a filter — it is a selection that matches nothing,
    // which would present as an inexplicably empty grid.
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem("radaric-materials-source-type")!)).toEqual(["ALL"])
    )
    expect(screen.getByRole("button", { name: /all types/i })).toBeTruthy()

    unmount()
    sessionStorage.setItem("radaric-materials-source-type", JSON.stringify([]))
    renderPostsView()
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem("radaric-materials-source-type")!)).toEqual(["ALL"])
    )
  })

  it("survives storage that is not JSON at all, without losing the screen", async () => {
    // The pre-array format was a bare string.
    sessionStorage.setItem("radaric-materials-source-type", "TELEGRAM")
    renderPostsView()

    expect(await screen.findByRole("button", { name: /telegram/i })).toBeTruthy()
  })

  it("does not inherit a /posts type filter on a source page", async () => {
    sessionStorage.setItem("radaric-materials-source-type", JSON.stringify(["TELEGRAM"]))
    render(
      <MaterialsList
        initialMaterials={[material("m1")]}
        totalCount={1}
        serverCounts={{
          filter: { INBOX: 1, APPROVED: 1, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 1 },
        }}
        feedId="feed-a"
        hideSourceTypeFilter
        title="Source A"
      />
    )

    // An RSS source inheriting a Telegram filter from /posts would show an
    // empty list with no visible control to explain it — the control is hidden
    // here by design.
    expect(await screen.findByTestId("material-card")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /telegram|all types/i })).toBeNull()
    // And the source page must not write its forced ["ALL"] back over the
    // account-wide choice.
    expect(JSON.parse(sessionStorage.getItem("radaric-materials-source-type")!)).toEqual(["TELEGRAM"])
  })
})
