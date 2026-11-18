"use client"

/**
 * The desktop presentation of the peek (RAD-345, `lg` and up): a non-modal
 * panel docked to the right, full viewport height, with its own scroll.
 *
 * Non-modal on purpose — the list behind it stays visible — but a click outside
 * closes it: the panel is a reading surface, not a split view, and the click
 * that dismisses must not also open whatever it landed on.
 *
 * Composition mirrors the full-page post rather than a narrow sidebar: the
 * article is the page's own reading column (`max-w-[850px]`, the page's gutter)
 * centred inside a panel that takes two thirds of the viewport. No card chrome
 * — no corner radius, no shadow: the surface is the panel itself, separated
 * from the list by `bg-card` plus one hairline.
 *
 * `z-50` sits above the app header (40) because the panel is full height and
 * covers it; Radix menus and nested dialogs opened afterwards are appended
 * later in the DOM and still stack above the panel.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog"
import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { PeekHeader } from "./peek-header"
import { PeekColumn } from "./peek-column"
import type { PeekPresentationProps } from "./peek-props"

export function PeekPanel({
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
  const scrollerRef = useRef<HTMLDivElement>(null)

  // A new target starts at its top: the panel does not move, only its content
  // changes, so a carry-over scroll position would open the next item halfway
  // down its body. Feature-detected: jsdom has no `Element.scrollTo`.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (typeof el.scrollTo === "function") el.scrollTo({ top: 0 })
    else el.scrollTop = 0
  }, [href])

  return (
    <DialogPrimitive.Root open={open} modal={false} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          // Radix labels the dialog from the Title in the header; there is no
          // description, and leaving `aria-describedby` unset silences its
          // second dev warning.
          aria-describedby={undefined}
          // A click outside closes (the Radix default). The excerpt pill is
          // portaled to <body> but belongs to the article — dismissing on it
          // would throw away the selection being saved.
          onPointerDownOutside={(event) => {
            const target = event.target as HTMLElement | null
            if (target?.closest?.("[data-excerpt-pill]")) event.preventDefault()
          }}
          // Focus moving out is not a dismissal: the panel holds no trap, and
          // tabbing to the browser chrome must not close what you are reading.
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            const target = restoreFocus?.()
            if (target) {
              event.preventDefault()
              target.focus({ preventScroll: true })
            }
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[min(960px,66vw)] flex-col",
            "bg-card border-l border-hairline",
            "focus:outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
            "data-[state=open]:duration-[var(--dur-open)] data-[state=closed]:duration-[var(--dur-close)]",
            "data-[state=open]:ease-[var(--ease-snap)] data-[state=closed]:ease-[var(--ease-exit)]"
          )}
        >
          <PeekHeader
            title={title}
            href={href}
            onClose={onClose}
            onNavigate={onNavigate}
            canPrevious={canPrevious}
            canNext={canNext}
            className="shrink-0 px-2 py-1.5"
          />
          {/* The page's own reading column — gutter, measure and card inset —
              restored by `PeekColumn`; only the card's visuals are omitted. */}
          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-stable-both overscroll-contain">
            <PeekColumn>{children}</PeekColumn>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
