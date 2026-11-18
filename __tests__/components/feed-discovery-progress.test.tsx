/**
 * RAD-354 — onboarding's "N of M" discovery count is plain text.
 *
 * A morph root next to a static multi-digit number paints its digits with a
 * different advance (RAD-353), so the two digit runs on one line read with
 * different gaps. The visible copy is also the announced copy: one live region,
 * no aria-hidden twin.
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, cleanup } from "@testing-library/react"
import { FeedDiscoveryProgress } from "@/components/onboarding/feed-discovery-progress"
import type { ExtractedFeed } from "@/lib/onboarding-types"

afterEach(cleanup)

function feeds(found: number, pending: number): ExtractedFeed[] {
  const make = (i: number, status: ExtractedFeed["status"]) =>
    ({ name: `Feed ${i}`, type: "RSS", status }) as ExtractedFeed
  return [
    ...Array.from({ length: found }, (_, i) => make(i, "found")),
    ...Array.from({ length: pending }, (_, i) => make(found + i, "pending")),
  ]
}

function counter(container: HTMLElement): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>("p[aria-live='polite']")).find((p) =>
    /\bof\b/.test(p.textContent ?? "")
  )
  expect(el, "the 'N of M' counter").toBeDefined()
  return el!
}

describe("FeedDiscoveryProgress count (RAD-354)", () => {
  it("renders 'N of M' as plain text that is also the announced copy", () => {
    const { container } = render(
      <FeedDiscoveryProgress feeds={feeds(12, 3)} onComplete={() => {}} onBack={() => {}} />
    )
    const p = counter(container)

    expect(p.textContent).toBe("12 of 15")
    expect(p.querySelector("[aria-hidden='true']")).toBeNull()
    expect(p.querySelector(".sr-only")).toBeNull()
  })

  it("puts both numbers in the same kind of plain counter span", () => {
    const { container } = render(
      <FeedDiscoveryProgress feeds={feeds(12, 3)} onComplete={() => {}} onBack={() => {}} />
    )
    const spans = Array.from(counter(container).querySelectorAll("span"))

    expect(spans.map((s) => s.textContent)).toEqual(["12", "15"])
    for (const s of spans) {
      expect(s).toHaveClass("type-counter")
      expect(s.children).toHaveLength(0)
    }
  })

  it("updates the same atomic live region when the count changes", () => {
    const { container, rerender } = render(
      <FeedDiscoveryProgress feeds={feeds(12, 3)} onComplete={() => {}} onBack={() => {}} />
    )
    const before = counter(container)
    expect(before).toHaveAttribute("aria-atomic", "true")

    rerender(<FeedDiscoveryProgress feeds={feeds(13, 2)} onComplete={() => {}} onBack={() => {}} />)
    const after = counter(container)
    expect(after).toBe(before)
    expect(after.textContent).toBe("13 of 15")
  })
})
