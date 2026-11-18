/** @vitest-environment jsdom */

/**
 * RAD-355 — the house NumberFlow wrapper.
 *
 * `@number-flow/react` is not inert outside a browser: its hook reads
 * `matchMedia(...).matches` during render, so mounting it in jsdom throws
 * outright (measured — `Cannot read properties of null`). The wrapper therefore
 * gates on `supportsNumberRoll()` before it ever renders the library, and these
 * tests pin that fallback plus the call-site contract: the value is the site's
 * own formatting (no locale separators), it stays tabular, and the caller's
 * class renders.
 *
 * The animated path itself needs a real engine — it is verified by the DPR-2
 * pixel measurement recorded on RAD-355, not here. What the wrapper *asks* the
 * library to render is pinned in `morph-number-roll.test.tsx`, with the gate and
 * the library stubbed, because that is where the locale-grouping defect lived
 * (RAD-357).
 */

import { describe, it, expect } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { MorphNumber } from "@/components/ui/morph-number"
import { supportsNumberRoll } from "@/lib/motion"

describe("in an environment that cannot roll", () => {
  it("reports itself as unable to roll", () => {
    expect(supportsNumberRoll()).toBe(false)
  })

  it("renders plain text — no custom element, no shadow host", () => {
    const { container } = render(<MorphNumber value={1271} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe("SPAN")
    expect(root.textContent).toBe("1271")
    expect(container.querySelector("number-flow-react")).toBeNull()
  })

  it("survives an update and an unmount", () => {
    const { container, rerender, unmount } = render(<MorphNumber value={1} />)
    expect(() => rerender(<MorphNumber value={2} />)).not.toThrow()
    expect(container.textContent).toBe("2")
    expect(() => unmount()).not.toThrow()
  })
})

describe("call-site contract", () => {
  it("keeps the caller's class and figures tabular", () => {
    const { container } = render(<MorphNumber value={7} className="font-semibold" />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass("font-semibold")
    expect(root).toHaveClass("type-counter")
  })

  it("renders the raw digits", () => {
    // The fallback interpolates the number as a React text node, so no
    // formatter runs here at all — the locale-grouping trap RAD-357 fixed lives
    // on the *roll* path and is pinned in morph-number-roll.test.tsx.
    render(<MorphNumber value={1271} />)
    expect(screen.getByText("1271")).toBeInTheDocument()
  })
})
