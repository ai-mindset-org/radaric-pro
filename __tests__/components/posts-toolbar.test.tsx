/** @vitest-environment jsdom */

/**
 * RAD-318 Phase 3 — the recomposed toolbar.
 *
 * The acceptance matrix rows this file owns: exactly one view is selected and
 * switching preserves the other refinements; source types apply live with no
 * Apply step; the heading shows one number that is never stale; every action
 * that used to be a button in the title cluster is still reachable; and the
 * parsing primary has the accessible name it always claimed to have.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PostsToolbar } from "@/components/materials/posts-toolbar"
import type { FilterType } from "@/lib/feed-utils"
import type { SourceTypeFilter } from "@/components/shared/feed-type-filter"

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))

beforeAll(() => {
  // Radix probes these; jsdom implements none of them.
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

type Props = Parameters<typeof PostsToolbar>[0]

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    view: "INBOX" as FilterType,
    onViewChange: vi.fn(),
    viewCounts: { INBOX: 46, FILTERED: 12, SENT_TO_NOTION: 3, ARCHIVED: 8, ALL: 67 },
    headingCount: 46,
    sourceTypes: ["ALL"] as SourceTypeFilter[],
    onSourceTypesChange: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    onParse: vi.fn(),
    onGroupStories: vi.fn(),
    onRefilter: vi.fn(),
    ...overrides,
  }
  const view = render(<PostsToolbar {...props} />)
  return { ...view, props, user: userEvent.setup() }
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: RegExp | string) => {
  await user.click(screen.getByRole("button", { name }))
  return screen.findByRole("menu")
}

describe("views", () => {
  it("shows the current view and its count as the heading", () => {
    setup()
    const trigger = screen.getByRole("button", { name: /inbox/i })
    expect(within(trigger).getByRole("heading", { level: 1 })).toHaveTextContent("Inbox")
    expect(trigger).toHaveTextContent("46")
  })

  it("offers exactly one selected option, with radio semantics", async () => {
    const { user } = setup()
    await openMenu(user, /inbox/i)

    const items = screen.getAllByRole("menuitemradio")
    expect(items.map(i => i.textContent?.replace(/\d+$/, ""))).toEqual([
      "Inbox",
      "Filtered",
      "In Stories",
      "Archive",
      "All posts",
    ])
    expect(items.filter(i => i.getAttribute("aria-checked") === "true")).toHaveLength(1)
  })

  it("does not offer AI Approved, which was a second name for Inbox", async () => {
    const { user } = setup()
    await openMenu(user, /inbox/i)
    expect(screen.queryByRole("menuitemradio", { name: /approved/i })).toBeNull()
  })

  it("carries each view's own total into the menu", async () => {
    const { user } = setup()
    await openMenu(user, /inbox/i)
    expect(screen.getByRole("menuitemradio", { name: /archive/i })).toHaveTextContent("8")
  })

  it("reports a switch without touching search or types", async () => {
    const { user, props } = setup({ search: "design", sourceTypes: ["RSS"] })
    await openMenu(user, /inbox/i)
    await user.click(screen.getByRole("menuitemradio", { name: /filtered/i }))

    expect(props.onViewChange).toHaveBeenCalledWith("FILTERED")
    expect(props.onSearchChange).not.toHaveBeenCalled()
    expect(props.onSourceTypesChange).not.toHaveBeenCalled()
  })

  it("keeps the source as the heading and puts the view beside it", () => {
    // The page is "Alpha Journal, filtered" — the source's identity is not
    // replaced by a view name, and the view is still switchable there.
    setup({ sourceName: "Alpha Journal", hideSourceTypes: true, headingCount: 6 })

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha Journal")
    const viewTrigger = screen.getByRole("button", { name: /inbox/i })
    expect(viewTrigger).toHaveTextContent("6")
    expect(within(viewTrigger).queryByRole("heading")).toBeNull()
  })
})

describe("the heading count", () => {
  it("is a pending indicator rather than a stale number while a query runs", () => {
    setup({ headingCount: "pending" })
    expect(screen.getByText(/counting matching posts/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /inbox/i })).not.toHaveTextContent("46")
  })

  it("shows zero as a real answer", () => {
    setup({ headingCount: 0 })
    expect(screen.getByRole("button", { name: /inbox/i })).toHaveTextContent("0")
  })
})

describe("source types", () => {
  it("reads All types until something is restricted", () => {
    setup()
    expect(screen.getByRole("button", { name: /all types/i })).toBeInTheDocument()
  })

  it("names the single selected type, then counts them", () => {
    const { unmount } = setup({ sourceTypes: ["TELEGRAM"] })
    expect(screen.getByRole("button", { name: /telegram/i })).toBeInTheDocument()
    unmount()

    setup({ sourceTypes: ["TELEGRAM", "RSS"] })
    expect(screen.getByRole("button", { name: /2 types/i })).toBeInTheDocument()
  })

  it("applies each change live, with no Apply or Clear step", async () => {
    const { user, props } = setup()
    await openMenu(user, /all types/i)

    expect(screen.queryByRole("menuitem", { name: /apply|clear/i })).toBeNull()
    await user.click(screen.getByRole("menuitemcheckbox", { name: /telegram/i }))

    expect(props.onSourceTypesChange).toHaveBeenCalledWith(["TELEGRAM"])
  })

  it("keeps the menu open so several types can be picked in one visit", async () => {
    const { user } = setup({ sourceTypes: ["RSS"] })
    await openMenu(user, /^rss$/i)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /youtube/i }))

    expect(screen.getByRole("menu")).toBeTruthy()
  })

  it("treats All types as a reset", async () => {
    const { user, props } = setup({ sourceTypes: ["RSS", "YOUTUBE"] })
    await openMenu(user, /2 types/i)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /all types/i }))

    expect(props.onSourceTypesChange).toHaveBeenCalledWith(["ALL"])
  })

  it("normalizes an emptied selection back to all types, never to an impossible filter", async () => {
    const { user, props } = setup({ sourceTypes: ["RSS"] })
    await openMenu(user, /^rss$/i)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /^rss$/i }))

    expect(props.onSourceTypesChange).toHaveBeenCalledWith(["ALL"])
  })

  it("is hidden entirely on a source page", () => {
    setup({ hideSourceTypes: true, sourceName: "Alpha Journal" })
    expect(screen.queryByRole("button", { name: /all types/i })).toBeNull()
  })
})

describe("search", () => {
  it("has an accessible label and reports every keystroke to the owner of the query", async () => {
    const { user, props } = setup()
    const input = screen.getByRole("searchbox", { name: /search posts/i })

    await user.type(input, "ab")

    expect(props.onSearchChange).toHaveBeenCalledTimes(2)
  })

  it("offers a clear affordance only when there is something to clear", () => {
    const { unmount } = setup()
    expect(screen.queryByRole("button", { name: /clear search/i })).toBeNull()
    unmount()

    setup({ search: "design" })
    expect(screen.getByRole("button", { name: /clear search/i })).toBeInTheDocument()
  })

  it("clears the query and returns focus to the search trigger", async () => {
    const { user, props } = setup({ search: "design" })

    await user.click(screen.getByRole("button", { name: /clear search/i }))

    expect(props.onSearchChange).toHaveBeenCalledWith("")
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^search posts$/i }))
  })

  it("Escape clears rather than leaving an invisible active query", async () => {
    const { user, props } = setup({ search: "design" })
    const input = screen.getByRole("searchbox")

    await user.type(input, "{Escape}")

    expect(props.onSearchChange).toHaveBeenCalledWith("")
  })
})

describe("actions", () => {
  it("names the primary 'Run parsing' at every width", () => {
    // The old markup split the label across two text nodes, one of them
    // display:none on mobile, so the accessible name computed to "RunParsing"
    // and no assistive technology or test could address it by its real name.
    setup()
    expect(screen.getByRole("button", { name: "Run parsing" })).toBeTruthy()
  })

  it("disables the primary and labels the phase during a run", () => {
    setup({ isRunning: true, runningLabel: "Grouping stories…" })
    // The accessible name follows the phase, not just the visible text: below
    // `sm` the label collapses to an icon, and announcing "Run parsing" for the
    // whole of a grouping run names the wrong action.
    const primary = screen.getByRole("button", { name: "Grouping stories…" })

    expect(primary).toBeDisabled()
    expect(primary).toHaveTextContent("Grouping stories…")
    expect(screen.queryByRole("button", { name: "Run parsing" })).toBeNull()
  })

  it("keeps grouping and AI rules reachable from the More actions menu", async () => {
    const { user, props } = setup()
    await openMenu(user, /more actions/i)

    await user.click(screen.getByRole("menuitem", { name: /group stories/i }))
    expect(props.onGroupStories).toHaveBeenCalled()

    await openMenu(user, /more actions/i)
    await user.click(screen.getByRole("menuitem", { name: /run ai rules/i }))
    expect(props.onRefilter).toHaveBeenCalled()
  })

  it("disables conflicting run actions while a job is active", async () => {
    const { user } = setup({ isRunning: true })
    await openMenu(user, /more actions/i)

    expect(screen.getByRole("menuitem", { name: /group stories/i })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("menuitem", { name: /run ai rules/i })).toHaveAttribute("aria-disabled", "true")
  })

  it("offers bulk delete only where it is given, and labels its real account-wide scope", async () => {
    const onDelete = vi.fn()
    const { user, unmount } = setup({
      view: "FILTERED",
      bulkDelete: { count: 12, isDeleting: false, onDelete },
    })
    await openMenu(user, /more actions/i)

    const item = screen.getByRole("menuitem", { name: /delete all filtered posts/i })
    expect(item).toHaveTextContent("12")
    await user.click(item)
    expect(onDelete).toHaveBeenCalled()
    unmount()

    const second = setup()
    await openMenu(second.user, /more actions/i)
    expect(screen.queryByRole("menuitem", { name: /delete all/i })).toBeNull()
  })
})

describe("mobile composition", () => {
  beforeEach(() => {
    // jsdom has no layout, so the responsive rows are asserted by the classes
    // that produce them; the real geometry is measured in a browser in Phase 6.
  })

  it("puts every mobile control on the 44px floor explicitly, not via Button sizes", () => {
    setup()
    for (const name of [/^search posts$/i, "Run parsing", /more actions/i]) {
      const control = screen.getByRole("button", { name })
      expect(control.className).toContain("min-h-[44px]")
      expect(control.className).toContain("min-w-[44px]")
    }
  })

  it("places the two mobile rows explicitly, so neither depends on wrapping", () => {
    const { container } = setup()
    const grid = container.firstElementChild as HTMLElement

    // One grid, one instance of each control: the mobile rows and the desktop
    // row are the same elements placed differently.
    expect(grid.className).toContain("grid-cols-[1fr_auto_auto]")
    expect(screen.getAllByRole("searchbox")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: /more actions/i })).toHaveLength(1)

    const typeCell = screen.getByRole("button", { name: /all types/i }).parentElement!
    const moreCell = screen.getByRole("button", { name: /more actions/i }).parentElement!
    expect(typeCell.className).toContain("row-start-2")
    expect(typeCell.className).toContain("justify-self-start")
    expect(moreCell.className).toContain("row-start-2")
    expect(moreCell.className).toContain("justify-self-end")
  })
})

describe("open mode (RAD-345)", () => {
  it("renders no control when the list does not provide the callback", () => {
    setup()
    expect(screen.queryByRole("button", { name: /side panel/i })).toBeNull()
  })

  it("shows the current mode through aria-pressed", () => {
    setup({ openMode: "drawer", onOpenModeChange: vi.fn() })
    expect(screen.getByRole("button", { name: /side panel/i })).toHaveAttribute("aria-pressed", "true")
  })

  it("reports the switch and keeps the 44px floor on mobile", async () => {
    const onOpenModeChange = vi.fn()
    const { user } = setup({ openMode: "page", onOpenModeChange })

    const toggle = screen.getByRole("button", { name: /side panel/i })
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(toggle.className).toContain("min-h-[44px]")

    await user.click(toggle)
    expect(onOpenModeChange).toHaveBeenCalledWith("drawer")
  })

  it("sits beside the status filter, in the same cluster", () => {
    setup({ openMode: "page", onOpenModeChange: vi.fn() })
    const view = screen.getByRole("button", { name: /inbox/i })
    const toggle = screen.getByRole("button", { name: /side panel/i })
    expect(view.parentElement).toBe(toggle.parentElement)
  })

  it("keeps the grid template unchanged — the control rides in the existing cluster", () => {
    const { container } = setup({ openMode: "drawer", onOpenModeChange: vi.fn() })
    const grid = container.firstElementChild as HTMLElement
    expect(grid.className).toContain("grid-cols-[1fr_auto_auto]")
  })
})

describe("PostsToolbar — last-checked line hidden (2026-11-05)", () => {
  const freshness = {
    checkedAt: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    inactiveCheckedAt: null,
    activeCount: 3,
    neverCount: 0,
    failedCount: 1,
    pausedCount: 0,
  } satisfies NonNullable<Props["freshness"]>

  it("renders no 'Checked … ago' line under the posts heading", () => {
    setup({ freshness })
    expect(screen.queryByTestId("source-freshness")).not.toBeInTheDocument()
    expect(screen.queryByText(/checked/i)).not.toBeInTheDocument()
  })

  it("renders no line under a source name either", () => {
    setup({ freshness, sourceName: "Alpha Journal", hideSourceTypes: true })
    expect(screen.getByRole("heading", { name: "Alpha Journal" })).toBeInTheDocument()
    expect(screen.queryByTestId("source-freshness")).not.toBeInTheDocument()
    expect(screen.queryByText(/checked/i)).not.toBeInTheDocument()
  })
})
