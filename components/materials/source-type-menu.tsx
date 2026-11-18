"use client"

/**
 * Source-type filtering as one compact menu (RAD-318 Phase 3).
 *
 * This replaces a permanent row of six chips. It applies live — every change is
 * one `/api/posts` request, and rapid changes are handled by the request
 * generation in `MaterialsList` (a superseded response is aborted and never
 * merged) rather than by a draft the user has to commit. A draft with an Apply
 * button was considered and overruled: on
 * mobile the dominant way to leave a menu is a tap outside, which would throw
 * the selection away silently.
 *
 * Radix supplies roving focus, typeahead and `menuitemcheckbox` semantics;
 * `onSelect` is prevented so the menu survives a change, which is what makes
 * multi-select usable at all.
 */

import { ChevronDown, Rss, Send, Sparkles, Youtube } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { XIcon } from "@/components/ui/icons"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SourceTypeFilter } from "@/components/shared/feed-type-filter"

/** The five real types, in the order the chips used. Legacy INTEREST folds into EVENT_TRIGGER. */
const TYPES: { value: Exclude<SourceTypeFilter, "ALL">; label: string; icon: React.ReactNode }[] = [
  { value: "RSS", label: "RSS", icon: <Rss className="h-[14px] w-[14px]" /> },
  { value: "TELEGRAM", label: "Telegram", icon: <Send className="h-[14px] w-[14px]" /> },
  { value: "TWITTER", label: "X", icon: <XIcon className="h-[14px] w-[14px]" /> },
  { value: "YOUTUBE", label: "YouTube", icon: <Youtube className="h-[14px] w-[14px]" /> },
  { value: "EVENT_TRIGGER", label: "Event triggers", icon: <Sparkles className="h-[14px] w-[14px]" /> },
]

export type SourceTypeCounts = Partial<Record<SourceTypeFilter, number>>

export interface SourceTypeMenuProps {
  value: SourceTypeFilter[]
  onChange: (next: SourceTypeFilter[]) => void
  counts?: SourceTypeCounts
  disabled?: boolean
  /** Mobile row: every target carries the 44px floor as explicit pixels. */
  touchTarget?: boolean
  className?: string
}

/** Unrestricted is expressed as ["ALL"] or []; both mean the same thing. */
export function isAllTypesSelected(value: SourceTypeFilter[]): boolean {
  return value.length === 0 || value.includes("ALL")
}

/** "All types", the one selected type's name, or "N types". */
export function sourceTypeLabel(value: SourceTypeFilter[]): string {
  if (isAllTypesSelected(value)) return "All types"
  const selected = TYPES.filter(t => value.includes(t.value))
  if (selected.length === 1) return selected[0].label
  return `${selected.length} types`
}

export function SourceTypeMenu({
  value,
  onChange,
  counts,
  disabled,
  touchTarget,
  className,
}: SourceTypeMenuProps) {
  const { resolvedTheme } = useTheme()
  const isAll = isAllTypesSelected(value)

  function toggle(type: Exclude<SourceTypeFilter, "ALL">) {
    // From "all", the first click means "only this one" — the same reading the
    // chips had, and the only one that does not require six clicks to narrow.
    const next = isAll
      ? [type]
      : value.includes(type)
        ? value.filter(t => t !== type)
        : [...value.filter(t => t !== "ALL"), type]

    // Nothing selected and everything selected are both "all types". An empty
    // selection must never become an invisible filter matching nothing.
    if (next.length === 0 || TYPES.every(t => next.includes(t.value))) {
      onChange(["ALL"])
      return
    }
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={[touchTarget ? "min-h-[44px] min-w-[44px]" : "md:h-9", className].filter(Boolean).join(" ")}
        >
          <span className="truncate">{sourceTypeLabel(value)}</span>
          <ChevronDown className="ml-1.5 h-[14px] w-[14px] opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      {/* Bounded so five items plus All never run off a short viewport. */}
      <DropdownMenuContent align="start" className="w-56 max-h-[min(60vh,20rem)] overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={isAll}
          onSelect={e => e.preventDefault()}
          onCheckedChange={() => onChange(["ALL"])}
        >
          <span className="flex-1">All types</span>
          {typeof counts?.ALL === "number" && (
            <span className="ml-2 text-xs type-counter text-muted-foreground">{counts.ALL}</span>
          )}
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />

        {TYPES.map(type => (
          <DropdownMenuCheckboxItem
            key={type.value}
            checked={!isAll && value.includes(type.value)}
            onSelect={e => e.preventDefault()}
            onCheckedChange={() => toggle(type.value)}
          >
            <span
              className="mr-2 flex items-center"
              aria-hidden="true"
              style={
                type.value === "TWITTER" && resolvedTheme === "dark"
                  ? { color: "var(--foreground)" }
                  : undefined
              }
            >
              {type.icon}
            </span>
            <span className="flex-1">{type.label}</span>
            {typeof counts?.[type.value] === "number" && (
              <span className="ml-2 text-xs type-counter text-muted-foreground">{counts[type.value]}</span>
            )}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
