/**
 * RAD-345 — sheet dismiss maths.
 *
 * The thresholds the drag gesture releases on. jsdom has no touch events, so
 * the hook that measures is verified in the real-browser pass; these pin the
 * decisions it makes from those measurements.
 */
import { describe, expect, it } from "vitest"
import {
  DISMISS_DISTANCE_PX,
  dismissDecision,
  dismissProgress,
  rubberBand,
} from "@/lib/peek/drag"

const base = { deltaY: 0, velocity: 0, scrollTop: 0, reducedMotion: false }

describe("dismissDecision", () => {
  it("snaps back below the distance threshold", () => {
    expect(dismissDecision({ ...base, deltaY: DISMISS_DISTANCE_PX - 1 })).toBe("snap-back")
  })

  it("dismisses past the distance threshold", () => {
    expect(dismissDecision({ ...base, deltaY: DISMISS_DISTANCE_PX })).toBe("dismiss")
  })

  it("snaps back when the content is scrolled, however far the drag", () => {
    expect(
      dismissDecision({ ...base, deltaY: 400, velocity: 2, scrollTop: 12 })
    ).toBe("snap-back")
  })

  it("never dismisses on an upward drag", () => {
    expect(dismissDecision({ ...base, deltaY: -200, velocity: -3 })).toBe("snap-back")
    expect(dismissDecision({ ...base, deltaY: 0 })).toBe("snap-back")
  })

  it("dismisses on a downward flick past the floor", () => {
    expect(dismissDecision({ ...base, deltaY: 40, velocity: 0.8 })).toBe("dismiss")
  })

  it("ignores a flick that never moved — the finger-lift twitch", () => {
    expect(dismissDecision({ ...base, deltaY: 8, velocity: 3 })).toBe("snap-back")
  })

  it("ignores velocity exactly at the threshold's floor edge", () => {
    expect(dismissDecision({ ...base, deltaY: 40, velocity: 0.5 })).toBe("dismiss")
    expect(dismissDecision({ ...base, deltaY: 40, velocity: 0.49 })).toBe("snap-back")
  })

  it("drops the velocity shortcut under reduced motion, keeps distance", () => {
    expect(
      dismissDecision({ ...base, deltaY: 40, velocity: 3, reducedMotion: true })
    ).toBe("snap-back")
    expect(
      dismissDecision({ ...base, deltaY: DISMISS_DISTANCE_PX, reducedMotion: true })
    ).toBe("dismiss")
  })
})

describe("rubberBand", () => {
  it("passes downward travel through untouched", () => {
    expect(rubberBand(120, 800)).toBe(120)
  })

  it("resists upward travel, monotonically and under the finger's distance", () => {
    const first = rubberBand(-50, 800)
    const second = rubberBand(-200, 800)
    expect(first).toBeLessThan(0)
    expect(Math.abs(first)).toBeLessThan(50)
    expect(Math.abs(second)).toBeLessThan(200)
    expect(Math.abs(second)).toBeGreaterThan(Math.abs(first))
  })

  it("is bounded by the dimension", () => {
    expect(Math.abs(rubberBand(-100000, 800))).toBeLessThan(800)
  })
})

describe("dismissProgress", () => {
  it("is a 0..1 fraction of the dimension", () => {
    expect(dismissProgress(0, 800)).toBe(0)
    expect(dismissProgress(400, 800)).toBeCloseTo(0.5)
    expect(dismissProgress(900, 800)).toBe(1)
    expect(dismissProgress(-50, 800)).toBe(0)
  })

  it("is safe when the dimension is unknown", () => {
    expect(dismissProgress(100, 0)).toBe(0)
  })
})
