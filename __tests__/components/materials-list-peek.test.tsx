/**
 * @vitest-environment jsdom
 */

/**
 * RAD-345 — the side peek, end to end through the list.
 *
 * What the pure modules cannot hold: that a card click routes by mode, that the
 * peek renders the list's own data without a request, that the URL carries the
 * target (and Back closes it), that actions reuse the list's optimistic
 * handlers, and that the deep link opens on first paint.
 *
 * jsdom notes:
 *   - no `matchMedia` → `useIsDesktop` resolves to the sheet, so every
 *     assertion runs against the mobile presentation. The desktop panel's
 *     geometry and the resize crossover belong to the real-browser pass.
 *   - history.back() does not navigate in jsdom, so Back is simulated with the
 *     URL write the browser would perform plus a `popstate` dispatch — that is
 *     exactly the contract the component listens to.
 *   - Radix keeps pointer events off the background while a modal sheet is
 *     open, which `userEvent` enforces and `fireEvent` does not. These tests
 *     drive clicks with `fireEvent` for that reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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

import { MaterialsList } from "@/components/materials/materials-list"
import { clearStoryPeekCache } from "@/components/stories/story-peek"

/**
 * jsdom has no `matchMedia`; faking a ≥1024px viewport puts the host on the
 * non-modal desktop panel, which is the only presentation where the list behind
 * the peek stays in the accessibility tree (Radix hides it for the modal sheet).
 */
function stubDesktopViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function material(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    content: "Plain body copy.",
    publishedAt: new Date("2026-09-09T20:59:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    aiReasoning: "Because it matches the curator's stated interests.",
    userStatus: "NEW" as const,
    createdAt: "2026-09-09T20:59:00Z",
    feed: { id: "feed-1", name: "e/acc", type: "TELEGRAM" as const },
    feedbacks: [],
    ...overrides,
  }
}

function listProps(overrides: Record<string, unknown> = {}) {
  const materials = [
    material("m1", "Connectome demos"),
    material("m2", "Second post"),
  ]
  return {
    initialMaterials: materials,
    totalCount: materials.length,
    hasNotionIntegration: false,
    ...overrides,
  }
}

/** The list's card for a post — the interactive card, found by its title. */
function cardFor(title: string) {
  return screen.getByRole("button", { name: new RegExp(title) })
}

function switchToDrawer() {
  fireEvent.click(screen.getByRole("button", { name: /side panel/i }))
}

beforeEach(() => {
  push.mockClear()
  window.history.replaceState(null, "", "/posts")
  localStorage.clear()
  sessionStorage.clear()
  clearStoryPeekCache()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("mode routing", () => {
  it("navigates as before while the mode is full page", () => {
    render(<MaterialsList {...listProps()} />)

    fireEvent.click(cardFor("Connectome demos"))

    expect(push).toHaveBeenCalledWith("/posts/m1")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(window.location.search).toBe("")
  })

  it("opens the peek in drawer mode, from the list's own data and without a request", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()

    // Captured before the click, so the assertion stays "opening the peek
    // issues no request of its own" no matter how many per-mount reads the
    // list grows (RAD-347's parse-run status check, RAD-343's live heading
    // counts) — a filter list would erode it one ticket at a time.
    const requestsBefore = vi.mocked(fetch).mock.calls.length

    fireEvent.click(cardFor("Connectome demos"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { level: 1, name: "Connectome demos" })).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
    expect(window.location.search).toBe("?post=m1")
    // The peek renders from the list's own data.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.slice(requestsBefore)
        .map(([url]) => String(url))
    ).toEqual([])
  })

  it("names the dialog from the peek header, not the article headline", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))

    expect(await screen.findByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
  })

  it("remembers the choice across a reload", async () => {
    const first = render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    expect(screen.getByRole("button", { name: /side panel/i })).toHaveAttribute("aria-pressed", "true")
    first.unmount()

    render(<MaterialsList {...listProps()} />)
    expect(screen.getByRole("button", { name: /side panel/i })).toHaveAttribute("aria-pressed", "true")

    // And the stored preference is what routed the click.
    fireEvent.click(cardFor("Connectome demos"))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("closes an open peek when the mode switches back to full page", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    fireEvent.click(screen.getByRole("button", { name: /side panel/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(window.location.search).toBe("")
  })
})

describe("URL is the state", () => {
  it("opens and closes without adding history entries from a deep link", async () => {
    window.history.replaceState(null, "", "/posts?post=m1")
    render(<MaterialsList {...listProps()} initialPeek={{ kind: "post", id: "m1" }} />)

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { level: 1, name: "Connectome demos" })).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: "Close preview" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // A deep link has no entry of ours to go back to — the param is stripped.
    expect(window.location.search).toBe("")
  })

  it("closes when the browser goes back", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    // What a real Back would leave behind before popstate fires.
    window.history.replaceState(null, "", "/posts")
    fireEvent.popState(window)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("swaps the content in place when another card is clicked", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    fireEvent.click(cardFor("Second post"))

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument()
    )
    expect(window.location.search).toBe("?post=m2")
  })
})

