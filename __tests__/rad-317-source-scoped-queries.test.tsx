/**
 * @vitest-environment jsdom
 */

/**
 * RAD-317 — `/feeds/[id]` must only ever show that source's posts.
 *
 * `MaterialsList` receives `feedId` on the per-source page, but three of its
 * client fetch paths built `/api/posts` URLs without `sourceId`, so each one
 * pulled account-wide results into a source-scoped screen:
 *
 *   - the filter-change effect (fires whenever fewer than 20 local matches)
 *   - load-more
 *   - server-side search
 *
 * These render the real component and assert on the URL it requests. A pure
 * helper simulation would pass whatever the component actually does.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and Prisma where-builder mocks */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
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

const FEED_ID = "feed-a"

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
    feed: { id: FEED_ID, name: "Source A", type: "RSS" },
    ...over,
  } as any
}

/** Every `/api/posts` URL the component has requested, in order. */
function postsRequests(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter(u => u.startsWith("/api/posts?"))
    .map(u => new URL(u, "http://localhost"))
}

let fetchMock: ReturnType<typeof vi.fn>

beforeAll(() => {
  // Radix menus probe these; jsdom implements none of them.
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

/** The view is a radio menu now, not a chip row. */
async function selectView(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(screen.getByRole("button", { name: /inbox|source a/i }))
  await user.click(await screen.findByRole("menuitemradio", { name: label }))
}

beforeEach(() => {
  sessionStorage.clear()
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ materials: [], total: 0 }),
  }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderSourcePage(initial = [material("m1"), material("m2"), material("m3")]) {
  return render(
    <MaterialsList
      initialMaterials={initial}
      totalCount={80}
      serverCounts={{
        filter: { INBOX: 3, APPROVED: 3, FILTERED: 50, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 80 },
      }}
      feedId={FEED_ID}
      hideSourceTypeFilter
      title="Source A"
    />
  )
}

describe("RAD-317: source-scoped client queries", () => {
  it("scopes the filter-change fetch to the current source", async () => {
    const user = userEvent.setup()
    renderSourcePage()

    await selectView(user, /filtered/i)

    await waitFor(() => expect(postsRequests(fetchMock).length).toBeGreaterThan(0))
    const req = postsRequests(fetchMock).at(-1)!
    expect(req.searchParams.get("filter")).toBe("FILTERED")
    expect(req.searchParams.get("sourceId")).toBe(FEED_ID)
  })

  it("scopes load-more to the current source", async () => {
    const user = userEvent.setup()
    renderSourcePage()

    await user.click(await screen.findByRole("button", { name: /load more posts/i }))

    await waitFor(() => expect(postsRequests(fetchMock).length).toBeGreaterThan(0))
    expect(postsRequests(fetchMock).at(-1)!.searchParams.get("sourceId")).toBe(FEED_ID)
  })

  it("scopes server-side search to the current source", async () => {
    const user = userEvent.setup()
    renderSourcePage()

    await user.type(screen.getByRole("searchbox", { name: /search posts/i }), "design")

    await waitFor(
      () => {
        const search = postsRequests(fetchMock).filter(u => u.searchParams.has("search"))
        expect(search.length).toBeGreaterThan(0)
        expect(search.at(-1)!.searchParams.get("sourceId")).toBe(FEED_ID)
      },
      { timeout: 3000 }
    )
  })

  it("does not send sourceId on the global /posts view", async () => {
    const user = userEvent.setup()
    render(
      <MaterialsList
        initialMaterials={[material("m1")]}
        totalCount={80}
        serverCounts={{
          filter: { INBOX: 1, APPROVED: 1, FILTERED: 50, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 80 },
        }}
      />
    )

    await selectView(user, /filtered/i)

    await waitFor(() => expect(postsRequests(fetchMock).length).toBeGreaterThan(0))
    expect(postsRequests(fetchMock).at(-1)!.searchParams.has("sourceId")).toBe(false)
  })
})
