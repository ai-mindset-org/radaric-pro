// @vitest-environment jsdom

/**
 * BUG-7: Preferences back button conditional destination
 *
 * The "Back" button on /onboarding/preferences currently always navigates
 * to /onboarding/review. It should navigate to /onboarding/feeds when the
 * user has no feeds in sessionStorage (i.e., they skipped feed import).
 *
 *   AC-1  Back navigates to /onboarding/feeds when sessionStorage has no feeds (null)
 *   AC-2  Back navigates to /onboarding/review when sessionStorage has feeds (non-empty array)
 *   EC-1  Back navigates to /onboarding/feeds when sessionStorage has an empty array "[]"
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// userEvent is set up with `delay: null` throughout this file. By default
// userEvent awaits a real macrotask between keystrokes, so typing an n-character
// string costs n trips through a contended event loop — the dominant cost in
// these tests and the reason they timed out when the machine was busy while
// passing in isolation. Nothing here depends on time passing between keystrokes.
import React from "react"

// ─── next/navigation mock ─────────────────────────────────────────────────────

const mockPush = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

// ─── content-categories mock ──────────────────────────────────────────────────
// The page imports LIKED_CATEGORIES and DISLIKED_CATEGORIES. Mock them so the
// test doesn't depend on the real file contents or any side effects.

vi.mock("@/lib/content-categories", () => ({
  LIKED_CATEGORIES: ["Articles", "Tutorials"],
  DISLIKED_CATEGORIES: ["Ads", "Clickbait"],
}))

// ─── sessionStorage mock ──────────────────────────────────────────────────────

const mockGetItem = vi.fn()
const mockSetItem = vi.fn()

Object.defineProperty(globalThis, "sessionStorage", {
  value: { getItem: mockGetItem, setItem: mockSetItem },
  writable: true,
})

// ─── fetch stub (page may call fetch on mount; stub to avoid unhandled errors) ─

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))

// ─── page under test ──────────────────────────────────────────────────────────

import PreferencesPage from "@/app/onboarding/preferences/page"

// ─── helpers ──────────────────────────────────────────────────────────────────

async function renderAndClickBack() {
  render(<PreferencesPage />)

  // The Back button contains an ArrowLeft icon and the text "Back"
  const backButton = await screen.findByRole("button", { name: /back/i })
  const user = userEvent.setup({ delay: null })
  await user.click(backButton)
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("PreferencesPage — Back button destination", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPush.mockReset()
  })

  it("AC-1: navigates to /onboarding/feeds when sessionStorage has no feeds (null)", async () => {
    // null = user never visited the feeds step (skipped import entirely)
    mockGetItem.mockReturnValue(null)

    await renderAndClickBack()

    expect(mockPush).toHaveBeenCalledWith("/onboarding/feeds")
    expect(mockPush).not.toHaveBeenCalledWith("/onboarding/review")
  })

  it("AC-2: navigates to /onboarding/review when sessionStorage has feeds (non-empty array)", async () => {
    // A non-empty JSON array means the user went through feed import
    mockGetItem.mockReturnValue(
      JSON.stringify([{ url: "https://example.com/feed.xml", name: "Example", type: "RSS", status: "found" }])
    )

    await renderAndClickBack()

    expect(mockPush).toHaveBeenCalledWith("/onboarding/review")
    expect(mockPush).not.toHaveBeenCalledWith("/onboarding/feeds")
  })

  it("EC-1: navigates to /onboarding/feeds when sessionStorage has an empty array (no feeds imported)", async () => {
    // "[]" = user visited feeds step but added nothing — treat same as skipped
    mockGetItem.mockReturnValue("[]")

    await renderAndClickBack()

    expect(mockPush).toHaveBeenCalledWith("/onboarding/feeds")
    expect(mockPush).not.toHaveBeenCalledWith("/onboarding/review")
  })
})
