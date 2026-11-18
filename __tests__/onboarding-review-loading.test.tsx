// @vitest-environment jsdom

/**
 * BUG-6: Review page loading skeleton
 *
 * Tests that ReviewFeedsPage shows a skeleton while fetching, not a blank page:
 *   AC-1  While loading, the container has aria-busy="true"
 *   AC-2  While loading, skeleton placeholder elements with animate-pulse are visible
 *   AC-3  After feeds load, aria-busy is gone, skeleton disappears, feeds are rendered
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import React from "react"

// ─── next/navigation mock ────────────────────────────────────────────────────

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

// ─── sonner mock ─────────────────────────────────────────────────────────────

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

// ─── sessionStorage stub ─────────────────────────────────────────────────────

Object.defineProperty(globalThis, "sessionStorage", {
  value: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() },
  writable: true,
})

// ─── Import page after mocks ─────────────────────────────────────────────────

import ReviewFeedsPage from "@/app/onboarding/review/page"
import type { ExtractedFeed } from "@/lib/onboarding-types"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockFeeds: ExtractedFeed[] = [
  { url: "https://example.com/feed.xml", name: "Example Blog", type: "RSS", status: "found", feedUrl: "https://example.com/feed.xml" },
  { url: "https://t.me/s/techcabal", name: "TechCabal", type: "TELEGRAM", status: "found" },
]

function makeNeverResolvingFetch() {
  return vi.fn().mockReturnValue(new Promise<Response>(() => { /* intentionally never resolves */ }))
}

function makeResolvedFetch(feeds: ExtractedFeed[]) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        onboardingState: {
          version: 1,
          step: "review",
          extractedFeeds: feeds,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ReviewFeedsPage — loading skeleton (BUG-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPush.mockReset()
    ;(globalThis.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null)
  })

  it("AC-1: container has aria-busy='true' while fetch is in-flight", async () => {
    vi.stubGlobal("fetch", makeNeverResolvingFetch())

    render(<ReviewFeedsPage />)

    // Immediately — fetch has not resolved, skeleton should be shown
    const busyContainer = document.querySelector("[aria-busy='true']")
    expect(busyContainer).not.toBeNull()
    expect(busyContainer).toBeInTheDocument()
  })

  it("AC-2: skeleton elements with animate-pulse class are visible while loading", async () => {
    vi.stubGlobal("fetch", makeNeverResolvingFetch())

    render(<ReviewFeedsPage />)

    // animate-pulse elements must exist during loading state
    const pulseElements = document.querySelectorAll(".animate-pulse")
    expect(pulseElements.length).toBeGreaterThan(0)
  })

  it("AC-3: aria-busy='true' is present immediately, then feeds render and aria-busy is removed", async () => {
    let resolveResponse!: (value: Response) => void
    const controlledFetch = vi.fn().mockReturnValue(
      new Promise<Response>(resolve => { resolveResponse = resolve })
    )
    vi.stubGlobal("fetch", controlledFetch)

    render(<ReviewFeedsPage />)

    // Phase 1: before fetch resolves, aria-busy must be set
    const busyBeforeLoad = document.querySelector("[aria-busy='true']")
    expect(busyBeforeLoad).not.toBeNull()

    // Phase 2: resolve the fetch with real feed data
    await act(async () => {
      resolveResponse(
        new Response(
          JSON.stringify({
            onboardingState: { version: 1, step: "review", extractedFeeds: mockFeeds },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    })

    // Phase 3: feeds rendered, aria-busy gone
    await waitFor(() => {
      expect(screen.getByText("Example Blog")).toBeInTheDocument()
    })

    const busyAfterLoad = document.querySelector("[aria-busy='true']")
    expect(busyAfterLoad).toBeNull()
  })
})
