"use client"

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import {
  EXIT_SCALE,
  getMotionTokens,
  getReflowTiming,
  prefersReducedMotion,
  supportsWebAnimations,
} from "@/lib/motion"

/**
 * A keyed grid that animates enter, exit **and sibling reflow** (RAD-275).
 *
 * The problem it solves: a plain CSS grid gives you no path for the neighbours.
 * Remove a card and every survivor snaps to its new position in a single frame,
 * so the reader loses the connection between the state change and the objects
 * that moved. The old workaround here was worse — the removal handler blocked on
 * `setTimeout(330)` so the exit animation could finish first, which bought a
 * dead third of a second and *still* ended in a hard cut.
 *
 * How this works (Motion's `mode="popLayout"`, hand-rolled — see the RAD-275
 * measurement: `motion` + `domMax`, the feature bundle `layout` animations
 * actually need, costs 41.9 KB gzip, and this grid is its only consumer):
 *
 *   1. The caller drops the item from state immediately. No timer.
 *   2. React commits without it. The grid has already reflowed in the DOM, but
 *      the browser has not painted yet.
 *   3. Our layout effect measures the survivors, compares against the rects
 *      snapshotted last commit, and plays each delta backwards with WAAPI —
 *      the classic FLIP. It also re-mounts the departed item into the same
 *      container, pinned `position: absolute` at its last rect, and fades it.
 *   4. Paint. The exit and the reflow start on the same frame.
 *
 * Notes on the fiddly parts:
 *
 * - **Rects are container-relative.** Removing a card shortens the document,
 *   which can move `scrollTop` underneath us (scroll anchoring). Subtracting the
 *   container's own rect cancels that out; viewport coordinates would not.
 * - **Interruption.** Triaging is fast — delete, delete, delete. A card that is
 *   still sliding has a stale transform, so its *layout* rect is the bounding
 *   rect minus that transform, and the new animation must start from where it
 *   currently appears. Both fall out of reading the translation before we cancel.
 * - **Survivors only ever translate.** Nothing scales, so there is no text
 *   stretching or fattened border-radius to correct for. Only the departing card
 *   scales, and it is on its way out.
 * - **A resize is not a reorder (RAD-408).** Opening or closing the sidebar
 *   changes the container's width, and every card changes column with it. That
 *   is the layout adapting, not an item moving, so nothing travels: a
 *   `ResizeObserver` re-snapshots the rects whenever the width changes between
 *   commits (so a later deletion is measured from the resized layout, and its
 *   ghost is pinned where the card really was), and a commit whose width differs
 *   from the snapshot skips the reflow and only re-snapshots. Either way an
 *   in-flight slide is cancelled: its offset was computed against the old
 *   layout, so letting it run would land the card off its new slot and then
 *   snap. The exits still play. Known characteristic: a commit that lands
 *   *during* a width transition (a delete mid-slide of the sidebar) also reads
 *   as resized, so its reflow is a clean cut rather than a slide — never a
 *   wrong slide. Width is the visual (bounding) width; nothing scales this
 *   container today, and an ancestor scale would read as a resize too.
 */

export interface AnimatedGridItem {
  key: string
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
  /** Translation applied at measurement time, already subtracted from left/top. */
  tx: number
  ty: number
}

interface ExitingEntry {
  key: string
  /** The node as it was last rendered — reused verbatim so the card never re-renders on its way out. */
  content: ReactNode
  itemClassName?: string
  rect: Rect
}

interface AnimatedGridProps<T extends AnimatedGridItem> {
  items: readonly T[]
  renderItem: (item: T, index: number) => ReactNode
  /** Grid classes. `position: relative` is added — absolute exit pins resolve against it. */
  className?: string
  style?: CSSProperties
  /** Per-item wrapper classes, e.g. `sm:col-span-2` for wide story cards. */
  itemClassName?: (item: T, index: number) => string | undefined
  /**
   * Above this many survivors the reflow is skipped and the layout change lands
   * as a clean cut. A filter switch replaces the whole set — some layouts are
   * too dense for every element to perform its own journey.
   */
  maxAnimated?: number
}

