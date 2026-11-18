"use client"

/**
 * MorphText — the house wrapper around torph, and the ONLY module allowed to
 * import from `torph` (enforced by `__tests__/torph-import-hygiene.test.ts`).
 *
 * It morphs a value that changes in place — a counter, a badge, a short label —
 * so the new number or word arrives as continuity instead of a repaint. Use it
 * where the value is the message; do not use it for appearance/disappearance
 * (`.animate-count-swap` owns that), for text the user is typing, or for prose
 * that can wrap.
 *
 * Rules the call sites rely on:
 *
 * - **Single-line tokens only.** torph's root is `inline-block` with
 *   `white-space: nowrap`, so a value that would wrap naturally is clipped
 *   instead. Keep static words and glue OUTSIDE the morph: `{n} posts` morphs
 *   `{n}`, not the phrase.
 * - **A number root's spacing is approximate — keep it away from other
 *   multi-digit numbers.** torph renders the value as one `inline-block` box per
 *   character, and the engine pixel-snaps each box on its own: measured at DPR 2
 *   against the same text as a single run, a morph root's painted advance is off
 *   by up to a device pixel, by an amount that depends on where the root falls.
 *   Alone that is invisible — until a reader has something to compare it to, and
 *   the comparison is a digit run against another digit run. So two multi-digit
 *   numbers on one line ("25 of 59 sources processed") render with different
 *   gaps, which is why the processing summary is plain text (RAD-353). A root
 *   alone in its line box — a badge, a counter under its own label, a label
 *   replaced whole, a `/4` whose static number has no run to compare — is safe.
 *   Onboarding's "N of M" discovery count went plain for the same reason (RAD-354).
 * - **In a flex parent, glue and value go inside ONE element.** The morph root
 *   is an element, so a sibling text run (`/4`, `+`, ` posts`) becomes a
 *   separate flex item and the parent's `gap` lands between them — `3/4` reads
 *   `3 /4`. Write `<span><MorphText>3</MorphText>/4</span>`, never
 *   `<MorphText>3</MorphText>/4` inside a `gap`-carrying container.
 * - **`coalesceMs` is stable for the life of the component.** Toggling it off
 *   and on again can show the last coalesced value until the next window
 *   closes; pass a constant.
 * - **Attributes belong to the parent.** The library forwards only
 *   `className`, `style` and `as`; an `aria-label`/`id`/`data-*` placed here is
 *   silently dropped. Wrap it: `<span aria-label={...}><MorphText …/></span>`.
 * - **No `key` derived from the value.** A remount is a first render, and torph
 *   never animates the first render — the morph would silently never fire.
 * - **Numbers are stringified here, never locally formatted.** torph formats a
 *   numeric value through `toLocaleString`, which would turn `1271` into
 *   `1,271`; a `String(n)` child keeps the site's own formatting. Numeric
 *   children (not strings) get `type-counter` automatically — the Counters
 *   font, with tabular figures so a roll does not jitter the layout. A
 *   quantity passed as a string (a price, a pre-formatted count) is the
 *   caller's to mark: pass `className="type-counter"`.
 * - **`coalesceMs` on streamed values.** Every update is a measurement pass
 *   (forced layout), so a 130-frame parse must not pay 130 of them; the window
 *   emits the latest value on its trailing edge.
 *
 * Where the engine cannot morph (jsdom, pre-WAAPI), this renders a plain
 * element with the same text — see `supportsMorphAnimation()` for why
 * `disabled` alone is not enough. First client render is always plain, so SSR
 * and hydration agree.
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react"
import { TextMorph } from "torph/react"
import { cn } from "@/lib/utils"
import { getMotionTokens, supportsMorphAnimation } from "@/lib/motion"

/** A capability that cannot change during a session — subscribe to nothing. */
const noSubscription = () => () => {}
const clientCanMorph = () => supportsMorphAnimation()
const serverCannotMorph = () => false

export type MorphTiming = "fast" | "base"

export interface MorphTextProps {
  /** A single-line value. Numbers keep the site's formatting (no locale separators). */
  children: string | number
  /** Rendered element, default `span`. */
  as?: keyof HTMLElementTagNameMap
  className?: string
  style?: CSSProperties
  /** `fast` (150 ms) for streamed values, `base` (200 ms) for everything else. */
  timing?: MorphTiming
  locale?: string
  /** torph's place-value number morph; on by default. */
  numbers?: boolean
  /** Minimum time between DOM updates, trailing-edge. For streamed counters. */
  coalesceMs?: number
}

export function MorphText({
  children,
  as = "span",
  className,
  style,
  timing = "base",
  locale,
  numbers,
  coalesceMs,
}: MorphTextProps) {
  const text = typeof children === "number" ? String(children) : children
  const shown = useCoalescedValue(text, coalesceMs)
  // Server + hydration see `false` (plain markup, no divergence); the client
  // snapshot takes over right after hydration without a setState-in-effect.
  const animates = useSyncExternalStore(noSubscription, clientCanMorph, serverCannotMorph)

  // A numeric child is a quantity: `type-counter` gives it the Counters font
  // and tabular figures (the role rule sets both).
  const classes = typeof children === "number" ? cn("type-counter", className) : className
  // torph's injected sheet pins `[torph-root]` to `vertical-align: top`, which
  // shifts a mixed-size inline row (a `text-2xl` price beside its `text-xs`
  // note) off the baseline the plain text had. The inline value wins over the
  // stylesheet and survives the library's own style cleanup.
  const resolvedStyle = { verticalAlign: "baseline" as const, ...style }

  if (!animates) {
    return createElement(as, { className: classes, style: resolvedStyle }, shown)
  }

  const tokens = getMotionTokens()
  return (
    <TextMorph
      as={as}
      className={classes}
      style={resolvedStyle}
      duration={timing === "fast" ? tokens.fast : tokens.base}
      ease={tokens.easeSnap}
      // Surviving segments translate; the house never scales text.
      scale={false}
      locale={locale}
      numbers={numbers}
    >
      {shown}
    </TextMorph>
  )
}

/**
 * Trailing-edge rate limit: a change opens a window and the LATEST value lands
 * when it closes (≤ `windowMs` behind a stream, and the final frame always
 * arrives). Trailing-only rather than leading+trailing on purpose — the
 * leading emit is a synchronous setState in an effect, and an update 120ms
 * late is invisible while a cascading render is not.
 */
function useCoalescedValue(value: string, windowMs?: number): string {
  const enabled = typeof windowMs === "number" && windowMs > 0
  const [shown, setShown] = useState(value)
  const shownRef = useRef(value)
  const latestRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latestRef.current = value
  }, [value])

  useEffect(() => {
    if (!enabled) return
    if (timerRef.current) return
    if (value === shownRef.current) return

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      shownRef.current = latestRef.current
      setShown(latestRef.current)
    }, windowMs)
  }, [value, enabled, windowMs])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  return enabled ? shown : value
}
