"use client"

/**
 * The peek's header row — one instance, shared by the desktop panel and the
 * mobile sheet (RAD-345).
 *
 * Left to right: previous / next (the order is the visible grid's, `J`/`K`
 * mirror them), then "open full page" and close pinned right.
 *
 * **No visible title**: the article's own headline is a few pixels below, and
 * repeating it here would be noise. The title node stays in the
 * DOM, screen-reader-only, because it is the dialog's stable accessible name —
 * it must survive the skeleton, an error and every swap, which the article's
 * `h1` cannot.
 *
 * Touch targets follow the rail's rule: 44px under a coarse pointer, 35.2px
 * (`size="icon-sm"`) under a fine one.
 */

import Link from "next/link"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const TARGET = "h-[44px] w-[44px] [@media(pointer:fine)]:h-9 [@media(pointer:fine)]:w-9 rounded-sm"

export function PeekHeader({
  title,
  href,
  onClose,
  onNavigate,
  canPrevious,
  canNext,
  className,
}: {
  /** Empty while loading; the accessible name falls back to "Preview". */
  title: string
  href: string
  onClose: () => void
  onNavigate?: (direction: "next" | "previous") => void
  canPrevious: boolean
  canNext: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={TARGET}
        aria-label="Previous item"
        title="Previous (K)"
        disabled={!canPrevious}
        onClick={() => onNavigate?.("previous")}
      >
        <ChevronUp className="h-[16px] w-[16px]" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={TARGET}
        aria-label="Next item"
        title="Next (J)"
        disabled={!canNext}
        onClick={() => onNavigate?.("next")}
      >
        <ChevronDown className="h-[16px] w-[16px]" aria-hidden="true" />
      </Button>

      {/*
        Radix's own Title, so the id the dialog points `aria-labelledby` at is
        the id that exists (and the dev warning about a missing DialogTitle
        stops firing). `asChild` keeps it a span — the article's `h1` is the
        heading; this node only carries the dialog's name, through the skeleton,
        an error and every swap.
      */}
      <DialogPrimitive.Title asChild>
        <span className="sr-only">{title || "Preview"}</span>
      </DialogPrimitive.Title>

      <div className="ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className={TARGET}
          asChild
          aria-label="Open full page"
          title="Open full page"
        >
          <Link href={href}>
            <Maximize2 className="h-[16px] w-[16px]" aria-hidden="true" />
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={TARGET}
          aria-label="Close preview"
          title="Close"
          onClick={onClose}
        >
          <X className="h-[16px] w-[16px]" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
