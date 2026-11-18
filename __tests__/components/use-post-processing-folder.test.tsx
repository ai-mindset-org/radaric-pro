/** @vitest-environment jsdom */

/**
 * RAD-393 — folder scope in the processing controller.
 *
 * Run Parsing parses exactly the folder's member sources (never the account
 * list), the grouping/refilter streams carry `?folderId=`, and a folder-scoped
 * card never claims an account-wide run from the server registry (the RAD-347
 * EC-4 hazard, one scope over).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { usePostProcessing } from "@/components/materials/use-post-processing"

class FakeEventSource {
  static instances: FakeEventSource[] = []
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

  static openFor(pattern: string): FakeEventSource {
    const match = [...FakeEventSource.instances].reverse().find(i => i.url.includes(pattern) && !i.closed)
    if (!match) throw new Error(`no open stream for "${pattern}"`)
    return match
  }
}

type StatusResponder = () => { ok: boolean; json: () => Promise<unknown> }

const idleStatus: StatusResponder = () => ({ ok: true, json: async () => ({ run: null }) })

function mockFetch(status: StatusResponder = idleStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/parse-stream/stop")) return { ok: true, json: async () => ({}) }
      if (url.includes("/api/parse-stream/status")) return status()
      return { ok: true, json: async () => [] }
    })
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  mockFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("RAD-393: folder-scoped processing", () => {
  it("parses exactly the folder's member sources, without listing the account", async () => {
    const { result } = renderHook(() =>
      usePostProcessing({ view: "INBOX", folderId: "folder-1", folderSourceIds: ["src-a", "src-b"] })
    )

    await act(async () => {
      result.current.startParse()
    })

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input))
    expect(urls).not.toContain("/api/feeds?active=true")
    expect(FakeEventSource.openFor("/api/parse-stream").url).toContain("sourceIds=src-a,src-b")
  })

  it("carries folderId on the grouping stream", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", folderId: "folder-1" }))

    await act(async () => {
      result.current.startGrouping()
    })

    expect(FakeEventSource.openFor("/api/posts/group-stories").url).toContain("folderId=folder-1")
  })

  it("carries folderId on the refilter stream", async () => {
    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", folderId: "folder-1" }))

    await act(async () => {
      result.current.startRefilter()
    })

    expect(FakeEventSource.openFor("/api/posts/refilter").url).toContain("folderId=folder-1")
  })

  it("does not claim an account-wide run while folder-scoped", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        run: { status: "running", processed: 1, total: 5, approved: 1, filtered: 2 },
      }),
    }))

    const { result } = renderHook(() => usePostProcessing({ view: "INBOX", folderId: "folder-1" }))

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/parse-stream/status"))
      ).toBe(true)
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(result.current.store.getSnapshot().phase).toBe("idle")
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})
