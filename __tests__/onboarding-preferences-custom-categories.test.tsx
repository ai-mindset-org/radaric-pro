// @vitest-environment jsdom

/**
 * PreferencesPage custom category input — unit tests
 *
 * After RAD-216 the page delegates to the shared `ContentCategoryPicker`
 * component, which keeps each input's value in local state. This removes
 * BUG-9 (shared `ci`) by construction and closes the onBlur/click race
 * on the confirm button that shipped with the inline implementation.
 *
 * Legacy BUG-9 coverage is still exercised against the new component:
 *
 *   AC-1  Opening liked input while disliked is open (with text typed) does not submit
 *          the typed text to the disliked section — the disliked input is discarded
 *   AC-2  Opening disliked input while liked is open (with text typed) does not submit
 *          the typed text to the liked section — the liked input is discarded
 *   AC-3  After cancelling with Escape, the new input starts empty
 *   AC-4  RAD-216: clicking the ✓ Confirm button adds the typed value and closes the input
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

// ─── next/navigation mock ────────────────────────────────────────────────────

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

// ─── content-categories mock ─────────────────────────────────────────────────

vi.mock("@/lib/content-categories", () => ({
  LIKED_CATEGORIES: ["Articles"],
  DISLIKED_CATEGORIES: ["Ads"],
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

// ─── page import (after mocks) ───────────────────────────────────────────────

import PreferencesPage from "@/app/onboarding/preferences/page"

// ─── helpers ─────────────────────────────────────────────────────────────────

function renderPage() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))
  return render(<PreferencesPage />)
}

/**
 * Returns text content of all category pill buttons inside a given aria group,
 * excluding the "Add custom" button and the inline confirm/cancel icon buttons.
 */
function getCategoryLabels(groupName: RegExp): string[] {
  const groups = screen.getAllByRole("group", { name: groupName })
  const group = groups[0]
  return Array.from(group.querySelectorAll("button"))
    .filter(btn => {
      const text = btn.textContent?.trim() ?? ""
      // Exclude "Add custom" button and icon-only confirm/cancel buttons
      return text !== "" && !text.includes("Add custom") && btn.textContent !== ""
        && btn.querySelector("svg.lucide-check") === null
        && btn.querySelector("svg.lucide-x") === null
    })
    .map(btn => btn.textContent?.trim() ?? "")
}

// ─── tests ───────────────────────────────────────────────────────────────────

const LIKED_GROUP = /i want to see/i
const DISLIKED_GROUP = /i don't want to see/i

describe("PreferencesPage — custom category inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("AC-2: switching from liked to disliked does NOT accidentally submit typed text to liked section", async () => {
    renderPage()
    const user = userEvent.setup({ delay: null })

    const [likedAdd, dislikedAdd] = screen.getAllByRole("button", { name: /add.*category/i })

    await user.click(likedAdd)
    const likedTextbox = screen.getByRole("textbox")
    await user.type(likedTextbox, "Deep Dives")
    expect(likedTextbox).toHaveValue("Deep Dives")

    // Opening the other section must not commit the typed liked value.
    await user.click(dislikedAdd)

    const likedLabels = getCategoryLabels(LIKED_GROUP)
    expect(likedLabels).not.toContain("Deep Dives")
  })

  it("AC-1: switching from disliked to liked does NOT accidentally submit typed text to disliked section", async () => {
    renderPage()
    const user = userEvent.setup({ delay: null })

    const [likedAdd, dislikedAdd] = screen.getAllByRole("button", { name: /add.*category/i })

    await user.click(dislikedAdd)
    const dislikedTextbox = screen.getByRole("textbox")
    await user.type(dislikedTextbox, "Nonsense Tag")
    expect(dislikedTextbox).toHaveValue("Nonsense Tag")

    await user.click(likedAdd)

    const dislikedLabels = getCategoryLabels(DISLIKED_GROUP)
    expect(dislikedLabels).not.toContain("Nonsense Tag")
  })

  it("AC-3: after cancelling via Escape, opening the other section starts empty", async () => {
    renderPage()
    const user = userEvent.setup({ delay: null })

    const [likedAdd, dislikedAdd] = screen.getAllByRole("button", { name: /add.*category/i })

    await user.click(likedAdd)
    const likedTextbox = screen.getByRole("textbox")
    await user.type(likedTextbox, "Essays")
    expect(likedTextbox).toHaveValue("Essays")

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

    await user.click(dislikedAdd)

    await waitFor(() => {
      const dislikedTextbox = screen.getByRole("textbox")
      expect(dislikedTextbox).toHaveValue("")
    })
  })

  it("AC-4 (RAD-216): clicking the ✓ confirm button adds the typed value and closes the input", async () => {
    renderPage()
    const user = userEvent.setup({ delay: null })

    const [likedAdd] = screen.getAllByRole("button", { name: /add.*category/i })
    await user.click(likedAdd)

    const input = screen.getByRole("textbox")
    await user.type(input, "Tournaments")
    expect(input).toHaveValue("Tournaments")

    const confirm = screen.getByRole("button", { name: /^confirm$/i })
    await user.click(confirm)

    const likedLabels = getCategoryLabels(LIKED_GROUP)
    expect(likedLabels).toContain("Tournaments")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })
})
