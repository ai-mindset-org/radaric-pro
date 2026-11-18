/** @vitest-environment jsdom */

/**
 * RAD-357 — the roll path, which jsdom cannot reach on its own.
 *
 * `MorphNumber` renders plain text wherever a roll cannot run, and jsdom is one
 * of those places, so `__tests__/components/morph-number.test.tsx` only ever
 * exercises the fallback. The props the wrapper hands the library are therefore
 * untested there — and that is exactly where the locale-grouping defect lived:
 * with no `format`, `@number-flow/react` builds `new Intl.NumberFormat(undefined,
 * undefined)`, whose `useGrouping` default paints 1271 as "1,271", breaking the
 * site's digits-only rule and disagreeing with the `sr-only` twin that carries
 * the announcement.
 *
 * So: stub the gate open and the library itself, and assert what it is asked to
 * render. The library's own animation is not simulated — that is the DPR-2
 * pixel measurement recorded on RAD-355, not a jsdom concern.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"

const spy = vi.hoisted(() => ({ captured: null as Record<string, unknown> | null }))

vi.mock("@number-flow/react", () => ({
  default: (props: Record<string, unknown>) => {
    spy.captured = props
    return null
  },
}))

vi.mock("@/lib/motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/motion")>()
  return { ...actual, supportsNumberRoll: () => true, prefersReducedMotion: () => false }
})

import { MorphNumber } from "@/components/ui/morph-number"

beforeEach(() => {
  spy.captured = null
})

describe("where a roll can run", () => {
  it("asks the library for digits only, never locale separators", () => {
    render(<MorphNumber value={1271} />)

    expect(spy.captured?.value).toBe(1271)
    expect(spy.captured?.format).toEqual({ useGrouping: false })
  })

  it("keeps the caller's class and the line-box hook", () => {
    render(<MorphNumber value={7} className="font-semibold" />)

    expect(spy.captured?.className).toContain("font-semibold")
    expect(spy.captured?.className).toContain("morph-number")
    expect(spy.captured?.className).toContain("type-counter")
  })

  it("drives the roll off the motion tokens, not literals", () => {
    render(<MorphNumber value={7} />)

    const transform = spy.captured?.transformTiming as { duration: number; easing: string }
    const opacity = spy.captured?.opacityTiming as { duration: number; easing: string }
    expect(transform.duration).toBeGreaterThan(0)
    expect(transform.easing).toContain("cubic-bezier")
    expect(opacity.duration).toBeGreaterThan(0)
    // No spin override: the library falls back to `transformTiming`, which is
    // what makes a jump of more than one roll through the digits.
    expect(spy.captured?.spinTiming).toBeUndefined()
  })
})
