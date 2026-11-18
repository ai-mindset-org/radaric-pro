/**
 * @vitest-environment jsdom
 */

/**
 * RAD-210 / RAD-393 — Sidebar component
 *
 * Covers the presentational shape of components/layout/sidebar.tsx:
 *   - renders the "All" row and one <li> per source
 *   - active state is driven by usePathname (exact match)
 *   - cover image renders when coverUrl is present; monogram fallback otherwise
 *   - cover image onError falls back to the monogram
 *   - accessibility: nav landmark, <ul role="list">
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, fireEvent } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

import { usePathname } from "next/navigation"
import { Sidebar, type SidebarSource } from "@/components/layout/sidebar"
import { SidebarTreeProvider } from "@/components/layout/sidebar-tree-provider"

const baseSources: SidebarSource[] = [
  { id: "feed-1", name: "The Verge", type: "RSS", coverUrl: "https://example.com/verge.png", faviconUrl: null, inboxCount: 0, folderId: null },
  { id: "feed-2", name: "Durov's Channel", type: "TELEGRAM", coverUrl: null, faviconUrl: null, inboxCount: 0, folderId: null },
  { id: "feed-3", name: "Anthropic", type: "TWITTER", coverUrl: null, faviconUrl: null, inboxCount: 0, folderId: null },
  { id: "feed-4", name: "AI monitor", type: "EVENT_TRIGGER", coverUrl: null, faviconUrl: null, inboxCount: 0, folderId: null },
]

function setPathname(path: string) {
  vi.mocked(usePathname).mockReturnValue(path)
}

function renderSidebar(sources: SidebarSource[], id?: string) {
  return render(
    <SidebarTreeProvider folders={[]} sources={sources} collapsed={[]}>
      <Sidebar instanceId="desktop" id={id} />
    </SidebarTreeProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Sidebar — rendering", () => {
  it("renders as a navigation landmark named 'Sources and folders'", () => {
    setPathname("/posts")
    renderSidebar(baseSources)
    const nav = screen.getByRole("navigation", { name: "Sources and folders" })
    expect(nav).toBeInTheDocument()
  })

  it("accepts an id prop so multiple instances (desktop + mobile) can coexist", () => {
    setPathname("/posts")
    renderSidebar(baseSources, "sidebar-test-id")
    const nav = screen.getByRole("navigation", { name: "Sources and folders" })
    expect(nav.id).toBe("sidebar-test-id")
  })

  it("always renders the 'All' row linked to /posts", () => {
    setPathname("/feeds/feed-1")
    renderSidebar(baseSources)
    const allLink = screen.getByRole("link", { name: /all/i })
    expect(allLink).toHaveAttribute("href", "/posts")
  })

  it("renders one list item per source with the correct feed href", () => {
    setPathname("/posts")
    renderSidebar(baseSources)

    for (const source of baseSources) {
      const link = screen.getByRole("link", { name: new RegExp(source.name, "i") })
      expect(link).toHaveAttribute("href", `/feeds/${source.id}`)
    }
    // Folders section is empty; the sources are the only rendered rows.
    const lists = screen.getAllByRole("list")
    const sourceRows = lists.flatMap(list => Array.from(list.querySelectorAll("li")))
    expect(sourceRows).toHaveLength(baseSources.length)
  })

  it("renders no SOURCES section header when the list is empty", () => {
    setPathname("/posts")
    renderSidebar([])
    expect(screen.queryByText("Sources")).not.toBeInTheDocument()
    // "All" row still visible
    expect(screen.getByRole("link", { name: /all/i })).toBeInTheDocument()
  })
})

describe("Sidebar — active state", () => {
  it("marks 'All' as aria-current='page' when pathname is /posts", () => {
    setPathname("/posts")
    renderSidebar(baseSources)
    const allLink = screen.getByRole("link", { name: /all/i })
    expect(allLink).toHaveAttribute("aria-current", "page")
  })

  it("marks a source row as aria-current='page' when pathname matches /feeds/[id]", () => {
    setPathname("/feeds/feed-2")
    renderSidebar(baseSources)
    const activeLink = screen.getByRole("link", { name: /durov/i })
    expect(activeLink).toHaveAttribute("aria-current", "page")
    // All row is NOT active
    expect(screen.getByRole("link", { name: /all/i })).not.toHaveAttribute("aria-current")
  })

  it("does NOT treat /feeds/[id]/edit as an active source (exact-match)", () => {
    setPathname("/feeds/feed-2/edit")
    renderSidebar(baseSources)
    for (const source of baseSources) {
      const link = screen.getByRole("link", { name: new RegExp(source.name, "i") })
      expect(link).not.toHaveAttribute("aria-current")
    }
  })
})

describe("Sidebar — source cover + monogram fallback", () => {
  it("renders an <img> when coverUrl is provided", () => {
    setPathname("/posts")
    renderSidebar([baseSources[0]])
    // The Verge has a coverUrl in the fixture
    const img = document.querySelector("img[src='https://example.com/verge.png']")
    expect(img).not.toBeNull()
  })

  it("renders the monogram fallback when coverUrl is null", () => {
    setPathname("/posts")
    renderSidebar([baseSources[1]]) // Durov's Channel — coverUrl null
    // Monogram uses the first character of the name, uppercase
    expect(screen.getByText("D")).toBeInTheDocument()
  })

  it("falls back to the monogram when the cover image errors out", () => {
    setPathname("/posts")
    renderSidebar([baseSources[0]])

    const img = document.querySelector("img[src='https://example.com/verge.png']") as HTMLImageElement | null
    expect(img).not.toBeNull()

    // Simulate the <img> failing to load
    fireEvent.error(img!)

    // Monogram fallback now visible
    expect(screen.getByText("T")).toBeInTheDocument()
    // And the <img> is gone
    expect(document.querySelector("img[src='https://example.com/verge.png']")).toBeNull()
  })
})
