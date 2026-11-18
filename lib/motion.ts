/**
 * Motion tokens, readable from JavaScript.
 *
 * The design system's durations and curves live in CSS (`app/globals.css`,
 * `@theme` block). Anything animated in CSS just uses `var(--dur-slow)` and is
 * automatically in sync. JS-driven animation (WAAPI) can't do that — which is
 * how `components/materials/materials-list.tsx` ended up with a hand-copied
 * `setTimeout(..., 330)` in four places, coupled to `--dur-slow: 300ms` by
 * nothing but a comment.
 *
 * So instead of copying the values, read them: `getMotionTokens()` resolves the
 * same custom properties off the document root. The fallbacks below exist for
 * SSR and for tests, and are the only place the values are duplicated.
 *
 * See docs/STYLING_GUIDE.md § "Radius, squircle, motion".
 */

export interface MotionTokens {
  /** `--dur-fast` — reduced-motion exits, micro-feedback. */
  fast: number
  /** `--dur-base` — enter animations, and the grid's card exit. */
  base: number
  /** `--dur-slow` — general structural motion. */
  slow: number
  /** `--ease-exit` — close/dismiss (symmetric). */
  easeExit: string
  /** `--ease-dismiss` — an element accelerating off-screen. */
  easeDismiss: string
  /** `--ease-snap` — primary structural curve. */
  easeSnap: string
}

/**
 * Mirrors `app/globals.css`. Used during SSR (no `document`) and in tests.
 * If you change a token there, change it here — or better, don't: everything
 * on the client reads the live value.
 */
export const MOTION_FALLBACKS: MotionTokens = {
  fast: 150,
  base: 200,
  slow: 300,
  easeExit: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeDismiss: "cubic-bezier(0.4, 0, 1, 1)",
  easeSnap: "cubic-bezier(0.22, 1, 0.36, 1)",
}

/** Exit scale, mirroring the `dismissCard` keyframe in `app/globals.css`. */
export const EXIT_SCALE = 0.85

// ---------------------------------------------------------------------------
// Sibling reflow — a spring, not an eased curve
// ---------------------------------------------------------------------------

/**
 * The spring the grid's sibling reflow runs on.
 *
 * An eased curve and a spring can finish at the same moment and still read
 * completely differently, because what the eye reads is the *start*. Our
 * previous `--ease-snap` reflow had a card 51% of the way to its destination
 * after 40ms; this spring is at 21%. On a short list row that difference is
 * academic — across the Posts grid, where a card can travel 800px, the eased
 * version reads as a card being flung and the spring as one being carried.
 *
 * Values from Karl Koch, "On layout choreography" (23 Jul 2026), which uses
 * `spring(stiffness: 400, damping: 30)` for sibling movement. Damping ratio
 * works out at 0.75 — a ~3% overshoot, which settles without wobbling.
 */
export const REFLOW_SPRING = { stiffness: 400, damping: 30, mass: 1 } as const

export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
}

/**
 * Normalised step response of a damped spring — 0 at rest, 1 at target, with
 * values above 1 while it overshoots. `t` is in seconds.
 */
export function springProgress(spring: SpringConfig): (t: number) => number {
  const { stiffness: k, damping: c, mass: m } = spring
  const wn = Math.sqrt(k / m)
  const zeta = c / (2 * Math.sqrt(k * m))

  return (t: number) => {
    if (t <= 0) return 0
    if (zeta < 1) {
      const wd = wn * Math.sqrt(1 - zeta * zeta)
      return 1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + ((zeta * wn) / wd) * Math.sin(wd * t))
    }
    if (zeta === 1) return 1 - Math.exp(-wn * t) * (1 + wn * t)
    const s = Math.sqrt(zeta * zeta - 1)
    const r1 = -wn * (zeta - s)
    const r2 = -wn * (zeta + s)
    return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1)
  }
}

/** Where the spring has settled for good, in ms — its natural duration. */
export function springSettleMs(spring: SpringConfig, tolerance = 0.002, ceiling = 1600): number {
  const at = springProgress(spring)
  for (let ms = 16; ms <= ceiling; ms += 8) {
    let settled = true
    for (let probe = 0; probe <= 96; probe += 8) {
      if (Math.abs(1 - at((ms + probe) / 1000)) > tolerance) {
        settled = false
        break
      }
    }
    if (settled) return ms
  }
  return ceiling
}

/**
 * The spring as a CSS `linear()` easing plus its duration.
 *
 * Sampling the spring into per-element keyframes would mean ~60 keyframe
 * objects per card per reflow; `linear()` carries the same curve in a single
 * shared string, so each card keeps a two-keyframe transform. Points above 1
 * are legal and are what preserve the overshoot.
 */
export function springEasing(spring: SpringConfig, steps = 48): { easing: string; duration: number } {
  const duration = springSettleMs(spring)
  const at = springProgress(spring)
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const p = at(((i / steps) * duration) / 1000)
    points.push(p.toFixed(4).replace(/\.?0+$/, "") || "0")
  }
  // Pin the ends exactly — a sampled endpoint a hair off 1 leaves a visible offset.
  points[0] = "0"
  points[steps] = "1"
  return { easing: `linear(${points.join(",")})`, duration }
}

