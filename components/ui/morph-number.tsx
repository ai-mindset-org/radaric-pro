"use client"

/**
 * MorphNumber — the house wrapper around `@number-flow/react`, and the ONLY
 * module allowed to import it (mirroring `morph-text.tsx` for torph).
 *
 * Use it for a **number that changes in place** where the digits must stay put:
 * NumberFlow measures each digit and rolls it inside a masked slot, so the
 * spacing inside the number does not move as the value does. That is what
 * `MorphText` cannot promise — torph builds a value out of one inline-block box
 * per character and the engine pixel-snaps those independently, which is why the
 * processing summary could not morph its numbers (RAD-353).
 *
 * Measured before adoption (RAD-355) at DPR 2 with the app's own CSS and Inter:
 * a NumberFlow number's glyph columns are pixel-identical to the same value as
 * plain text at every fractional offset tested, for one- and two-digit values.
 * The box advance can still differ from plain text by up to one device pixel, so
 * a word *after* a number can sit a hair off; the digits themselves are exact,
 * and the summary's words have no comparator on screen.
 *
 * Rules the call sites rely on:
 *
 * - **Pairs with a plain-text twin for the announcement.** The library's shadow
 *   DOM exposes the digits individually ("2 5 of 5 9 …"), so hide the visible
 *   copy (`aria-hidden`) and carry the sentence in an `sr-only` sibling inside
 *   the live region — the shape RAD-342 established for the summary.
 * - **Plain text where the engine cannot animate** (SSR, the first client
 *   render, jsdom, reduced motion). The gate is `supportsNumberRoll()` plus the
 *   house reduced-motion read, never the library's own hooks — they assume a
 *   browser (`usePrefersReducedMotion` derefs a `matchMedia` list that is null
 *   when `matchMedia` is missing, and the custom elements do not upgrade) — so
 *   the markup, the tests and the announcement read as one span until a roll is
 *   actually available, and a reader with reduced motion never sees one. (The
 *   read is per-render: toggling the OS setting mid-session needs a reload, the
 *   same one-shot read `prefersReducedMotion()` documents.)
 * - **Numbers only.** A label or a phrase stays with `MorphText`; prose never
 *   morphs at all.
 * - **Digits only, never locale separators.** `format={{ useGrouping: false }}`
 *   is load-bearing: the library's default formatter groups, so `1271` would
 *   paint as `1,271` (the site's formatting rule, same as `MorphText`).
 * - **Tokens, never literals.** Durations and easings come from
 *   `getMotionTokens()`; only the client path can reach the DOM, which is
 *   exactly where NumberFlow mounts.
 */

import { useSyncExternalStore } from "react"
import NumberFlow from "@number-flow/react"
import { cn } from "@/lib/utils"
import { getMotionTokens, prefersReducedMotion, supportsNumberRoll } from "@/lib/motion"

/** A capability that cannot change during a session — subscribe to nothing. */
const noSubscription = () => () => {}
const clientCanRoll = () => supportsNumberRoll() && !prefersReducedMotion()
const serverCannotRoll = () => false

export interface MorphNumberProps {
  value: number
  className?: string
}

export function MorphNumber({ value, className }: MorphNumberProps) {
  // Server + hydration see `false` (plain markup, no divergence); the client
  // snapshot takes over right after hydration without a setState-in-effect.
  const canRoll = useSyncExternalStore(noSubscription, clientCanRoll, serverCannotRoll)

  if (!canRoll) {
    // An animated number is always a quantity: `type-counter` gives it the
    // Counters font and tabular figures (the role rule sets both) — on both roots.
    return <span className={cn("type-counter", className)}>{value}</span>
  }

  const tokens = getMotionTokens()
  const roll = { duration: tokens.base, easing: tokens.easeSnap }

  return (
    <NumberFlow
      value={value}
      // The site's formatting rule: digits only, never locale separators.
      // Without an explicit `format` the library builds
      // `new Intl.NumberFormat(undefined, undefined)`, whose `useGrouping`
      // default paints 1271 as "1,271" — the same trap `morph-text.tsx`
      // documents for torph's `toLocaleString` (RAD-357).
      format={{ useGrouping: false }}
      // `morph-number` carries the line-box overrides documented in
      // `app/globals.css` — the host's own padding would otherwise grow the line
      // by 2px and sit the glyphs 2px low.
      className={cn("morph-number type-counter", className)}
      // Vertical travel + the fade that covers it. `spinTiming` is left unset on
      // purpose: the library then falls back to `transformTiming`, so a jump of
      // more than one (the summary's "active" count can fall to 0) rolls through
      // the intermediate digits instead of cutting.
      transformTiming={roll}
      opacityTiming={{ duration: tokens.fast, easing: tokens.easeSnap }}
    />
  )
}
