/** @vitest-environment jsdom */

/**
 * RAD-424 — the last run's result stays on the freshness line until the next
 * run, per scope, and the page renders without storage.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for DOM globals and SSE payloads */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock("@/components/materials/material-card", () => ({
  MaterialCard: ({ material }: any) => <div data-testid="material-card">{material.title}</div>,
}))

import { MaterialsList } from "@/components/materials/materials-list"
import type { FreshnessProps } from "@/lib/materials/source-freshness"

// The line is hidden in the product (FRESHNESS_LINE_VISIBLE = false); these tests
// keep the recorder and copy covered for when it comes back.
vi.mock("@/lib/materials/source-freshness", async orig => ({
  ...(await orig<typeof import("@/lib/materials/source-freshness")>()),
  FRESHNESS_LINE_VISIBLE: true,
}))

class FakeEventSource {
  static instances: FakeEventSource[] = []
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
  async emit(payload: unknown) {
    await act(async () => {
      this.onmessage?.({ data: JSON.stringify(payload) })
    })
  }
}

const freshness: FreshnessProps = {
  checkedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  inactiveCheckedAt: null,
  activeCount: 2,
  neverCount: 0,
  failedCount: 0,
  pausedCount: 0,
}

// What the refreshed server value looks like right after a run.
const justChecked: FreshnessProps = { ...freshness, checkedAt: new Date().toISOString() }

function renderList(props: Record<string, unknown> = {}) {
  return render(
    <MaterialsList
      initialMaterials={[]}
      totalCount={0}
      serverCounts={{ filter: { INBOX: 0, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 0 } }}
      freshness={freshness}
      {...props}
    />
  )
}

