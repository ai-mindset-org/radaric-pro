/**
 * @vitest-environment jsdom
 */

/**
 * RAD-382 — the header sidebar toggle reports the region that is actually on
 * screen. At phone width the persisted desktop-sidebar state (default true) is
 * irrelevant, so a closed drawer must read "Open sidebar" / aria-expanded=false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, fireEvent, act, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  usePathname: () => "/posts",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { username: "testuser", role: "USER" } } }),
  signOut: vi.fn(),
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}))

import { DashboardShell } from "@/components/layout/dashboard-shell"

/** Controllable matchMedia: `(min-width: 768px)` matches iff `desktop` is true. */
function installViewport(initialDesktop: boolean) {
  let desktop = initialDesktop
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  window.matchMedia = ((query: string) => ({
    get matches() {
      return desktop
    },
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia
  return {
    resize(nextDesktop: boolean) {
      desktop = nextDesktop
      act(() => {
        listeners.forEach((cb) => cb({ matches: nextDesktop } as MediaQueryListEvent))
      })
    },
  }
}

function renderShell(initialSidebarOpen: boolean) {
  const view = render(
    <DashboardShell
      initialSidebarOpen={initialSidebarOpen}
      sources={[]}
      folders={[]}
      initialCollapsedFolders={[]}
    >
      <div>content</div>
    </DashboardShell>
  )
  // Query by structure, not role: an open Radix drawer aria-hides everything
  // outside it, which would hide the header toggle from getByRole.
  const toggle = () => view.container.querySelector("header button[aria-controls]") as HTMLButtonElement
  return { ...view, toggle }
}

let fetchMock: ReturnType<typeof vi.fn>

/** Calls to the sidebar-state route. The shell also polls /api/stats, so filter by URL. */
function uiStateCalls() {
  return fetchMock.mock.calls.filter(([input]) => input === "/api/ui-state")
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn().mockResolvedValue({ ok: false })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DashboardShell — sidebar toggle a11y state (RAD-382)", () => {
  it("phone, drawer closed, persisted desktop state open: reads 'Open sidebar', expanded=false", () => {
    installViewport(false)
    const { toggle } = renderShell(true)
    expect(toggle()).toHaveAttribute("aria-label", "Open sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
  })

  it("phone: opening the drawer flips the toggle to 'Close sidebar' / expanded=true, closing flips it back", () => {
    installViewport(false)
    const { toggle } = renderShell(true)

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-label", "Close sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "true")

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-label", "Open sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
  })

  it("phone: toggling the drawer does not persist the desktop sidebar state", () => {
    installViewport(false)
    const { toggle } = renderShell(true)
    fireEvent.click(toggle())
    expect(uiStateCalls()).toHaveLength(0)
  })

  it("desktop, sidebar open: reads 'Close sidebar', expanded=true; click collapses and persists", () => {
    installViewport(true)
    const { toggle } = renderShell(true)
    expect(toggle()).toHaveAttribute("aria-label", "Close sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "true")

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute("aria-label", "Open sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    // Persisted through a keepalive fetch to the route handler — never a server
    // action, whose cookie write refreshes the route and re-renders the grid
    // mid-toggle (RAD-408).
    expect(uiStateCalls()).toHaveLength(1)
    const [, init] = uiStateCalls()[0] as [string, RequestInit]
    expect(init).toMatchObject({ method: "POST", keepalive: true })
    expect(JSON.parse(init.body as string)).toEqual({ sidebarOpen: false })
  })

  it("desktop, sidebar collapsed: reads 'Open sidebar', expanded=false", () => {
    installViewport(true)
    const { toggle } = renderShell(false)
    expect(toggle()).toHaveAttribute("aria-label", "Open sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
  })

  it("follows the viewport when it crosses the breakpoint", () => {
    const viewport = installViewport(true)
    const { toggle } = renderShell(true)
    expect(toggle()).toHaveAttribute("aria-expanded", "true")

    expect(toggle()).toHaveAttribute("aria-controls", "app-sidebar-desktop")

    viewport.resize(false)
    expect(toggle()).toHaveAttribute("aria-label", "Open sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(toggle()).toHaveAttribute("aria-controls", "app-sidebar-mobile")

    viewport.resize(true)
    expect(toggle()).toHaveAttribute("aria-label", "Close sidebar")
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(toggle()).toHaveAttribute("aria-controls", "app-sidebar-desktop")
  })
})
