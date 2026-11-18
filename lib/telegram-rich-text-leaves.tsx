"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Interactive leaves for Telegram rich text. The converter
 * (lib/telegram-entities-to-react.tsx) stays directive-free so it can be called
 * from any render context; only these two need client state.
 */

/** Blurred until the reader asks for it — click, Enter or Space. */
export function TelegramSpoiler({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)

  return (
    <button
      type="button"
      aria-expanded={revealed}
      aria-label={revealed ? "Hide spoiler" : "Reveal spoiler"}
      onClick={(event) => {
        event.stopPropagation()
        setRevealed((value) => !value)
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        "inline cursor-pointer select-none rounded-xs text-left transition-[filter] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
        !revealed && "blur-[4px]"
      )}
    >
      <span aria-hidden={!revealed}>{children}</span>
    </button>
  )
}

/** Telegram's expandable quote: three lines, then a Show more toggle. */
export function TelegramCollapsedQuote({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <blockquote className="my-3 rounded-md bg-muted px-3.5 py-2.5 text-[0.95em] leading-relaxed">
      <div className={cn(!expanded && "line-clamp-3")}>{children}</div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation()
          setExpanded((value) => !value)
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="mt-1.5 inline-flex min-h-[44px] items-center rounded-xs text-sm font-medium text-primary-emphasis hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </blockquote>
  )
}