/** Stagger for the enter animation, matching the previous inline behaviour. */
const ENTER_STAGGER_MS = 50
const ENTER_STAGGER_CAP_MS = 500
/** Below this the move isn't worth animating. */
const MIN_DELTA_PX = 0.5
/** Animate reflow only for cards within one screen of the viewport. */
const VIEWPORT_MARGIN_PX = 1000

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/** Current translation of an element, in px. Pure translations only, which is all we apply. */
function readTranslate(el: HTMLElement): { x: number; y: number } {
  const transform = getComputedStyle(el).transform
  if (!transform || transform === "none") return { x: 0, y: 0 }
  const match = /matrix\(([^)]+)\)/.exec(transform)
  if (match) {
    const parts = match[1].split(",").map(Number)
    return { x: parts[4] || 0, y: parts[5] || 0 }
  }
  const match3d = /matrix3d\(([^)]+)\)/.exec(transform)
  if (match3d) {
    const parts = match3d[1].split(",").map(Number)
    return { x: parts[12] || 0, y: parts[13] || 0 }
  }
  return { x: 0, y: 0 }
}

/**
 * `translating` gates the `getComputedStyle` read, which forces a style
 * recalculation. Only a card with a FLIP still in flight can carry a leftover
 * translation, and at 2000 cards paying that per element per commit is the
 * difference between a sub-millisecond pass and a janky one.
 */
function measure(el: HTMLElement, containerRect: DOMRect, translating: boolean): { rect: Rect; viewport: DOMRect } {
  const t = translating ? readTranslate(el) : { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return {
    // Subtracting the translation yields the settled layout position — where the
    // element belongs, not where it currently appears mid-animation.
    rect: {
      left: r.left - containerRect.left - t.x,
      top: r.top - containerRect.top - t.y,
      width: r.width,
      height: r.height,
      tx: t.x,
      ty: t.y,
    },
    viewport: r,
  }
}

interface Measured {
  containerWidth: number
  elements: Map<string, HTMLElement>
  rects: Map<string, Rect>
  viewportRects: Map<string, DOMRect>
}

/** Container-relative rects of every live card — the snapshot each FLIP is measured against. */
function measureLive(container: HTMLElement, flips: Map<string, Animation>): Measured {
  const containerRect = container.getBoundingClientRect()
  const elements = new Map<string, HTMLElement>()
  const rects = new Map<string, Rect>()
  const viewportRects = new Map<string, DOMRect>()
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-agstate="live"]'))) {
    const key = el.dataset.agkey
    if (!key) continue
    elements.set(key, el)
    const { rect, viewport } = measure(el, containerRect, flips.has(key))
    rects.set(key, rect)
    viewportRects.set(key, viewport)
  }
  return { containerWidth: containerRect.width, elements, rects, viewportRects }
}

function cancelFlips(flips: Map<string, Animation>) {
  for (const animation of flips.values()) animation.cancel()
  flips.clear()
}

function isNearViewport(r: DOMRect): boolean {
  if (typeof window === "undefined") return true
  return r.bottom > -VIEWPORT_MARGIN_PX && r.top < window.innerHeight + VIEWPORT_MARGIN_PX
}

