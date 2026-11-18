/** @vitest-environment jsdom */

/**
 * RAD-318 acceptance matrix — "mixed stories/materials, behaviour".
 *
 * `materials-list.tsx` lost ~850 lines in this rework. Everything that moved
 * out has a home and a test; what this file guards is what *stayed* — the card
 * action handlers, which are still passed down to `MaterialCard` — for a story
 * too, which is the same component with a `story` prop — and are otherwise
 * covered by nothing, because every other test in this suite mocks that
 * component away.
 *
 * The matrix is explicit about the method: **assert the call, not the click.**
 * A test that clicks a real card asserts the card's markup; these render a fake
 * card that exposes the handlers it was given, invoke them directly, and assert
 * the request that reaches the network — the URL, the verb and the body. A
 * story action must fan out to every constituent material; a material action
 * must not.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for card props and Prisma-shaped fixtures */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

/**
 * One fake, because there is one component: a story is a `MaterialCard` with a
 * `story` prop, not a separate card. Every handler becomes a button labelled
 * `<action>:<id>`, so a test names the action it wants instead of hunting for
 * an icon.
 */
vi.mock("@/components/materials/material-card", () => ({
  MaterialCard: ({ material, story, onDelete, onArchive, onRestore, onSendToNotion, onStoryFeedback }: any) => {
    const tag = story ? "story" : material.id
    return (
      <div data-testid={story ? "story-card" : "material-card"}>
        <span>{story ? story.title : material.title}</span>
        <button onClick={() => onDelete?.(material.id, { sourceFeedback: story ? "not a story" : "off topic" })}>
          delete:{tag}
        </button>
        <button onClick={() => onArchive?.(material.id)}>archive:{tag}</button>
        <button onClick={() => onRestore?.(material.id)}>restore:{tag}</button>
        {onStoryFeedback && <button onClick={() => onStoryFeedback("LIKE")}>feedback:{tag}</button>}
        {onSendToNotion && <button onClick={() => onSendToNotion(material.id)}>notion:{tag}</button>}
      </div>
    )
  },
}))

import { MaterialsList } from "@/components/materials/materials-list"

const FEED = { id: "feed-a", name: "Alpha Journal", type: "RSS" }

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
    feed: FEED,
    ...over,
  } as any
}

/** Two materials of one story plus one standalone — the matrix's mixed fixture. */
const STORY = {
  id: "story-1",
  title: "Two sources converge",
  summary: "…",
  createdAt: new Date("2026-09-02T00:00:00Z"),
  _count: { materials: 2, inboxItems: 0 },
}

function storyMaterial(id: string) {
  return material(id, { storyId: STORY.id, story: STORY, createdAt: new Date("2026-09-02T00:00:00Z") })
}

let fetchMock: ReturnType<typeof vi.fn>

/** Requests that mutate something, in order. */
function writes() {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? "GET", body: (init as RequestInit | undefined)?.body }))
    .filter(c => c.method !== "GET")
}

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
  sessionStorage.clear()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ materials: [], total: 0 }) }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderMixed(over: Record<string, unknown> = {}) {
  return render(
    <MaterialsList
      initialMaterials={[storyMaterial("s1"), storyMaterial("s2"), material("m1")]}
      totalCount={3}
      serverCounts={{
        filter: { INBOX: 3, APPROVED: 3, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 0, ALL: 3 },
      }}
      {...over}
    />
  )
}

describe("a material's own actions", () => {
  it("deletes exactly that post, carrying the feedback it was given", async () => {
    const user = userEvent.setup()
    renderMixed()

    await user.click(await screen.findByRole("button", { name: "delete:m1" }))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ url: "/api/posts/m1", method: "DELETE" })
    expect(JSON.parse(String(writes()[0].body))).toEqual({ sourceFeedback: "off topic" })
  })

  it("archives and restores through the same endpoint, with the status in the body", async () => {
    const user = userEvent.setup()
    // The ALL view is where an archived post legitimately stays on screen and
    // simply swaps to the restore control — on INBOX the predicate drops it.
    sessionStorage.setItem("radaric-materials-filter", "ALL")
    renderMixed()

    await user.click(await screen.findByRole("button", { name: "archive:m1" }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ url: "/api/posts/m1", method: "PATCH" })
    expect(JSON.parse(String(writes()[0].body))).toMatchObject({ userStatus: "ARCHIVED" })

    await user.click(await screen.findByRole("button", { name: "restore:m1" }))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(JSON.parse(String(writes()[1].body))).toMatchObject({ userStatus: "NEW" })
  })

  it("exports one post to Notion, and offers the control only when Notion is configured", async () => {
    const user = userEvent.setup()
    const { unmount } = renderMixed({ hasNotionIntegration: true })

    await user.click(await screen.findByRole("button", { name: "notion:m1" }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ url: "/api/posts/m1/notion", method: "POST" })

    unmount()
    renderMixed()
    // Without the integration the handler is not passed at all, so the card
    // cannot offer an action that would 400.
    expect(screen.queryByRole("button", { name: "notion:m1" })).toBeNull()
  })

  it("warns instead of confirming when Notion kept the page but dropped some media (truncated)", async () => {
    const { toast } = await import("sonner")
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/posts/m1/notion"
        ? { ok: true, json: async () => ({ success: true, truncated: true }) }
        : { ok: true, json: async () => ({ materials: [], total: 0 }) }
    )
    const user = userEvent.setup()
    renderMixed({ hasNotionIntegration: true })

    await user.click(await screen.findByRole("button", { name: "notion:m1" }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1))
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toMatch(/some media could not be attached/i)
    expect(toast.success).not.toHaveBeenCalledWith("Post sent to Notion")
  })
})