describe("prev / next", () => {
  it("walks the visible order and disables at the ends", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("button", { name: "Previous item" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Next item" })).toBeEnabled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Next item" }))

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument())
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Next item" })).toBeDisabled()
  })

  it("walks with j and k", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    fireEvent.keyDown(window, { key: "j" })
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument())

    fireEvent.keyDown(window, { key: "k" })
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument())
  })

  it("leaves the keyboard alone while a text selection is live", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as unknown as Selection)
    fireEvent.keyDown(window, { key: "j" })
    selection.mockRestore()

    expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
  })
})

describe("actions from the peek", () => {
  it("archives the open post and opens the next one in its place", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")
    // Spied after the open, whose push is the entry the advance must replace.
    const pushState = vi.spyOn(window.history, "pushState")
    const replaceState = vi.spyOn(window.history, "replaceState")

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    // Archive is "done with this one": the panel moves on to the next visible
    // cell instead of parking on the archived copy.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument()
    )
    expect(window.location.search).toBe("?post=m2")
    // Replaced, not pushed: Back still lands on the clean list URL, never on
    // the post that was just archived.
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/posts?post=m2")
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/posts/m1",
      expect.objectContaining({ method: "PATCH" })
    )

    // The walk stays consistent with the grid: m1 left Inbox, m2 is alone.
    const next = screen.getByRole("dialog", { name: "Second post" })
    expect(within(next).getByRole("button", { name: "Previous item" })).toBeDisabled()
    expect(within(next).getByRole("button", { name: "Next item" })).toBeDisabled()
  })

  it("advances on the All view, where the archived card stays in the grid", async () => {
    const user = userEvent.setup()
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()

    // All posts: nothing takes the card's place — the panel still moves on,
    // because the advance follows the archive, not the filter's reflow.
    await user.click(screen.getByRole("button", { name: /^inbox/i }))
    const menu = await screen.findByRole("menu")
    await user.click(within(menu).getByRole("menuitemradio", { name: /all posts/i }))

    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument()
    )
    expect(within(cardFor("Connectome demos")).getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("stays on the post when the archive request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }))
    )
    // Desktop panel: modal presentation hides the grid, and the point here is
    // that the restored card is back in it.
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    // Nothing was archived: the card comes back and the panel must not have
    // moved on to the next post.
    await waitFor(() => expect(cardFor("Connectome demos")).toBeInTheDocument())
    expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
    expect(window.location.search).toBe("?post=m1")
  })

  it("keeps a deep-linked post that is outside the visible filter", async () => {
    window.history.replaceState(null, "", "/posts?post=m1")
    render(
      <MaterialsList
        {...listProps({
          initialMaterials: [
            material("m1", "Connectome demos", { aiEvaluation: "FILTERED" }),
            material("m2", "Second post"),
          ],
          // Keeps the view's total at its local match, so the filter-change
          // effect does not fetch a page this fixture cannot serve.
          totalCount: 1,
        })}
        initialPeek={{ kind: "post", id: "m1" }}
      />
    )
    const dialog = await screen.findByRole("dialog", { name: "Connectome demos" })

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    // Not in the Inbox order at all — no next cell to plan, so the panel holds
    // the archived copy and the URL keeps its target.
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("Archived")).toBeInTheDocument()
    )
    expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
    expect(window.location.search).toBe("?post=m1")
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/posts/m1",
      expect.objectContaining({ method: "PATCH" })
    )
  })

  it("keeps the archived state when the archived post was the last one", async () => {
    render(
      <MaterialsList
        {...listProps({ initialMaterials: [material("m1", "Connectome demos")], totalCount: 1 })}
      />
    )
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    // Nowhere to move to — the panel holds the archived copy, Restore at hand.
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("Archived")).toBeInTheDocument()
    )
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("does not reopen the peek when the exited post is archived", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog", { name: "Connectome demos" })

    // Close, then archive the card while the exit is still running: the ref
    // still holds the closed target, but the panel is closed — it must stay.
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
    fireEvent.click(within(cardFor("Connectome demos")).getByRole("button", { name: "Archive" }))

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/posts/m1",
        expect.objectContaining({ method: "PATCH" })
      )
    )
    expect(screen.queryByRole("dialog", { name: "Second post" })).toBeNull()
    expect(window.location.search).toBe("")
  })

  it("leaves the peek on its post when a different card is archived", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog", { name: "Connectome demos" })

    // The other post goes from its own card; the open peek must not move.
    // `fireEvent` has no pointerdown, and in a mouse-driven browser an outside
    // pointerdown dismisses the panel first — so this exercises the guard as a
    // keyboard user reaches it (Tab out of the panel does not dismiss).
    fireEvent.click(within(cardFor("Second post")).getByRole("button", { name: "Archive" }))

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/posts/m2",
        expect.objectContaining({ method: "PATCH" })
      )
    )
    expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
    expect(window.location.search).toBe("?post=m1")
  })

  it("deletes through the same dialog as the card and closes the peek", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("dialog", { name: /delete post/i })
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete without comment" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /preview|Connectome/i })).toBeNull())
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/posts/m1",
      expect.objectContaining({ method: "DELETE" })
    )
    // The card left the grid with it.
    await waitFor(() => expect(screen.queryByText("Connectome demos")).toBeNull())
  })
})

