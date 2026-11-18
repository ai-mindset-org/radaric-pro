/** @vitest-environment jsdom */

/**
 * RAD-363 slice 8 — what the classified call sites actually render.
 *
 * The source guards in `__tests__/typography-call-sites.test.ts` pin the class
 * names; these pin the DOM a reader gets: a morphing number is a counter, a
 * morphing label is not, and a sentence with numbers in it keeps its text
 * byte-for-byte while only the numbers move to the Counters font. A date
 * stays in the text font with tabular figures.
 */

import { describe, it, expect } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"
import { MorphNumber } from "@/components/ui/morph-number"
import { MorphText } from "@/components/ui/morph-text"
import { LivingAnswer } from "@/components/saved/living-answer"

const counters = (el: ParentNode) => [...el.querySelectorAll(".type-counter")].map((n) => n.textContent)

describe("morph primitives", () => {
  it("MorphNumber renders its value as a counter", () => {
    const { container } = render(<MorphNumber value={25} />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass("type-counter")
    expect(root.textContent).toBe("25")
  })

  it("MorphText makes a numeric child a counter and keeps the caller's classes", () => {
    const { container } = render(<MorphText className="font-semibold">{7}</MorphText>)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass("type-counter")
    expect(root).toHaveClass("font-semibold")
  })

  it("MorphText leaves a label in the surrounding font", () => {
    const { container } = render(<MorphText>Grouping stories</MorphText>)
    expect(container.firstElementChild).not.toHaveClass("type-counter")
  })
})

describe("a sentence with numbers in it", () => {
  const base = {
    collectionId: "c1",
    initialDelta: null,
    trackRequested: false,
    itemCount: 3,
    excerptCount: 1,
  }

  it("wraps each count, not the sentence, and keeps the text unchanged", () => {
    const { container } = render(
      <LivingAnswer {...base} initialSynthesis={null} initialUpdatedAt={null} />
    )
    const line = [...container.querySelectorAll("span")].find(
      (s) => s.textContent === "3 items · 1 excerpt"
    )
    expect(line, "the dormant count line").toBeDefined()
    expect(line).not.toHaveClass("tabular-nums")
    expect(line).not.toHaveClass("type-counter")
    expect(counters(line!)).toEqual(["3", "1"])
  })

  it("keeps the date in the text font with tabular figures and counts the sources", () => {
    const { container } = render(
      <LivingAnswer
        {...base}
        initialSynthesis="An answer."
        initialUpdatedAt="2026-09-27T10:05:00.000Z"
      />
    )
    const line = [...container.querySelectorAll("div")].find((d) =>
      /^Updated .+ · 4 sources$/.test(d.textContent ?? "")
    )
    expect(line, "the 'Updated … · N sources' line").toBeDefined()
    expect(line).not.toHaveClass("tabular-nums")
    expect(counters(line!)).toEqual(["4"])

    const date = line!.querySelector(".tabular-nums") as HTMLElement
    expect(date).not.toBeNull()
    expect(date).not.toHaveClass("type-counter")
    expect(date.textContent).toMatch(/^\d{1,2} Sep 2026, \d{2}:\d{2}$/)
  })
})
