"use client"

/**
 * The mobile presentation of the peek (RAD-345, below `lg`): an iOS-like bottom
 * sheet — rounded top, grab handle, backdrop, focus trap (Radix is modal here),
 * swipe-down to dismiss.
 *
 * The drag is deliberately narrow, because gesture arbitration on iOS is where
 * hand-rolled sheets break:
 *   - it starts **only from the handle zone** (`touch-action: none`, so the
 *     browser never claims the gesture for a scroll), never from the scroller;
 *   - releasing while the content is scrolled snaps back (`dismissDecision`
 *     owns the thresholds, `lib/peek/drag.ts`);
 *   - the settle is a spring and the dismissal runs on `--ease-dismiss` —
 *     both read from `lib/motion.ts`, never copied — and both collapse under
 *     `prefers-reduced-motion` while the gesture itself stays live.
 *
 * The transform lives on the inner surface, not on the Radix content: the
 * content carries the enter/exit animations, and `animation-fill-mode: both`
 * would win over an inline transform on the same element.
 */

import { useCallback, useEffect, useRef } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import type React from "react"
import { cn } from "@/lib/utils"
import { dismissDecision, rubberBand } from "@/lib/peek/drag"
import { getMotionTokens, getReflowTiming, prefersReducedMotion, supportsWebAnimations } from "@/lib/motion"
import { PeekHeader } from "./peek-header"
import { PeekColumn } from "./peek-column"
import type { PeekPresentationProps } from "./peek-props"

export function PeekSheet({
  open,
  onClose,
  title,
  href,
  onNavigate,
  canPrevious = false,
  canNext = false,
  restoreFocus,
  children,
}: PeekPresentationProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startY: number
    startTime: number
    deltaY: number
    active: boolean
  } | null>(null)

  const resetSurface = useCallback(() => {
    const el = surfaceRef.current
    if (el) el.style.transform = ""
  }, [])

  // A new target starts at its top — same rule as the desktop panel, and the
  // same feature detection (jsdom has no `Element.scrollTo`).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (typeof el.scrollTo === "function") el.scrollTo({ top: 0 })
    else el.scrollTop = 0
  }, [href])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTime: performance.now(),
      deltaY: 0,
      active: true,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // jsdom and older engines: the gesture still tracks via move events.
    }
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !drag.active || drag.pointerId !== event.pointerId) return
    const raw = event.clientY - drag.startY
    drag.deltaY = raw
    const el = surfaceRef.current
    if (!el) return
    // Upward travel is rubber-banded: the sheet is already fully open.
    const offset = raw < 0 ? rubberBand(raw, typeof window === "undefined" ? 800 : window.innerHeight) : raw
    el.style.transform = `translateY(${offset}px)`
  }, [])

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current
      if (!drag || !drag.active || drag.pointerId !== event.pointerId) return
      drag.active = false
      dragRef.current = null

      const el = surfaceRef.current
      const reduced = prefersReducedMotion()

      if (cancelled) {
        resetSurface()
        return
      }

      const elapsed = Math.max(1, performance.now() - drag.startTime)
      const velocity = drag.deltaY / elapsed
      const decision = dismissDecision({
        deltaY: drag.deltaY,
        velocity,
        scrollTop: scrollerRef.current?.scrollTop ?? 0,
        reducedMotion: reduced,
      })

      if (!el || !supportsWebAnimations(el)) {
        resetSurface()
        if (decision === "dismiss") onClose()
        return
      }

      const from = el.style.transform || "translateY(0px)"

      if (decision === "dismiss") {
        // Leave the surface where it lands: Radix unmounts the content after
        // its own exit animation and the next open mounts a fresh node, so the
        // inline transform cannot leak into a later open.
        const tokens = getMotionTokens()
        el.animate(
          [{ transform: from }, { transform: "translateY(100%)" }],
          { duration: reduced ? 1 : tokens.base, easing: tokens.easeDismiss, fill: "forwards" }
        ).finished.then(onClose, onClose)
      } else {
        const timing = getReflowTiming()
        el.animate(
          [{ transform: from }, { transform: "translateY(0px)" }],
          { duration: reduced ? 1 : timing.duration, easing: timing.easing, fill: "none" }
        ).finished.then(resetSurface, resetSurface)
      }
    },
    [onClose, resetSurface]
  )

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/80",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=open]:duration-[var(--dur-open)] data-[state=closed]:duration-[var(--dur-close)]"
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // The excerpt pill is a child of <body> (its coordinates are
          // viewport-fixed) and therefore outside this modal layer: without the
          // exemption, tapping "Save excerpt" would dismiss the sheet and eat
          // the tap.
          onPointerDownOutside={(event) => {
            const target = event.target as HTMLElement | null
            if (target?.closest?.("[data-excerpt-pill]")) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            const target = restoreFocus?.()
            if (target) {
              event.preventDefault()
              target.focus({ preventScroll: true })
            }
          }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 focus:outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
            "data-[state=open]:duration-[var(--dur-open)] data-[state=closed]:duration-[var(--dur-close)]",
            "data-[state=open]:ease-[var(--ease-snap)] data-[state=closed]:ease-[var(--ease-exit)]"
          )}
        >
          {/* The surface — this is what the drag moves. */}
          <div
            ref={surfaceRef}
            className="flex max-h-[92svh] flex-col rounded-t-2xl bg-card border-t border-hairline shadow-[var(--shadow-card)]"
          >
            {/* Handle zone — the sheet's only drag origin. */}
            <div
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => handlePointerEnd(event, false)}
              onPointerCancel={(event) => handlePointerEnd(event, true)}
              className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
            >
              <div className="flex justify-center pt-3 pb-1" aria-hidden="true">
                <span className="h-1 w-9 rounded-full bg-muted-foreground/30" />
              </div>
              <PeekHeader
                title={title}
                href={href}
                onClose={onClose}
                onNavigate={onNavigate}
                canPrevious={canPrevious}
                canNext={canNext}
                className="px-2 pb-1.5"
              />
            </div>

            <div
              ref={scrollerRef}
              className="min-h-0 flex-1 overflow-y-auto scrollbar-stable-both overscroll-contain pb-[env(safe-area-inset-bottom)]"
            >
              <PeekColumn>{children}</PeekColumn>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
