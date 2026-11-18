/**
 * RAD-345 — peek keyboard intent.
 *
 * `j`/`k` walk the peek order. The guards matter more than the keys: typing in
 * an input and selecting a passage (for ExcerptSaver) must both win over
 * navigation.
 */
import { describe, expect, it } from "vitest"
import { navKeyIntent } from "@/lib/peek/keyboard"

const input = { key: "j", target: null, selectionCollapsed: true }

describe("navKeyIntent", () => {
  it("maps j/k in both cases", () => {
    expect(navKeyIntent({ ...input, key: "j" })).toBe("next")
    expect(navKeyIntent({ ...input, key: "J" })).toBe("next")
    expect(navKeyIntent({ ...input, key: "k" })).toBe("previous")
    expect(navKeyIntent({ ...input, key: "K" })).toBe("previous")
  })

  it("ignores other keys", () => {
    expect(navKeyIntent({ ...input, key: "Enter" })).toBeNull()
    expect(navKeyIntent({ ...input, key: "ArrowDown" })).toBeNull()
    expect(navKeyIntent({ ...input, key: " " })).toBeNull()
  })

  it("ignores modified keystrokes", () => {
    expect(navKeyIntent({ ...input, metaKey: true })).toBeNull()
    expect(navKeyIntent({ ...input, ctrlKey: true })).toBeNull()
    expect(navKeyIntent({ ...input, altKey: true })).toBeNull()
  })

  it("ignores keys while typing", () => {
    expect(navKeyIntent({ ...input, target: { tagName: "INPUT" } })).toBeNull()
    expect(navKeyIntent({ ...input, target: { tagName: "textarea" } })).toBeNull()
    expect(navKeyIntent({ ...input, target: { tagName: "SELECT" } })).toBeNull()
    expect(navKeyIntent({ ...input, target: { isContentEditable: true } })).toBeNull()
  })

  it("does not treat a rich-text selection as typing", () => {
    // Event targets inside the article are plain elements, not inputs.
    expect(navKeyIntent({ ...input, target: { tagName: "P", isContentEditable: false } })).toBe("next")
  })

  it("ignores keys while a selection is live", () => {
    expect(navKeyIntent({ ...input, selectionCollapsed: false })).toBeNull()
  })

  it("ignores a missing target", () => {
    expect(navKeyIntent({ ...input, target: undefined })).toBe("next")
    expect(navKeyIntent({ ...input, target: null })).toBe("next")
  })
})
