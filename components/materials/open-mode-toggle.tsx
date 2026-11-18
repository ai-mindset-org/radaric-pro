"use client"

/**
 * The open-mode toggle (RAD-345) — where a card click sends a post or story.
 *
 * One button at every width, not a two-segment control: this toolbar's
 * composition rule is "one instance of every control, rows are placement, not
 * duplication", and a segmented pair cannot collapse into one element without
 * either duplicating it behind a `hidden` class or losing the second segment on
 * mobile — where two 44px segments would truncate the source name to a few
 * characters at 375px. The button shows the **current** mode and carries the
 * state the way every other toggle in the app does: `aria-pressed` plus a tonal
 * green fill when the side panel is active.
 *
 * Icon choice: `PanelRight` deliberately mirrors the header's `PanelLeft`
 * sidebar control (same family, same meaning — "a panel"), and `Maximize2`
 * reads as "the whole page" beside it. The tooltip names what pressing will
 * do, which is the one thing an icon-only toggle cannot say by itself.
 */

import { Maximize2, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { OpenMode } from "./use-open-mode"

export function OpenModeToggle({
  value,
  onChange,
  className,
}: {
  value: OpenMode
  onChange: (next: OpenMode) => void
  className?: string
}) {
  const isDrawer = value === "drawer"
  const Icon = isDrawer ? PanelRight : Maximize2

  return (
    <button
      type="button"
      aria-pressed={isDrawer}
      aria-label="Side panel"
      title={isDrawer ? "Switch to full page" : "Switch to side panel"}
      onClick={() => onChange(isDrawer ? "page" : "drawer")}
      className={cn(
        // Same shape as the toolbar's icon buttons: 35.2px is `size="icon"`, so
        // the 44px touch floor is written explicitly below `sm`.
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm transition-colors duration-150 ease-[var(--ease-snap)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/55 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0",
        isDrawer
          ? "bg-primary-subtle text-primary-emphasis hover:bg-primary-subtle/70"
          : "text-muted-foreground ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground",
        className
      )}
    >
      <Icon className="h-[16px] w-[16px]" aria-hidden="true" />
    </button>
  )
}
