/** @vitest-environment jsdom */

/**
 * RAD-341 — the house torph wrapper.
 *
 * jsdom has no WAAPI and no matchMedia, and torph is not merely inert there:
 * its constructor reads `matchMedia` unconditionally (reduced-motion listener)
 * and `destroy()` calls `getAnimations()`. `disabled` cannot cover either, so
 * the wrapper must not construct the component at all outside a real engine.
 * These tests pin that fallback plus the call-site contract: numbers never
 * gain locale separators, numeric values stay tabular, and the caller's
 * element/class is what renders.
 */

import { describe, it, expect, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { act, render, screen } from "@testing-library/react"
import { MorphText } from "@/components/ui/morph-text"
import { supportsMorphAnimation } from "@/lib/motion"

describe("in an environment that cannot animate", () => {
  it("reports itself as unable to morph", () => {
    expect(supportsMorphAnimation()).toBe(false)
  })

  it("renders plain text — no torph root, no fragments", () => {
    const { container } = render(<MorphText>{1271}</MorphText>)
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe("SPAN")
    expect(root.textContent).toBe("1271")
    expect(root.hasAttribute("torph-root")).toBe(false)
  })

  it("survives a second update and an unmount (where torph.destroy would throw)", () => {
    const { container, rerender, unmount } = render(<MorphText>{1}</MorphText>)
    expect(() => rerender(<MorphText>{2}</MorphText>)).not.toThrow()
    expect(container.textContent).toBe("2")
    expect(() => unmount()).not.toThrow()
  })
})

describe("call-site contract", () => {
  it("renders the element and class the caller asked for", () => {
    const { container } = render(
      <MorphText as="dd" className="font-semibold">
        7
      </MorphText>
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe("DD")
    expect(root).toHaveClass("font-semibold")
  })

  it("never lets a numeric child pick up locale separators", () => {
    render(<MorphText>{1271}</MorphText>)
    expect(screen.getByText("1271")).toBeInTheDocument()
  })

  it("makes numeric children counters (tabular figures) by default", () => {
    const { container } = render(<MorphText>{1271}</MorphText>)
    expect(container.firstElementChild).toHaveClass("type-counter")
  })

  it("keeps textual children out of the counter role", () => {
    const { container } = render(<MorphText>Grouping stories</MorphText>)
    expect(container.firstElementChild).not.toHaveClass("type-counter")
    expect(container.firstElementChild).not.toHaveClass("tabular-nums")
  })
})

describe("coalescing", () => {
  it("updates immediately when no window is asked for", () => {
    const { container, rerender } = render(<MorphText>{1}</MorphText>)
    rerender(<MorphText>{2}</MorphText>)
    expect(container.textContent).toBe("2")
  })

  it("lands the latest value once the window closes", () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<MorphText coalesceMs={120}>{1}</MorphText>)
      rerender(<MorphText coalesceMs={120}>{2}</MorphText>)
      rerender(<MorphText coalesceMs={120}>{3}</MorphText>)
      rerender(<MorphText coalesceMs={120}>{4}</MorphText>)
      expect(container.textContent).toBe("1")
      act(() => {
        vi.advanceTimersByTime(120)
      })
      expect(container.textContent).toBe("4")
      rerender(<MorphText coalesceMs={120}>{5}</MorphText>)
      expect(container.textContent).toBe("4")
      act(() => {
        vi.advanceTimersByTime(120)
      })
      expect(container.textContent).toBe("5")
    } finally {
      vi.useRealTimers()
    }
  })
})
