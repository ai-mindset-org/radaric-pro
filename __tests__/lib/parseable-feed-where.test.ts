import { describe, it, expect } from "vitest"
import { isParseableType, parseableFeedWhere } from "@/lib/materials/parseable-feed-where"

describe("parseableFeedWhere (RAD-424)", () => {
  it("is exactly what a parse run reads: own, active, visible feeds", () => {
    expect(parseableFeedWhere({ userId: "u1", includesTwitter: true })).toEqual({
      userId: "u1",
      isActive: true,
      hidden: false,
    })
  })

  it("leaves X feeds out for a user without the X entitlement", () => {
    expect(parseableFeedWhere({ userId: "u1", includesTwitter: false })).toMatchObject({
      type: { not: "TWITTER" },
    })
  })

  it("scopes to the requested source ids", () => {
    expect(parseableFeedWhere({ userId: "u1", includesTwitter: true, sourceIds: ["a", "b"] })).toMatchObject({
      id: { in: ["a", "b"] },
    })
  })

  it("keeps paused feeds for the freshness line, but still drops hidden and locked X feeds", () => {
    const where = parseableFeedWhere({ userId: "u1", includesTwitter: false, includeInactive: true })
    expect(where).not.toHaveProperty("isActive")
    expect(where).toMatchObject({ hidden: false, type: { not: "TWITTER" } })
  })

  it("isParseableType follows the same rule", () => {
    expect(isParseableType("TWITTER", false)).toBe(false)
    expect(isParseableType("TWITTER", true)).toBe(true)
    expect(isParseableType("RSS", false)).toBe(true)
  })
})
