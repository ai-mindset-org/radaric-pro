/**
 * Pure function tests for the shared title-length policy (lib/title.ts).
 * Every parser routes its derived title through capTitle so the
 * "≤ 300 chars else full title + ellipsis" rule lives in one place.
 */

import { describe, it, expect } from "vitest"
import { capTitle, TITLE_MAX_LENGTH } from "@/lib/title"

describe("capTitle", () => {
  it("returns a short title unchanged (full title)", () => {
    expect(capTitle("A normal title")).toBe("A normal title")
  })

  it("returns a title exactly at the limit unchanged", () => {
    const exact = "x".repeat(TITLE_MAX_LENGTH)
    expect(capTitle(exact)).toBe(exact)
    expect(capTitle(exact)).toHaveLength(TITLE_MAX_LENGTH)
  })

  it("truncates a title one char over the limit and appends an ellipsis", () => {
    const over = "x".repeat(TITLE_MAX_LENGTH + 1)
    const result = capTitle(over)
    expect(result).toHaveLength(TITLE_MAX_LENGTH + 1) // 300 chars + the ellipsis char
    expect(result.endsWith("…")).toBe(true)
    expect(result.slice(0, TITLE_MAX_LENGTH)).toBe("x".repeat(TITLE_MAX_LENGTH))
  })

  it("respects an explicit max override", () => {
    expect(capTitle("abcdef", 3)).toBe("abc…")
  })

  it("defaults the limit to 300", () => {
    expect(TITLE_MAX_LENGTH).toBe(300)
  })
})