describe("a story's actions fan out to its materials", () => {
  it("archives every constituent material, not the story alone", async () => {
    const user = userEvent.setup()
    renderMixed()

    await user.click(await screen.findByRole("button", { name: "archive:story" }))

    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes().map(w => w.url).sort()).toEqual(["/api/posts/s1", "/api/posts/s2"])
    for (const w of writes()) {
      expect(w.method).toBe("PATCH")
      expect(JSON.parse(String(w.body))).toMatchObject({ userStatus: "ARCHIVED" })
    }
    // The standalone post is not part of the story and must not be touched.
    expect(writes().some(w => w.url.includes("m1"))).toBe(false)
  })

  it("deletes every constituent material, carrying the story's feedback", async () => {
    const user = userEvent.setup()
    renderMixed()

    await user.click(await screen.findByRole("button", { name: "delete:story" }))

    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes().map(w => w.url).sort()).toEqual(["/api/posts/s1", "/api/posts/s2"])
    expect(writes().every(w => w.method === "DELETE")).toBe(true)
    expect(JSON.parse(String(writes()[0].body))).toMatchObject({ sourceFeedback: "not a story" })
  })

  it("sends the story itself to Notion — one call, the story endpoint", async () => {
    const user = userEvent.setup()
    renderMixed({ hasNotionIntegration: true })

    await user.click(await screen.findByRole("button", { name: "notion:story" }))

    await waitFor(() => expect(writes()).toHaveLength(1))
    // Not N per-material exports: the story is one Notion page.
    expect(writes()[0]).toMatchObject({ url: "/api/stories/story-1/notion", method: "POST" })
  })

  it("propagates feedback to the story's OTHER materials, not the primary", async () => {
    const user = userEvent.setup()
    renderMixed()

    await user.click(await screen.findByRole("button", { name: "feedback:story" }))

    await waitFor(() => expect(writes().length).toBeGreaterThan(0))
    const feedback = writes().filter(w => w.url.includes("/feedback"))
    // The primary material's own feedback is sent by the card — the list would
    // otherwise double-post it. What the list owns is the propagation to the
    // rest of the story, which is the part nothing else would do.
    expect(feedback.map(w => w.url)).toEqual(["/api/posts/s2/feedback"])
    expect(feedback[0].method).toBe("POST")
    expect(JSON.parse(String(feedback[0].body))).toEqual({ feedbackType: "LIKE" })
  })
})

describe("what a /api/posts request carries", () => {
  /**
   * `buildPostsUrl` exists so a scope cannot be forgotten at one call site, and
   * a test over the module alone would prove nothing about the screen — these
   * assert the URLs the component actually sends. The `sourceId` half is
   * RAD-317's regression: two hand-built query strings had lost it, and a source
   * page served account-wide posts.
   */
  const reads = () =>
    fetchMock.mock.calls
      .map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? "GET" }))
      .filter(c => c.method === "GET" && c.url.startsWith("/api/posts?"))

  const paramsOf = (url: string) => new URL(url, "http://localhost").searchParams

  it("attaches sourceId to every read on a source page", async () => {
    const user = userEvent.setup()
    // Few enough local rows for the view switch to need a server page.
    renderMixed({
      feedId: "feed-a",
      initialMaterials: [],
      totalCount: 40,
      serverCounts: { filter: { INBOX: 0, APPROVED: 0, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 40, ALL: 40 } },
    })

    await user.click(await screen.findByRole("button", { name: /inbox/i }))
    await user.click(await screen.findByRole("menuitemradio", { name: /archive/i }))

    await waitFor(() => expect(reads().length).toBeGreaterThan(0))
    for (const r of reads()) expect(paramsOf(r.url).get("sourceId")).toBe("feed-a")
  })

  it("sends no sourceId on the account-wide screen", async () => {
    const user = userEvent.setup()
    renderMixed({
      initialMaterials: [],
      totalCount: 40,
      serverCounts: { filter: { INBOX: 0, APPROVED: 0, FILTERED: 0, SENT_TO_NOTION: 0, ARCHIVED: 40, ALL: 40 } },
    })

    await user.click(await screen.findByRole("button", { name: /inbox/i }))
    await user.click(await screen.findByRole("menuitemradio", { name: /archive/i }))

    await waitFor(() => expect(reads().length).toBeGreaterThan(0))
    for (const r of reads()) expect(paramsOf(r.url).has("sourceId")).toBe(false)
  })

  it("pages from rows the server served, not from mounted cells", async () => {
    const user = userEvent.setup()
    // 30 rows, server total 200 — Load more must ask for offset 30. The grid
    // shows fewer CELLS than that (two of the rows are one story), which is
    // exactly the confusion that made Load-more skip or repeat posts.
    const rows = [storyMaterial("s1"), storyMaterial("s2"), ...Array.from({ length: 28 }, (_, i) => material(`m${i}`))]
    renderMixed({ initialMaterials: rows, totalCount: 200 })

    await user.click(await screen.findByRole("button", { name: /load more/i }))

    await waitFor(() => expect(reads().length).toBeGreaterThan(0))
    expect(paramsOf(reads()[0].url).get("offset")).toBe("30")
  })
})