describe("story peek", () => {
  const storyMaterial = () =>
    material("m9", "Story carrier", {
      storyId: "s1",
      story: {
        id: "s1",
        title: "Connectome-based networks",
        summary: "A summary.",
        rubrics: ["AI"],
        sourceUrls: ["https://example.com/a"],
        status: "DRAFT",
        version: 2,
        createdAt: "2026-09-10T14:52:00Z",
        _count: { materials: 1, inboxItems: 0 },
      },
    })

  const storyPayload = {
    id: "s1",
    title: "Connectome-based networks",
    languageFlag: null,
    summary: "A summary.",
    body: "First paragraph.",
    keyPoints: ["A takeaway."],
    sourceUrls: ["https://example.com/a"],
    rubrics: ["AI"],
    archiveLinks: null,
    notionPageId: null,
    notionUrl: null,
    status: "DRAFT",
    version: 2,
    createdAt: "2026-09-10T14:52:00Z",
    updatedAt: "2026-09-10T14:52:00Z",
    materials: [material("m9", "Story carrier")],
    inboxItems: [],
  }

  it("fetches the story and renders the reading body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(storyPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    )
    render(<MaterialsList {...listProps({ initialMaterials: [storyMaterial()] })} />)
    switchToDrawer()

    fireEvent.click(cardFor("Connectome-based networks"))

    const dialog = await screen.findByRole("dialog", { name: "Connectome-based networks" })
    await waitFor(() =>
      expect(within(dialog).getByRole("heading", { level: 1, name: "Connectome-based networks" })).toBeInTheDocument()
    )
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/stories/s1", expect.anything())
    expect(within(dialog).getByText("Key takeaways")).toBeInTheDocument()
  })

  it("re-reads a story the grid has changed — the cache is not authority", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        calls.push(url)
        if (url.startsWith("/api/stories/")) {
          return new Response(JSON.stringify(storyPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        // Anything else the list might ask for (it may refetch a page):
        // a well-formed empty payload for reads, a success for writes.
        const payload = method === "GET" ? { materials: [], total: 0 } : { success: true }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      })
    )
    stubDesktopViewport()
    // `totalCount: 1` keeps the list from asking for a page it does not need —
    // a mocked empty page would replace the grid under the test.
    render(<MaterialsList {...listProps({ initialMaterials: [storyMaterial()], totalCount: 1 })} />)
    switchToDrawer()

    // Open once, so the story lands in the session cache.
    fireEvent.click(cardFor("Connectome-based networks"))
    await screen.findByRole("dialog", { name: "Connectome-based networks" })
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // Archive the whole story from its grid card, then re-open it: the cached
    // copy is stale by then and must not be served.
    fireEvent.click(screen.getByRole("button", { name: "Archive all" }))
    await waitFor(() => expect(calls.some(u => u === "/api/posts/m9")).toBe(true))

    // Archiving drops the cell from Inbox — the Archive view is where the
    // still-cached story would be reachable. Radix opens its menu on pointer
    // events, so this one interaction goes through userEvent.
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^inbox/i }))
    const menu = await screen.findByRole("menu")
    await user.click(within(menu).getByRole("menuitemradio", { name: /archive/i }))

    fireEvent.click(cardFor("Connectome-based networks"))
    await screen.findByRole("dialog", { name: "Connectome-based networks" })

    expect(calls.filter(u => u.startsWith("/api/stories/")).length).toBe(2)
  })

  it("reports a story that is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Story not found" }), { status: 404 }))
    )
    window.history.replaceState(null, "", "/posts?story=s1")
    render(<MaterialsList {...listProps()} initialPeek={{ kind: "story", id: "s1" }} />)

    expect(await screen.findByText("This story is no longer available")).toBeInTheDocument()
  })
})

