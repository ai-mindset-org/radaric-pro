import { describe, it, expect } from "vitest"
import {
  summarizeFreshness,
  freshnessProps,
  hasFreshnessLine,
  formatCheckedRelative,
  formatCheckedAbsolute,
  type FreshnessSource,
} from "@/lib/materials/source-freshness"

const at = (iso: string) => new Date(iso)
const src = (over: Partial<FreshnessSource> = {}): FreshnessSource => ({
  status: "ACTIVE",
  isActive: true,
  lastParsedAt: at("2026-11-03T10:00:00Z"),
  ...over,
})

describe("summarizeFreshness", () => {
  it("is empty for no sources", () => {
    expect(summarizeFreshness([])).toEqual({
      checkedAt: null,
      inactiveCheckedAt: null,
      activeCount: 0,
      neverCount: 0,
      failedCount: 0,
      pausedCount: 0,
    })
  })

  it("takes the OLDEST lastParsedAt among active sources", () => {
    const summary = summarizeFreshness([
      src({ lastParsedAt: at("2026-11-03T10:00:00Z") }),
      src({ lastParsedAt: at("2026-11-03T08:00:00Z") }),
      src({ lastParsedAt: "2026-11-03T09:00:00Z" }),
    ])
    expect(summary.checkedAt).toEqual(at("2026-11-03T08:00:00Z"))
    expect(summary.activeCount).toBe(3)
  })

  it("counts ERROR sources as failed and keeps them out of checkedAt", () => {
    const summary = summarizeFreshness([
      src({ lastParsedAt: at("2026-11-03T10:00:00Z") }),
      src({ status: "ERROR", lastParsedAt: at("2026-11-01T00:00:00Z") }),
    ])
    expect(summary.failedCount).toBe(1)
    expect(summary.activeCount).toBe(1)
    expect(summary.checkedAt).toEqual(at("2026-11-03T10:00:00Z"))
  })

  it("counts PAUSED and switched-off sources as paused, outside checkedAt", () => {
    const summary = summarizeFreshness([
      src({ lastParsedAt: at("2026-11-03T10:00:00Z") }),
      src({ status: "PAUSED", lastParsedAt: at("2026-10-01T00:00:00Z") }),
      src({ isActive: false, lastParsedAt: at("2026-10-02T00:00:00Z") }),
    ])
    expect(summary.pausedCount).toBe(2)
    expect(summary.activeCount).toBe(1)
    expect(summary.checkedAt).toEqual(at("2026-11-03T10:00:00Z"))
    expect(summary.inactiveCheckedAt).toEqual(at("2026-10-02T00:00:00Z"))
  })

  it("counts active never-parsed sources and leaves them out of checkedAt", () => {
    const summary = summarizeFreshness([src({ lastParsedAt: null }), src({ lastParsedAt: at("2026-11-03T10:00:00Z") })])
    expect(summary.neverCount).toBe(1)
    expect(summary.checkedAt).toEqual(at("2026-11-03T10:00:00Z"))
    expect(summarizeFreshness([src({ lastParsedAt: null })]).checkedAt).toBeNull()
  })

  it("treats an unparseable date as never parsed", () => {
    expect(summarizeFreshness([src({ lastParsedAt: "not a date" })]).neverCount).toBe(1)
  })
})

describe("freshnessProps", () => {
  it("serializes dates as ISO strings for the RSC boundary", () => {
    const props = freshnessProps([src({ lastParsedAt: at("2026-11-03T10:00:00Z") })])
    expect(props.checkedAt).toBe("2026-11-03T10:00:00.000Z")
    expect(props.inactiveCheckedAt).toBeNull()
  })
})

describe("formatCheckedRelative", () => {
  const now = at("2026-11-10T12:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const MIN = 60_000
  const H = 60 * MIN

  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [MIN, "1 min ago"],
    [12 * MIN, "12 min ago"],
    [59 * MIN + 59_000, "59 min ago"],
    [H, "1 h ago"],
    [5 * H, "5 h ago"],
    [24 * H - 1, "23 h ago"],
    [24 * H, "yesterday"],
    [48 * H - 1, "yesterday"],
    [48 * H, "2 days ago"],
    [7 * 24 * H, "7 days ago"],
  ])("%i ms ago reads %s", (elapsed, text) => {
    expect(formatCheckedRelative(ago(elapsed), now)).toBe(text)
  })

  it("never reads in the future when the clock is slightly behind", () => {
    expect(formatCheckedRelative(ago(-5_000), now)).toBe("just now")
  })
})

describe("formatCheckedAbsolute", () => {
  it("renders a medium date and a short time", () => {
    const text = formatCheckedAbsolute(at("2026-11-03T10:05:00Z"))
    expect(text).toMatch(/2026/)
    expect(text.length).toBeGreaterThan(8)
  })
})

describe("hasFreshnessLine", () => {
  it("is false when nothing is active, failed or paused, true otherwise", () => {
    expect(hasFreshnessLine(freshnessProps([]))).toBe(false)
    expect(hasFreshnessLine(freshnessProps([src()]))).toBe(true)
    expect(hasFreshnessLine(freshnessProps([src({ status: "ERROR" })]))).toBe(true)
    expect(hasFreshnessLine(freshnessProps([src({ isActive: false })]))).toBe(true)
  })
})
