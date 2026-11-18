/**
 * RAD-345 — click intent. The predicate both the card and the story's material
 * rows use to decide "new tab" vs "peek".
 */
import { describe, expect, it } from "vitest"
import { isAuxNewTab, isNewTabClick } from "@/lib/peek/click"

describe("isNewTabClick", () => {
  it("is true for each modifier", () => {
    expect(isNewTabClick({ metaKey: true })).toBe(true)
    expect(isNewTabClick({ ctrlKey: true })).toBe(true)
    expect(isNewTabClick({ shiftKey: true })).toBe(true)
    expect(isNewTabClick({ altKey: true })).toBe(true)
  })

  it("is true for the middle button", () => {
    expect(isNewTabClick({ button: 1 })).toBe(true)
  })

  it("is false for a plain left click", () => {
    expect(isNewTabClick({})).toBe(false)
    expect(isNewTabClick({ button: 0 })).toBe(false)
    expect(isNewTabClick({ metaKey: false, shiftKey: false })).toBe(false)
  })
})

describe("isAuxNewTab", () => {
  it("only accepts the middle button", () => {
    expect(isAuxNewTab({ button: 1 })).toBe(true)
    expect(isAuxNewTab({ button: 0 })).toBe(false)
    expect(isAuxNewTab({ button: 2 })).toBe(false)
    expect(isAuxNewTab({})).toBe(false)
  })
})