async function runParse(user: ReturnType<typeof userEvent.setup>, stats: { approved: number; filtered: number }) {
  await user.click(screen.getAllByRole("button", { name: /run\s*parsing/i }).find(b => b.getAttribute("aria-label") === "Run parsing")!)
  await waitFor(() => expect(FakeEventSource.instances.some(i => i.url.includes("/api/parse-stream"))).toBe(true))
  const stream = FakeEventSource.instances.find(i => i.url.includes("/api/parse-stream"))!
  await stream.emit({ type: "source_complete", sourceName: "Source A", stats })
  await stream.emit({ type: "parse_complete", results: { ...stats, errors: [] } })
  await waitFor(() => expect(stream.closed).toBe(true))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as any)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input)
      if (url.startsWith("/api/feeds?active=true")) return { ok: true, json: async () => [{ id: "feed-a", name: "Source A" }] }
      return { ok: true, json: async () => ({ materials: [], total: 0 }) }
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("MaterialsList — last run on the freshness line", () => {
  it("shows the server value before any run", async () => {
    renderList()
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent("Checked 1 h ago")
  })

  it("replaces it with the run's new-post count and stores it for the scope", async () => {
    const user = userEvent.setup()
    renderList({ feedId: "feed-a", freshness: justChecked })
    await screen.findByTestId("source-freshness")

    await runParse(user, { approved: 2, filtered: 3 })

    await waitFor(() => expect(screen.getByTestId("source-freshness")).toHaveTextContent("5 new posts · checked just now"))
    const stored = JSON.parse(localStorage.getItem("radaric:last-run:feed:feed-a")!)
    expect(stored.newPosts).toBe(5)
    expect(localStorage.getItem("radaric:last-run:all")).toBeNull()
  })

  it("says no new posts when the run found nothing", async () => {
    const user = userEvent.setup()
    renderList({ freshness: justChecked })
    await screen.findByTestId("source-freshness")
    await runParse(user, { approved: 0, filtered: 0 })
    await waitFor(() => expect(screen.getByTestId("source-freshness")).toHaveTextContent("No new posts · checked just now"))
    expect(localStorage.getItem("radaric:last-run:all")).not.toBeNull()
  })

  it("restores the stored result on the next visit, keyed by scope", async () => {
    localStorage.setItem("radaric:last-run:folder:f1", JSON.stringify({ at: new Date().toISOString(), newPosts: 1 }))
    renderList({ folderId: "f1", folderSourceIds: ["feed-a"], freshness: justChecked })
    await waitFor(() => expect(screen.getByTestId("source-freshness")).toHaveTextContent("1 new post · checked just now"))
  })

  it("ignores a corrupt stored value and still renders", async () => {
    localStorage.setItem("radaric:last-run:all", "{not json")
    renderList()
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent("Checked 1 h ago")
  })

  it("renders when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    renderList()
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent("Checked 1 h ago")
    vi.restoreAllMocks()
  })

  it("ignores a stored run the server does not corroborate (it may have covered one feed)", async () => {
    localStorage.setItem("radaric:last-run:all", JSON.stringify({ at: new Date().toISOString(), newPosts: 7 }))
    renderList() // server says the scope was last checked an hour ago
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent("Checked 1 h ago")
    expect(screen.getByTestId("source-freshness")).not.toHaveTextContent("new post")
  })

  it("does not record a run with nothing to read", async () => {
    const user = userEvent.setup()
    renderList({ freshness: justChecked })
    await screen.findByTestId("source-freshness")
    await user.click(screen.getAllByRole("button", { name: /run\s*parsing/i }).find(b => b.getAttribute("aria-label") === "Run parsing")!)
    await waitFor(() => expect(FakeEventSource.instances.some(i => i.url.includes("/api/parse-stream"))).toBe(true))
    const stream = FakeEventSource.instances.find(i => i.url.includes("/api/parse-stream"))!
    await stream.emit({ type: "parse_start", sourceCount: 0, sources: [] })
    await stream.emit({ type: "parse_complete", results: { parsed: 0, evaluated: 0, approved: 0, filtered: 0, errors: [] } })
    await waitFor(() => expect(stream.closed).toBe(true))
    expect(localStorage.getItem("radaric:last-run:all")).toBeNull()
  })

  it("does not record again when the finished card is dismissed later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const user = userEvent.setup()
      renderList({ freshness: justChecked })
      await screen.findByTestId("source-freshness")
      await runParse(user, { approved: 1, filtered: 0 })
      await waitFor(() => expect(localStorage.getItem("radaric:last-run:all")).not.toBeNull())
      const recorded = localStorage.getItem("radaric:last-run:all")

      // Forty minutes pass with the finished card still on screen.
      vi.setSystemTime(new Date(Date.now() + 40 * 60_000))
      await user.click(await screen.findByRole("button", { name: "Dismiss" }))
      await waitFor(() => expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull())

      expect(localStorage.getItem("radaric:last-run:all")).toBe(recorded)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not record a run this card only watched (it may have covered other sources)", async () => {
    let statusCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input)
        if (url.includes("/api/parse-stream/status")) {
          statusCalls++
          const done = statusCalls > 1
          return {
            ok: true,
            json: async () => ({
              run: {
                id: "run-elsewhere",
                startedAt: 1,
                finishedAt: done ? 9 : null,
                status: done ? "done" : "running",
                total: 1,
                processed: done ? 1 : 0,
                approved: done ? 2 : 0,
                filtered: 0,
                results: done ? { approved: 2, filtered: 0, errors: [] } : null,
              },
            }),
          }
        }
        if (url.startsWith("/api/feeds?active=true")) return { ok: true, json: async () => [{ id: "feed-a", name: "A" }] }
        return { ok: true, json: async () => ({ materials: [], total: 0 }) }
      })
    )
    renderList({ freshness: justChecked })
    // The card attaches to the other run, then the poll settles it (4 s cadence).
    await waitFor(() => expect(screen.getByTestId("processing-card")).toBeTruthy())
    await waitFor(() => expect(statusCalls).toBeGreaterThan(1), { timeout: 8000 })
    await waitFor(() => expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy(), { timeout: 8000 })
    expect(localStorage.getItem("radaric:last-run:all")).toBeNull()
  }, 20000)
})