export function AnimatedGrid<T extends AnimatedGridItem>({
  items,
  renderItem,
  className,
  style,
  itemClassName,
  maxAnimated = 200,
}: AnimatedGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [exiting, setExiting] = useState<ExitingEntry[]>([])

  /** Keys and rendered content from the previous commit — the source for an exit. */
  const prevContentRef = useRef(new Map<string, { content: ReactNode; itemClassName?: string }>())
  const prevKeysRef = useRef<string[]>([])
  /** Settled, container-relative positions from the previous commit. */
  const prevRectsRef = useRef(new Map<string, Rect>())
  /** The container's width when `prevRectsRef` was taken; null before the first commit. */
  const prevWidthRef = useRef<number | null>(null)
  const flipRef = useRef(new Map<string, Animation>())
  /** Keys adopted into the exit layer. */
  const exitStartedRef = useRef(new Set<string>())
  /** Keys whose exit animation is already running. */
  const exitPlayingRef = useRef(new Set<string>())

  const liveKeys = new Set(items.map((item) => item.key))

  // Live children. The wrapper (not the caller) owns the enter animation, so the
  // exit layer can leave it off — otherwise a departing card would fade *in*.
  const liveContent = new Map<string, { content: ReactNode; itemClassName?: string }>()
  const liveChildren = items.map((item, index) => {
    const content = renderItem(item, index)
    const itemClass = itemClassName?.(item, index)
    liveContent.set(item.key, { content, itemClassName: itemClass })
    return (
      <div
        key={item.key}
        data-agkey={item.key}
        data-agstate="live"
        className={cn("will-animate animate-fade-in-scale", itemClass)}
        style={{ animationDelay: `${Math.min(index * ENTER_STAGGER_MS, ENTER_STAGGER_CAP_MS)}ms` }}
      >
        {content}
      </div>
    )
  })

  // Departing cards are appended rather than spliced back in at their old index —
  // they're absolutely positioned, so DOM order doesn't affect where they sit, and
  // appending leaves every survivor's position in the list untouched.
  const exitChildren = exiting
    .filter((entry) => !liveKeys.has(entry.key))
    .map((entry) => (
      <div
        key={entry.key}
        data-agkey={entry.key}
        data-agstate="exit"
        aria-hidden="true"
        className={cn("pointer-events-none", entry.itemClassName)}
        style={{
          position: "absolute",
          // The rect came from getBoundingClientRect, i.e. a *border* box. Without
          // pinning box-sizing, an ambient `content-box` would add this element's
          // padding and border on top and the card would visibly flare the instant
          // it starts leaving. Tailwind's preflight makes that a non-issue in this
          // app today, but the grid shouldn't depend on its surroundings for it.
          boxSizing: "border-box",
          left: entry.rect.left + entry.rect.tx,
          top: entry.rect.top + entry.rect.ty,
          width: entry.rect.width,
          height: entry.rect.height,
        }}
      >
        {entry.content}
      </div>
    ))

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const prevKeys = prevKeysRef.current
    const prevRects = prevRectsRef.current
    const prevContent = prevContentRef.current
    const tokens = getMotionTokens()
    const reduced = prefersReducedMotion()
    const reflow = getReflowTiming()

    const { containerWidth, elements, rects: nextRects, viewportRects } = measureLive(container, flipRef.current)

    // A width the snapshot was not taken at means the layout was resized under
    // us (the observer below normally catches that first). Every column moved,
    // so a delta against the old rects is the resize, not a reorder.
    const resized =
      prevWidthRef.current !== null && Math.abs(containerWidth - prevWidthRef.current) >= MIN_DELTA_PX
    if (resized) cancelFlips(flipRef.current)

    // --- 1. FLIP the survivors -------------------------------------------------
    if (!reduced && !resized && nextRects.size <= maxAnimated) {
      for (const [key, next] of nextRects) {
        const prev = prevRects.get(key)
        if (!prev) continue // just entered — it fades in, it doesn't travel
        const el = elements.get(key)
        if (!el || !supportsWebAnimations(el)) continue
        if (!isNearViewport(viewportRects.get(key)!)) continue

        // Gate on the *layout* delta, not the visual one. A card that is still
        // sliding has a leftover translation, and an unrelated re-render mid-slide
        // must not read that as movement — it would cancel and restart the
        // animation on every render, stretching a 300ms slide indefinitely.
        const layoutDx = prev.left - next.left
        const layoutDy = prev.top - next.top
        if (Math.abs(layoutDx) < MIN_DELTA_PX && Math.abs(layoutDy) < MIN_DELTA_PX) continue

        // It did move. Fold the leftover translation in so the new animation
        // starts from where the card actually appears right now.
        const dx = layoutDx + next.tx
        const dy = layoutDy + next.ty

        flipRef.current.get(key)?.cancel()
        const animation = el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          reflow
        )
        flipRef.current.set(key, animation)
        animation.finished
          .then(() => {
            if (flipRef.current.get(key) === animation) flipRef.current.delete(key)
          })
          .catch(() => {
            /* cancelled by a newer reflow */
          })
      }
    }

    // --- 2. Adopt anything that just left --------------------------------------
    const departed: ExitingEntry[] = []
    for (const key of prevKeys) {
      if (liveKeys.has(key)) continue
      if (exitStartedRef.current.has(key)) continue
      const content = prevContent.get(key)
      const rect = prevRects.get(key)
      if (!content || !rect) continue
      // Delete a card that is itself still sliding and its FLIP would fight the
      // exit for the transform property. Cancel it — the ghost is pinned at the
      // visual position (rect + leftover translation), so it fades from exactly
      // where the card appears, no jump.
      flipRef.current.get(key)?.cancel()
      flipRef.current.delete(key)
      exitStartedRef.current.add(key)
      departed.push({ key, content: content.content, itemClassName: content.itemClassName, rect })
    }

    // --- 3. Play the exits (they exist in the DOM on the pass after adoption) ---
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-agstate="exit"]'))) {
      const key = el.dataset.agkey
      // Tracked in refs rather than on the element, so the bookkeeping doesn't
      // depend on DOM identity. Both sets are cleared in `drop()` and when a key
      // comes back — miss either and that card's *second* departure is skipped.
      if (!key || exitPlayingRef.current.has(key)) continue
      exitPlayingRef.current.add(key)

      const drop = () => {
        exitStartedRef.current.delete(key)
        exitPlayingRef.current.delete(key)
        setExiting((current) => current.filter((entry) => entry.key !== key))
      }

      if (!supportsWebAnimations(el)) {
        drop()
        continue
      }

      const keyframes: Keyframe[] = reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: `scale(${EXIT_SCALE})` },
          ]
      // Short and decisive: the card is leaving, and it has to clear the frame
      // before the siblings finish settling — the reflow spring runs longer than
      // this on purpose. One thing responds, the layout adapts, the system settles.
      const animation = el.animate(keyframes, {
        duration: reduced ? tokens.fast : tokens.base,
        easing: reduced ? tokens.easeExit : tokens.easeDismiss,
        fill: "forwards",
      })
      animation.finished.then(drop).catch(drop)
    }

    // --- 4. Snapshot for the next commit ---------------------------------------
    prevKeysRef.current = items.map((item) => item.key)
    prevRectsRef.current = nextRects
    prevWidthRef.current = containerWidth
    prevContentRef.current = liveContent

    // Setting state from a layout effect re-renders synchronously, so the
    // departing card is pinned and painted in the same frame as the reflow.
    if (departed.length > 0) {
      setExiting((current) => [...current, ...departed])
    }
  })

  // Re-snapshot when the container's width changes between commits (the sidebar
  // toggle's width transition, a window resize). Without it the rects describe
  // the old layout until the next commit, and that commit — a deletion, say —
  // would slide every survivor across the resize and pin the ghost in a column
  // that no longer exists. Height changes are left alone: rows growing as
  // images load don't move a card's column, and the commit re-measures anyway.
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      const prevWidth = prevWidthRef.current
      const width = container.getBoundingClientRect().width
      if (prevWidth === null || Math.abs(width - prevWidth) < MIN_DELTA_PX) return
      cancelFlips(flipRef.current)
      const { containerWidth, rects } = measureLive(container, flipRef.current)
      prevRectsRef.current = rects
      prevWidthRef.current = containerWidth
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // A key can come back — an optimistic delete that failed, a restore. Cancel the
  // exit so it doesn't linger as a ghost behind the live card.
  useIsomorphicLayoutEffect(() => {
    if (exiting.length === 0) return
    const returned = exiting.filter((entry) => liveKeys.has(entry.key))
    if (returned.length === 0) return
    for (const entry of returned) {
      exitStartedRef.current.delete(entry.key)
      exitPlayingRef.current.delete(entry.key)
    }
    setExiting((current) => current.filter((entry) => !liveKeys.has(entry.key)))
  })

  // One flat array rather than `{liveChildren}{exitChildren}`, so every key lives
  // in a single namespace and the whole list is one reconciliation.
  //
  // Known characteristic: a departing card *does* remount. The commit that drops
  // it doesn't yet know it's exiting (the layout effect works that out afterwards
  // and re-adds it), so React unmounts and remounts the subtree. That all happens
  // inside one frame, before paint, and the thumbnail comes from cache — verified
  // against the real grid — so nothing flickers. Deriving the exit set during
  // render instead would avoid the remount but isn't safe under concurrent
  // rendering, which is a worse trade.
  return (
    <div ref={containerRef} className={cn("relative", className)} style={style}>
      {[...liveChildren, ...exitChildren]}
    </div>
  )
}
