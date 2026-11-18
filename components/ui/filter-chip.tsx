import * as React from "react"
import { cn } from "@/lib/utils"

export interface FilterChipProps {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  count?: number
  icon?: React.ReactNode
  className?: string
  /** Brand accent color. Overrides the green selected state when active. */
  accentColor?: string
  /** Background opacity for accent (0-1). Default 0.1. */
  accentBgOpacity?: number
}

export function FilterChip({
  children,
  active = false,
  onClick,
  count,
  icon,
  className,
  accentColor,
  accentBgOpacity = 0.1,
}: FilterChipProps) {
  const useAccent = active && accentColor

  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "type-tag rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/55",
        // Selected (status chips): green-tonal — green marks the active filter.
        !useAccent && active
          ? "bg-primary-subtle text-primary-subtle-foreground hover:bg-primary-subtle/70"
          : !active
            ? "text-muted-foreground hover:text-foreground hover:bg-accent"
            : undefined,
        className
      )}
      style={useAccent ? {
        background: `color-mix(in srgb, ${accentColor} ${Math.round(accentBgOpacity * 100)}%, transparent)`,
        color: accentColor,
      } : undefined}
    >
      {icon}
      {children}
      {count !== undefined && (
        <span
          data-numeric
          className={cn(
            "min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold flex items-center justify-center",
            !useAccent && active
              ? "bg-[color-mix(in_oklab,var(--green-bright)_22%,transparent)] text-primary-subtle-foreground"
              : !active
                ? "bg-muted text-muted-foreground"
                : undefined,
          )}
          style={useAccent ? {
            background: `color-mix(in srgb, ${accentColor} ${Math.round(accentBgOpacity * 200)}%, transparent)`,
            color: accentColor,
          } : undefined}
        >
          {count}
        </span>
      )}
    </button>
  )
}
