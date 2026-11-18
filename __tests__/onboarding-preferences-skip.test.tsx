// @vitest-environment jsdom

/**
 * BUG-8: Preferences skip() error handling
 *
 * The `skip()` function has no error handling. If PATCH fails, user navigates
 * to /posts with onboardingCompleted still false → redirect loop.
 *
 *   AC-1  When skip() API call fails, toast.error() is shown with
 *         "Couldn't save your settings. Please try again."
 *   AC-2  When skip() fails, navigation to /posts does NOT happen
 *   AC-3  Both "Start Radaric" and "Skip for now" buttons are disabled while
 *         either save or skip is in progress
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
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

// ─── sonner mock ──────────────────────────────────────────────────────────────

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

// ─── content-categories mock ──────────────────────────────────────────────────

vi.mock("@/lib/content-categories", () => ({
  LIKED_CATEGORIES: ["Articles", "Tutorials"],
  DISLIKED_CATEGORIES: ["Ads", "Clickbait"],
}))

// ─── PhaseIndicator mock (server component dependency) ───────────────────────

vi.mock("@/components/onboarding/phase-indicator", () => ({
  PhaseIndicator: () => null,
}))

// ─── Import toast after mock is defined ──────────────────────────────────────

import { toast } from "sonner"

// ─── Component under test ─────────────────────────────────────────────────────

import PreferencesPage from "@/app/onboarding/preferences/page"

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PreferencesPage — skip() error handling (BUG-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPush.mockReset()
  })

  it("AC-1: skip() fetch failure shows toast.error with exact message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network Error")))
    const user = userEvent.setup({ delay: null })

    render(<PreferencesPage />)

    const skipButton = screen.getByRole("button", { name: /skip for now/i })
    await user.click(skipButton)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't save your settings. Please try again."
      )
    })
  })

  it("AC-2: skip() non-ok response does NOT navigate to /posts", async () => {
    // Use a non-ok response (not a rejection) so the unhandled promise does not
    // pollute the test environment. The bug: skip() navigates regardless of r.ok.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    )
    const user = userEvent.setup({ delay: null })

    render(<PreferencesPage />)

    const skipButton = screen.getByRole("button", { name: /skip for now/i })
    await user.click(skipButton)

    // Give async side-effects time to settle
    await new Promise(r => setTimeout(r, 100))

    // Bug: skip() always calls router.push regardless of response
    expect(mockPush).not.toHaveBeenCalledWith("/posts")
  })

  it("AC-3: 'Skip for now' button is disabled while skip is in progress", async () => {
    // Never resolves → keeps component in loading state
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})))
    const user = userEvent.setup({ delay: null })

    render(<PreferencesPage />)

    const skipButton = screen.getByRole("button", { name: /skip for now/i })
    await user.click(skipButton)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /skip for now/i })).toBeDisabled()
    })
  })

  it("AC-3: 'Start Radaric' button is disabled while skip is in progress", async () => {
    // Never resolves → keeps component in loading state
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})))
    const user = userEvent.setup({ delay: null })

    render(<PreferencesPage />)

    const skipButton = screen.getByRole("button", { name: /skip for now/i })
    await user.click(skipButton)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start radaric/i })).toBeDisabled()
    })
  })

  it("AC-3: 'Skip for now' button is disabled while save (Start Radaric) is in progress", async () => {
    // Never resolves → keeps component in loading state
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})))
    const user = userEvent.setup({ delay: null })

    render(<PreferencesPage />)

    const saveButton = screen.getByRole("button", { name: /start radaric/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /skip for now/i })).toBeDisabled()
    })
  })
})
