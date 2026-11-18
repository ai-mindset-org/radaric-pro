/**
 * @vitest-environment jsdom
 */

/**
 * RAD-393 — `/folders/[id]` must only ever show the folder's sources' posts.
 *
 * Same class of bug as RAD-317, one scope over: every client fetch path
 * (filter change, load-more, server-side search, live counts) must carry
 * `folderId` and never `sourceId`; the type filter stays visible (a folder is a
 * multi-source scope) and the account-wide bulk delete stays hidden.
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

const FOLDER_ID = "folder-1"
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

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input))
}

function postsRequests(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return requestedUrls(fetchMock)
    .filter(u => u.startsWith("/api/posts?"))
    .map(u => new URL(u, "http://localhost"))
}

let fetchMock: ReturnType<typeof vi.fn>

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

async function selectView(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(screen.getByRole("button", { name: /inbox/i }))
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

function renderFolderPage(initial = [material("m1"), material("m2"), material("m3")]) {
  return render(
    <MaterialsList
      initialMaterials={initial}
      totalCount={80}
      serverCounts={{
        filter: { INBOX: 3, APPROVED: 3, FILTERED: 50, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 80 },
        sourceType: { ALL: 80, RSS: 50, TELEGRAM: 30, TWITTER: 0, YOUTUBE: 0, EVENT_TRIGGER: 0 },
      }}
      folderId={FOLDER_ID}
      folderSourceIds={[FEED_ID]}
      scopeName="Design"
      title="Design"
    />
  )
}

describe("RAD-393: folder-scoped client queries", () => {
  it("scopes the filter-change fetch to the folder, never to a source", async () => {
    const user = userEvent.setup()
    renderFolderPage()

    await selectView(user, /filtered/i)

    await waitFor(() => expect(postsRequests(fetchMock).length).toBeGreaterThan(0))
    const req = postsRequests(fetchMock).at(-1)!
    expect(req.searchParams.get("filter")).toBe("FILTERED")
    expect(req.searchParams.get("folderId")).toBe(FOLDER_ID)
    expect(req.searchParams.has("sourceId")).toBe(false)
  })

  it("scopes load-more to the folder", async () => {
    const user = userEvent.setup()
    renderFolderPage()

    await user.click(await screen.findByRole("button", { name: /load more posts/i }))

    await waitFor(() => expect(postsRequests(fetchMock).length).toBeGreaterThan(0))
    const req = postsRequests(fetchMock).at(-1)!
    expect(req.searchParams.get("folderId")).toBe(FOLDER_ID)
    expect(req.searchParams.has("sourceId")).toBe(false)
  })

  it("scopes server-side search to the folder", async () => {
    const user = userEvent.setup()
    renderFolderPage()

    await user.type(screen.getByRole("searchbox", { name: /search posts/i }), "design")

    await waitFor(
      () => {
        const search = postsRequests(fetchMock).filter(u => u.searchParams.has("search"))
        expect(search.length).toBeGreaterThan(0)
        expect(search.at(-1)!.searchParams.get("folderId")).toBe(FOLDER_ID)
        expect(search.at(-1)!.searchParams.has("sourceId")).toBe(false)
      },
      { timeout: 3000 }
    )
  })

  it("requests live counts with folderId and never with sourceId", async () => {
    renderFolderPage()

    await waitFor(() => {
      expect(requestedUrls(fetchMock).some(u => u.startsWith("/api/posts/counts"))).toBe(true)
    })
    const counts = requestedUrls(fetchMock).find(u => u.startsWith("/api/posts/counts"))!
    const params = new URL(counts, "http://localhost").searchParams
    expect(params.get("folderId")).toBe(FOLDER_ID)
    expect(params.has("sourceId")).toBe(false)
  })

  it("keeps the source-type filter visible on a folder page (unlike a source page)", () => {
    renderFolderPage()
    expect(screen.getByRole("button", { name: /all types/i })).toBeTruthy()

    cleanup()
    render(
      <MaterialsList
        initialMaterials={[material("m1")]}
        totalCount={3}
        serverCounts={{
          filter: { INBOX: 1, APPROVED: 1, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 3 },
        }}
        feedId={FEED_ID}
        hideSourceTypeFilter
        title="Source A"
      />
    )
    expect(screen.queryByRole("button", { name: /all types/i })).toBeNull()
  })

  it("hides the account-wide bulk delete on a folder page", async () => {
    const user = userEvent.setup()
    renderFolderPage()

    await selectView(user, /filtered/i)
    await user.click(screen.getByRole("button", { name: /more actions/i }))

    expect(screen.queryByRole("menuitem", { name: /delete all/i })).toBeNull()
  })

  it("inherits the persisted source-type filter (folder pages are multi-source)", async () => {
    sessionStorage.setItem("radaric-materials-source-type", JSON.stringify(["RSS"]))
    const user = userEvent.setup()
    renderFolderPage()

    await selectView(user, /filtered/i)

    await waitFor(() => {
      const withType = postsRequests(fetchMock).filter(u => u.searchParams.has("sourceType"))
      expect(withType.length).toBeGreaterThan(0)
      const req = withType.at(-1)!
      expect(req.searchParams.get("sourceType")).toBe("RSS")
      expect(req.searchParams.get("folderId")).toBe(FOLDER_ID)
    })
  })
})
