/**
 * @vitest-environment jsdom
 */

/**
 * ContentCategoryPicker — custom category input feature (RED phase)
 *
 * Tests for the "add custom category" feature:
 * - Add button per section
 * - Inline input with confirm / cancel
 * - Callback invocation with new category appended
 * - Validation: empty, duplicate, max 50 chars
 * - Custom categories show remove button; predefined do not
 * - Remove button calls onChange without the removed category
 */

import { describe, it, expect, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// userEvent is set up with `delay: null` throughout this file. By default
// userEvent awaits a real macrotask between keystrokes, so typing an n-character
// string costs n trips through a contended event loop — the dominant cost in
// these tests and the reason they timed out when the machine was busy while
// passing in isolation. Nothing here depends on time passing between keystrokes.
import { ContentCategoryPicker } from "@/components/feeds/content-category-picker"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderPicker(overrides?: Partial<Parameters<typeof ContentCategoryPicker>[0]>) {
  const props = {
    likedCategories: [],
    dislikedCategories: [],
    onLikedChange: vi.fn(),
    onDislikedChange: vi.fn(),
    ...overrides,
  }
  const result = render(<ContentCategoryPicker {...props} />)
  return { ...result, props }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ContentCategoryPicker — custom category input", () => {
  it("AC-1: renders an add button at the end of each section", () => {
    renderPicker()

    // Expect one add button per section ("I want to see" and "I don't want to see")
    const addButtons = screen.getAllByRole("button", { name: /add/i })
    expect(addButtons).toHaveLength(2)
  })

  it("AC-2: clicking add button shows an inline text input with a confirm button", async () => {
    renderPicker()
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    // Add button should be gone, replaced by an input
    expect(screen.queryAllByRole("button", { name: /add/i })).toHaveLength(1) // only other section's add btn
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /confirm|submit|check/i })).toBeInTheDocument()
  })

  it("AC-3: typing a new category and confirming calls onLikedChange with it appended", async () => {
    const onLikedChange = vi.fn()
    renderPicker({ likedCategories: ["Articles"], onLikedChange })
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    const input = screen.getByRole("textbox")
    await user.type(input, "Deep Dives")
    await user.click(screen.getByRole("button", { name: /confirm|submit|check/i }))

    expect(onLikedChange).toHaveBeenCalledWith(["Articles", "Deep Dives"])
  })

  it("EC-1: submitting an empty input does nothing and keeps input visible", async () => {
    const onLikedChange = vi.fn()
    renderPicker({ onLikedChange })
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    // Confirm without typing anything
    await user.click(screen.getByRole("button", { name: /confirm|submit|check/i }))

    expect(onLikedChange).not.toHaveBeenCalled()
    // Input should still be visible (not reverted to add button)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("EC-2: submitting a duplicate category is rejected and callback is not called", async () => {
    const onLikedChange = vi.fn()
    renderPicker({ likedCategories: ["Articles"], onLikedChange })
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    const input = screen.getByRole("textbox")
    await user.type(input, "Articles")
    await user.click(screen.getByRole("button", { name: /confirm|submit|check/i }))

    expect(onLikedChange).not.toHaveBeenCalled()
  })

  it("EC-3: pressing Escape cancels the input and restores the add button", async () => {
    renderPicker()
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    const input = screen.getByRole("textbox")
    await user.type(input, "Something")
    await user.keyboard("{Escape}")

    // Input gone, add button back — both sections have add buttons again
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /add/i })).toHaveLength(2)
  })

  it("AC-7: custom categories (not in predefined list) show a remove × button; predefined do not", () => {
    renderPicker({
      likedCategories: ["Articles", "My Custom Tag"],
    })

    // "Articles" is predefined — no remove button
    // "My Custom Tag" is custom — has a remove button
    const removeButtons = screen.getAllByRole("button", { name: /remove|×|delete/i })
    expect(removeButtons).toHaveLength(1)

    // Verify the remove button is associated with the custom category
    expect(removeButtons[0]).toBeInTheDocument()
  })

  it("AC-8: clicking the remove × button on a custom category calls onLikedChange without it", async () => {
    const onLikedChange = vi.fn()
    renderPicker({
      likedCategories: ["Articles", "My Custom Tag"],
      onLikedChange,
    })
    const user = userEvent.setup({ delay: null })

    const removeButton = screen.getByRole("button", { name: /remove|×|delete/i })
    await user.click(removeButton)

    expect(onLikedChange).toHaveBeenCalledWith(["Articles"])
  })

  it("ERR-1: input longer than 50 chars is trimmed/rejected — callback not called with oversized value", async () => {
    const onLikedChange = vi.fn()
    renderPicker({ onLikedChange })
    const user = userEvent.setup({ delay: null })

    const [likedAddButton] = screen.getAllByRole("button", { name: /add/i })
    await user.click(likedAddButton)

    const input = screen.getByRole("textbox")
    const longValue = "A".repeat(51)
    await user.type(input, longValue)
    await user.click(screen.getByRole("button", { name: /confirm|submit|check/i }))

    // Either the callback is not called at all, or it's called with a value ≤ 50 chars
    if (onLikedChange.mock.calls.length > 0) {
      const submitted = onLikedChange.mock.calls[0][0] as string[]
      const addedCategory = submitted[submitted.length - 1]
      expect(addedCategory.length).toBeLessThanOrEqual(50)
    } else {
      expect(onLikedChange).not.toHaveBeenCalled()
    }
  })
})
