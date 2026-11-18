/** @vitest-environment jsdom */

/**
 * RAD-343 — the posts heading count must move when a material does.
 *
 * The regression this pins: the heading read only the RSC payload, while every
 * mutation updated the grid and the sidebar (`radaric:stats-changed` →
 * `/api/stats`) and nothing refreshed the counts — so the number stood still
 * until a full reload. The component now subscribes to the same signal via
 * `/api/posts/counts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, waitFor, within, act } from "@testing-library/react"

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

const FEED_ID = "feed-a"

function material(id: string) {
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
    feed: { id: FEED_ID, name: "Source A", type: "RSS" },
  } as any
}

let fetchMock: ReturnType<typeof vi.fn>
let countsResponse: Record<string, unknown>

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  countsResponse = {
    filter: { INBOX: 3, APPROVED: 3, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 3 },
  }
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/posts/counts")) {
      return { ok: true, json: async () => countsResponse }
    }
    return { ok: true, json: async () => ({ materials: [], total: 0 }) }
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function countsRequests() {
  return fetchMock.mock.calls.map(([input]) => String(input)).filter(u => u.startsWith("/api/posts/counts"))
}

const SERVER_COUNTS = {
  filter: { INBOX: 3, APPROVED: 3, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 3 },
}

describe("RAD-343: the heading count follows the material count", () => {
  it("updates on radaric:stats-changed, without a reload or a run", async () => {
    render(
      <MaterialsList
        initialMaterials={[material("m1"), material("m2"), material("m3")]}
        totalCount={3}
        serverCounts={SERVER_COUNTS as any}
      />
    )

    const trigger = screen.getByRole("button", { name: /inbox/i })
    await waitFor(() => expect(countsRequests().length).toBeGreaterThan(0))
    expect(within(trigger).getByText("3")).toBeInTheDocument()

    // A material was archived elsewhere in the app: the signal fires, the
    // route answers with the new counts.
    countsResponse = {
      filter: { INBOX: 2, APPROVED: 2, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 1, ALL: 3 },
    }
    act(() => {
      window.dispatchEvent(new Event("radaric:stats-changed"))
    })

    await waitFor(() => expect(within(trigger).getByText("2")).toBeInTheDocument())
  })

  it("stays on the server-rendered counts when the live refresh fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/posts/counts")) return { ok: false, json: async () => ({}) }
      return { ok: true, json: async () => ({ materials: [], total: 0 }) }
    })

    render(
      <MaterialsList
        initialMaterials={[material("m1"), material("m2"), material("m3")]}
        totalCount={3}
        serverCounts={SERVER_COUNTS as any}
      />
    )

    const trigger = screen.getByRole("button", { name: /inbox/i })
    expect(within(trigger).getByText("3")).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event("radaric:stats-changed"))
    })
    await waitFor(() => expect(countsRequests().length).toBeGreaterThan(1))
    expect(within(trigger).getByText("3")).toBeInTheDocument()
  })

  it("scopes the live fetch to the source page's feed", async () => {
    render(
      <MaterialsList
        initialMaterials={[material("m1")]}
        totalCount={1}
        serverCounts={SERVER_COUNTS as any}
        feedId={FEED_ID}
        hideSourceTypeFilter
        title="Source A"
      />
    )

    await waitFor(() => expect(countsRequests().length).toBeGreaterThan(0))
    expect(countsRequests()[0]).toBe(`/api/posts/counts?sourceId=${FEED_ID}`)
  })
})