/** `linear()` easing — Chrome 113+, Safari 17.4+, Firefox 112+. */
export function supportsLinearEasing(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false
  return CSS.supports("animation-timing-function", "linear(0, 1)")
}

let cachedReflow: { easing: string; duration: number } | null = null

/**
 * Timing for the sibling reflow: the spring where `linear()` exists, and the
 * structural curve at `--dur-slow` where it doesn't.
 */
export function getReflowTiming(): { easing: string; duration: number } {
  if (cachedReflow) return cachedReflow
  const tokens = getMotionTokens()
  cachedReflow = supportsLinearEasing()
    ? springEasing(REFLOW_SPRING)
    : { easing: tokens.easeSnap, duration: tokens.slow }
  return cachedReflow
}

/**
 * Parse a CSS duration token (`"300ms"`, `"0.3s"`) into milliseconds.
 * Returns `fallback` for anything unparseable — including the empty string
 * `getPropertyValue` hands back for an undefined custom property.
 */
export function parseDurationToken(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback
  const match = /^\s*(-?[\d.]+)(ms|s)?\s*$/.exec(value)
  if (!match) return fallback
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount) || amount < 0) return fallback
  return match[2] === "s" ? amount * 1000 : amount
}

let cached: MotionTokens | null = null

/**
 * Resolve the motion tokens from the document root, memoised for the session.
 * Safe to call during SSR — returns the fallbacks and caches nothing, so the
 * first client-side call still reads the real values.
 */
export function getMotionTokens(): MotionTokens {
  if (cached) return cached
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return MOTION_FALLBACKS
  }

  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback

  cached = {
    fast: parseDurationToken(read("--dur-fast", ""), MOTION_FALLBACKS.fast),
    base: parseDurationToken(read("--dur-base", ""), MOTION_FALLBACKS.base),
    slow: parseDurationToken(read("--dur-slow", ""), MOTION_FALLBACKS.slow),
    easeExit: read("--ease-exit", MOTION_FALLBACKS.easeExit),
    easeDismiss: read("--ease-dismiss", MOTION_FALLBACKS.easeDismiss),
    easeSnap: read("--ease-snap", MOTION_FALLBACKS.easeSnap),
  }
  return cached
}

/** Test seam — drops the memoised tokens so the next read hits the DOM again. */
export function resetMotionTokens(): void {
  cached = null
  cachedReflow = null
}

/**
 * `prefers-reduced-motion: reduce`.
 *
 * `app/globals.css` has a global guard that collapses every CSS animation and
 * transition, but it cannot touch a WAAPI animation started from JS — those
 * have to check this themselves.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** WAAPI feature detection — false in jsdom and on very old browsers. */
export function supportsWebAnimations(el: Element): boolean {
  return typeof (el as HTMLElement).animate === "function"
}

/**
 * Can this environment run a torph morph at all?
 *
 * torph needs more than `animate`: its reduced-motion listener calls
 * `window.matchMedia` in the constructor, and both `destroy()` and any
 * second update call `element.getAnimations()` — so `disabled` does NOT make
 * it safe to mount where those are missing. jsdom has neither, and neither do
 * engines predating WAAPI. Where this returns false, MorphText renders a plain
 * element and never constructs the component.
 *
 * Deliberately separate from `supportsWebAnimations()`, which checks only
 * `.animate` because that is all the grid's FLIP path calls; widening it would
 * change that consumer's contract (pinned by `__tests__/lib/motion.test.ts`).
 */
export function supportsMorphAnimation(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  const proto = typeof Element === "undefined" ? undefined : Element.prototype
  return typeof proto?.animate === "function" && typeof proto?.getAnimations === "function"
}

/**
 * Can this environment run a NumberFlow digit roll (`components/ui/morph-number`)?
 *
 * The same two capabilities torph needs — `window.matchMedia` and WAAPI — plus
 * the three feature probes the library's own `canAnimate` runs before it will
 * animate anything (verified against `number-flow@0.6.2`): `CSS.registerProperty`
 * (the roll interpolates registered custom properties), `CSS.supports("line-height",
 * "mod(1,1)")` (the digit transform is built on `mod()`) and a `linear()`
 * easing accepted by `Element.animate`. `registerProperty` alone is not enough:
 * engines in the Chrome/Edge/WebView 84–124 and Firefox 115–127 range have it
 * without `mod()`/`linear()`, and there a looser gate would mount a NumberFlow
 * that renders digits and never rolls, instead of the plain text the wrapper
 * promises. jsdom has none of them; the library is not inert there either — its
 * custom elements do not upgrade and its hooks assume a `matchMedia` list — so
 * the gate must be false rather than merely useless.
 *
 * Kept separate from `supportsMorphAnimation()` because that name is pinned by
 * `__tests__/lib/motion.test.ts` as the torph gate.
 */
export function supportsNumberRoll(): boolean {
  if (!supportsMorphAnimation()) return false
  if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return false
  if (typeof CSS.supports !== "function" || !CSS.supports("line-height", "mod(1,1)")) return false
  try {
    // `linear()` support is a try/catch in the library, not a `CSS.supports`
    // query — mirror the probe rather than guess at a feature string.
    document.createElement("div").animate({ opacity: 0 }, { easing: "linear(0, 1)" })
  } catch {
    return false
  }
  return true
}
