/**
 * @vitest-environment jsdom
 */

/**
 * RAD-275 — motion tokens readable from JS.
 *
 * The point of lib/motion.ts is that JS-driven animation stops hand-copying CSS
 * values (the `setTimeout(..., 330)` hard-coded against `--dur-slow: 300ms`).
 * These cover the parsing and the fallbacks that make that safe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  MOTION_FALLBACKS,
  REFLOW_SPRING,
  getMotionTokens,
  parseDurationToken,
  prefersReducedMotion,
  resetMotionTokens,
  springEasing,
  springProgress,
  springSettleMs,
  supportsNumberRoll,
  supportsWebAnimations,
} from "@/lib/motion"

describe("parseDurationToken", () => {
  it("reads milliseconds", () => {
    expect(parseDurationToken("300ms", 1)).toBe(300)
  })

  it("reads seconds and converts", () => {
    expect(parseDurationToken("0.3s", 1)).toBe(300)
    expect(parseDurationToken("1s", 1)).toBe(1000)
  })

  it("tolerates the whitespace getPropertyValue leaves behind", () => {
    expect(parseDurationToken("  250ms  ", 1)).toBe(250)
  })

  it("treats a unitless number as milliseconds", () => {
    expect(parseDurationToken("200", 1)).toBe(200)
  })

  it("falls back on an undefined custom property (empty string)", () => {
    expect(parseDurationToken("", 42)).toBe(42)
    expect(parseDurationToken(null, 42)).toBe(42)
    expect(parseDurationToken(undefined, 42)).toBe(42)
  })

  it("falls back on garbage and on negatives", () => {
    expect(parseDurationToken("fast", 42)).toBe(42)
    expect(parseDurationToken("-5ms", 42)).toBe(42)
    expect(parseDurationToken("300ms 200ms", 42)).toBe(42)
  })
})

describe("getMotionTokens", () => {
  beforeEach(() => resetMotionTokens())
  afterEach(() => {
    vi.restoreAllMocks()
    resetMotionTokens()
  })

  it("resolves the tokens off the document root", () => {
    const values: Record<string, string> = {
      "--dur-fast": "150ms",
      "--dur-base": "200ms",
      "--dur-slow": "300ms",
      "--ease-exit": "cubic-bezier(0.4, 0, 0.2, 1)",
      "--ease-snap": "cubic-bezier(0.22, 1, 0.36, 1)",
    }
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => values[name] ?? "",
    } as unknown as CSSStyleDeclaration)

    const tokens = getMotionTokens()
    expect(tokens.slow).toBe(300)
    expect(tokens.fast).toBe(150)
    expect(tokens.base).toBe(200)
    expect(tokens.easeExit).toBe("cubic-bezier(0.4, 0, 0.2, 1)")
    expect(tokens.easeSnap).toBe("cubic-bezier(0.22, 1, 0.36, 1)")
  })

  it("picks up a changed token instead of a copied constant — the whole point", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => (name === "--dur-slow" ? "480ms" : ""),
    } as unknown as CSSStyleDeclaration)

    expect(getMotionTokens().slow).toBe(480)
  })

  it("falls back to the mirrored values when the properties are missing", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration)

    expect(getMotionTokens()).toEqual(MOTION_FALLBACKS)
  })

  it("memoises so every animation start isn't a style recalculation", () => {
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration)

    getMotionTokens()
    getMotionTokens()
    getMotionTokens()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("prefersReducedMotion", () => {
  // jsdom ships no matchMedia, so assign rather than spy.
  const original = window.matchMedia
  const stub = (matches: boolean) => {
    window.matchMedia = (() => ({ matches })) as unknown as typeof window.matchMedia
  }
  afterEach(() => {
    window.matchMedia = original
  })

  it("is false when the media query does not match", () => {
    stub(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it("is true when the user asked for reduced motion", () => {
    // The CSS guard in globals.css cannot reach a WAAPI animation, so JS has to ask.
    stub(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it("is false, not a crash, where matchMedia does not exist at all", () => {
    // @ts-expect-error — modelling an environment without the API (jsdom's default)
    window.matchMedia = undefined
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe("springProgress — the reflow's velocity profile", () => {
  const at = springProgress(REFLOW_SPRING)

  it("starts at rest and reaches the target", () => {
    expect(at(0)).toBe(0)
    expect(at(-1)).toBe(0)
    expect(at(2)).toBeCloseTo(1, 3)
  })

  it("is gentler off the line than the eased curve it replaced — the whole point", () => {
    // `--ease-snap` had a card 51% of the way there at 40ms. That leap is what
    // read as abrupt across a wide grid.
    const p40 = at(0.04)
    expect(p40).toBeGreaterThan(0.15)
    expect(p40).toBeLessThan(0.30)
  })

  it("overshoots slightly and settles without wobbling", () => {
    let peak = 0
    for (let ms = 0; ms <= 800; ms += 4) peak = Math.max(peak, at(ms / 1000))
    expect(peak).toBeGreaterThan(1) // damping ratio 0.75 — it does overshoot
    expect(peak).toBeLessThan(1.08) // but nowhere near a bounce

    // and never comes back for a second pass
    for (let ms = 500; ms <= 900; ms += 10) expect(Math.abs(1 - at(ms / 1000))).toBeLessThan(0.01)
  })

  it("does not overshoot at all when critically damped", () => {
    const critical = springProgress({ stiffness: 400, damping: 40, mass: 1 })
    for (let ms = 0; ms <= 900; ms += 4) expect(critical(ms / 1000)).toBeLessThanOrEqual(1)
  })

  it("handles the overdamped case without NaN", () => {
    const over = springProgress({ stiffness: 400, damping: 90, mass: 1 })
    for (let ms = 0; ms <= 900; ms += 20) expect(Number.isFinite(over(ms / 1000))).toBe(true)
    expect(over(3)).toBeCloseTo(1, 2)
  })
})

describe("springSettleMs", () => {
  it("gives the reflow spring a duration in a sane range", () => {
    const ms = springSettleMs(REFLOW_SPRING)
    expect(ms).toBeGreaterThan(250)
    expect(ms).toBeLessThan(700)
  })

  it("a stiffer spring settles sooner", () => {
    expect(springSettleMs({ stiffness: 900, damping: 40, mass: 1 })).toBeLessThan(
      springSettleMs({ stiffness: 200, damping: 22, mass: 1 })
    )
  })
})

describe("springEasing", () => {
  it("emits a CSS linear() easing pinned exactly at both ends", () => {
    const { easing, duration } = springEasing(REFLOW_SPRING, 12)
    expect(easing.startsWith("linear(0,")).toBe(true)
    expect(easing.endsWith(",1)")).toBe(true)
    expect(duration).toBe(springSettleMs(REFLOW_SPRING))
  })

  it("keeps the overshoot — points above 1 are the reason to use linear() at all", () => {
    const { easing } = springEasing(REFLOW_SPRING, 48)
    const points = easing.slice("linear(".length, -1).split(",").map(Number)
    expect(points.some(p => p > 1)).toBe(true)
    expect(Math.max(...points)).toBeLessThan(1.08)
  })

  it("samples monotonically in time and stays finite", () => {
    const { easing } = springEasing(REFLOW_SPRING, 48)
    const points = easing.slice("linear(".length, -1).split(",").map(Number)
    expect(points).toHaveLength(49)
    expect(points.every(Number.isFinite)).toBe(true)
  })
})

describe("supportsWebAnimations", () => {
  it("is false where Element.animate is missing (jsdom, old browsers)", () => {
    const el = document.createElement("div")
    // @ts-expect-error — deliberately removing the API to model the unsupported case
    el.animate = undefined
    expect(supportsWebAnimations(el)).toBe(false)
  })

  it("is true where it exists", () => {
    const el = document.createElement("div")
    el.animate = (() => ({})) as unknown as Element["animate"]
    expect(supportsWebAnimations(el)).toBe(true)
  })
})

describe("supportsNumberRoll", () => {
  /**
   * RAD-355/357 — the gate `MorphNumber` must pass before it renders NumberFlow.
   * It mirrors the three probes the library's own `canAnimate` runs, so a looser
   * gate would mount a NumberFlow that renders digits and never rolls (engines
   * with `registerProperty` but no `mod()`/`linear()`). jsdom has none of it.
   */
  type Globals = { CSS?: unknown; matchMedia?: unknown; animate?: unknown; getAnimations?: unknown }

  function withCapabilities(caps: { css?: unknown; matchMedia?: unknown; waapi?: boolean }, fn: () => void) {
    const el = Element.prototype as unknown as Globals
    const saved: { CSS?: unknown; matchMedia?: unknown; animate?: unknown; getAnimations?: unknown } = {
      CSS: (globalThis as Globals).CSS,
      matchMedia: (window as unknown as Globals).matchMedia,
      animate: el.animate,
      getAnimations: el.getAnimations,
    }
    const restore = (key: "CSS" | "matchMedia" | "animate" | "getAnimations") => {
      const target: object = key === "CSS" ? globalThis : key === "matchMedia" ? window : (Element.prototype as object)
      // Delete rather than assign when jsdom never had it: assigning `undefined`
      // leaves an own property that a future `"matchMedia" in window` would see.
      if (saved[key] === undefined) delete (target as Record<string, unknown>)[key]
      else (target as Record<string, unknown>)[key] = saved[key]
    }
    try {
      ;(globalThis as Globals).CSS = caps.css
      ;(window as unknown as Globals).matchMedia = caps.matchMedia
      if (caps.waapi) {
        el.animate = () => ({})
        el.getAnimations = () => []
      }
      fn()
    } finally {
      restore("CSS")
      restore("matchMedia")
      restore("animate")
      restore("getAnimations")
    }
  }

  const cssWith = (mod: boolean) => ({
    registerProperty: () => {},
    supports: (prop: string, value: string) => (prop === "line-height" && value === "mod(1,1)" ? mod : false),
  })
  const mql = () => ({ matches: false })

  it("is false in jsdom, where matchMedia, WAAPI and CSS.registerProperty are absent", () => {
    expect(supportsNumberRoll()).toBe(false)
  })

  it("is false with WAAPI and matchMedia but no CSS.registerProperty", () => {
    withCapabilities({ css: {}, matchMedia: mql, waapi: true }, () => {
      expect(supportsNumberRoll()).toBe(false)
    })
  })

  it("is false where registerProperty exists but mod() does not (Chrome 84-124, Firefox 115-127)", () => {
    withCapabilities({ css: cssWith(false), matchMedia: mql, waapi: true }, () => {
      expect(supportsNumberRoll()).toBe(false)
    })
  })

  it("is true where every probe the library runs is available", () => {
    withCapabilities({ css: cssWith(true), matchMedia: mql, waapi: true }, () => {
      expect(supportsNumberRoll()).toBe(true)
    })
  })

  it("leaves no own globals behind when it restores", () => {
    withCapabilities({ css: cssWith(true), matchMedia: mql, waapi: true }, () => {
      expect(supportsNumberRoll()).toBe(true)
    })
    expect(Object.prototype.hasOwnProperty.call(window, "matchMedia")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(globalThis, "CSS")).toBe(false)
  })
})
