"use client"

/**
 * The utility half of a reading page's action rail: open-original, archive,
 * send-to-Notion, delete.
 *
 * Icon-only at every width, and that is what keeps the rail on one line at
 * 375px — six 44px targets (two signals + four utilities) plus gaps come to
 * ~274px inside a 371px rail, so there is no overflow menu and no wrap; it
 * still fits at 320px. Each button carries `aria-label` + `title`, which is
 * the whole accessible name once the visible labels are gone.
 */

import { Loader2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ReadingAction = {
  key: string
  label: string
  icon: LucideIcon
  /** External link target — renders an anchor instead of a button. */
  href?: string
  onSelect?: () => void
  disabled?: boolean
  busy?: boolean
  destructive?: boolean
}

function ActionIconButton({ action }: { action: ReadingAction }) {
  const Icon = action.busy ? Loader2 : action.icon
  const className = cn(
    // The app's density unit is `--spacing: 0.2rem`, so `size="icon"` resolves
    // to 35.2px — fine under a pointer, under the floor under a thumb. The rail
    // is icon-only, so it IS the touch surface. Gated on `pointer: coarse`
    // rather than a width breakpoint: a portrait iPad is 768 CSS px wide and
    // still driven by a thumb.
    "shrink-0 h-[44px] w-[44px] [@media(pointer:fine)]:h-11 [@media(pointer:fine)]:w-11",
    action.destructive && "hover:text-destructive hover:bg-destructive-subtle"
  )
  const icon = (
    <Icon className={cn("h-[16px] w-[16px]", action.busy && "animate-spin")} />
  )

  if (action.href) {
    return (
      <Button variant="ghost" size="icon" asChild className={className} aria-label={action.label} title={action.label}>
        <a href={action.href} target="_blank" rel="noopener noreferrer">
          {icon}
        </a>
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={action.onSelect}
      disabled={action.disabled || action.busy}
      className={className}
      aria-label={action.label}
      title={action.label}
    >
      {icon}
    </Button>
  )
}

export function ReadingActions({ actions }: { actions: ReadingAction[] }) {
  return (
    <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
      {actions.map((action) => (
        <ActionIconButton key={action.key} action={action} />
      ))}
    </div>
  )
}