describe("swap hygiene", () => {
  it("starts a new target at the top of the panel", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    const scroller = dialog.querySelector(".overflow-y-auto") as HTMLElement
    expect(scroller).not.toBeNull()
    scroller.scrollTop = 420
    expect(scroller.scrollTop).toBe(420)

    fireEvent.click(cardFor("Second post"))

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Second post" })).toBeInTheDocument())
    expect((screen.getByRole("dialog").querySelector(".overflow-y-auto") as HTMLElement).scrollTop).toBe(0)
  })
})

describe("outside clicks", () => {
  it("closes the panel when the click lands outside it", async () => {
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(window.location.search).toBe("")
  })
})

describe("peek lifetime", () => {
  it("keeps an open peek alive when the list resets under it", async () => {
    const { rerender } = render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    // What `router.refresh()` / a parse finishing does: a fresh page that no
    // longer carries the open target. The snapshot taken at open must hold.
    rerender(<MaterialsList {...listProps({ initialMaterials: [material("m2", "Second post")] })} />)

    const dialog = screen.getByRole("dialog", { name: "Connectome demos" })
    expect(within(dialog).getByRole("heading", { level: 1, name: "Connectome demos" })).toBeInTheDocument()
  })

  it("lets the live list copy win over the snapshot", async () => {
    const { rerender } = render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    // An optimistic action in the grid (archive) must show up in the panel.
    rerender(
      <MaterialsList
        {...listProps({ initialMaterials: [material("m1", "Connectome demos", { userStatus: "ARCHIVED" }), material("m2", "Second post")] })}
      />
    )

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Archived")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("reopens the same card right after closing the peek", async () => {
    // The exit hold keeps the closed target in a ref; a reopen of that same
    // target must not be mistaken for "already open".
    stubDesktopViewport()
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    fireEvent.click(cardFor("Connectome demos"))

    expect(await screen.findByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
  })

  it("closes the peek when its story is deleted from the grid", async () => {
    const storyMat = material("m9", "Story carrier", {
      storyId: "s1",
      story: {
        id: "s1",
        title: "Connectome-based networks",
        summary: "s",
        rubrics: [],
        sourceUrls: [],
        status: "DRAFT",
        version: 1,
        createdAt: "2026-09-10T00:00:00Z",
        _count: { materials: 1, inboxItems: 0 },
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        // The peek fetches the story; everything else is a write.
        const payload = url.startsWith("/api/stories/")
          ? {
              id: "s1",
              title: "Connectome-based networks",
              languageFlag: null,
              summary: "A summary.",
              body: "Body.",
              keyPoints: [],
              sourceUrls: [],
              rubrics: [],
              archiveLinks: null,
              notionPageId: null,
              notionUrl: null,
              status: "DRAFT",
              version: 1,
              createdAt: "2026-09-10T00:00:00Z",
              updatedAt: "2026-09-10T00:00:00Z",
              materials: [material("m9", "Story carrier")],
              inboxItems: [],
            }
          : { success: true }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      })
    )
    stubDesktopViewport()
    render(<MaterialsList {...listProps({ initialMaterials: [storyMat], totalCount: 1 })} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome-based networks"))
    await screen.findByRole("dialog")

    fireEvent.click(screen.getByRole("button", { name: "Delete all" }))
    const confirm = await screen.findByRole("dialog", { name: /delete story/i })
    fireEvent.click(within(confirm).getByRole("button", { name: /^delete story$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps the peek open when the pointer lands on the portaled excerpt pill", async () => {
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    await screen.findByRole("dialog")

    const pill = document.createElement("button")
    pill.setAttribute("data-excerpt-pill", "")
    document.body.appendChild(pill)
    fireEvent.pointerDown(pill)

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    pill.remove()
  })

  it("keeps the peek open when the delete fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }))
    )
    render(<MaterialsList {...listProps()} />)
    switchToDrawer()
    fireEvent.click(cardFor("Connectome demos"))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("dialog", { name: /delete post/i })
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete without comment" }))

    // The card is restored by the list; the panel must not vanish with it.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /delete post/i })).toBeNull())
    expect(screen.getByRole("dialog", { name: "Connectome demos" })).toBeInTheDocument()
  })
})
