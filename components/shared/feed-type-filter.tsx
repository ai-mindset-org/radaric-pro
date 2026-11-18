"use client"

import { Rss, Send, Sparkles, Youtube } from "lucide-react"
import { useTheme } from "next-themes"
import { FilterChip } from "@/components/ui/filter-chip"
import { XIcon } from "@/components/ui/icons"

export type SourceTypeFilter = "ALL" | "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "EVENT_TRIGGER"

/** Brand colors per source type (Radix hex), matching source-type-cards.tsx */
const SOURCE_TYPE_COLORS: Record<string, string> = {
  RSS: "#f76b15",                     // Radix orange-9
  TELEGRAM: "#0090ff",               // Radix blue-9
  TWITTER_LIGHT: "#1a211e",          // sage-12 (dark on light)
  TWITTER_DARK: "#eceeed",           // sage-12 dark (light on dark)
  YOUTUBE: "#e5484d",                // Radix red-9 (not brand #FF0000 — AA)
  EVENT_TRIGGER: "#8e4ec6",          // Radix purple-9
}

const SPECIFIC_TYPES: SourceTypeFilter[] = ["RSS", "TELEGRAM", "TWITTER", "YOUTUBE", "EVENT_TRIGGER"]

interface FeedTypeFilterProps {
  activeFilters: SourceTypeFilter[]
  onFilterChange: (filters: SourceTypeFilter[]) => void
  counts?: {
    ALL: number
    RSS: number
    TELEGRAM: number
    TWITTER: number
    YOUTUBE: number
    EVENT_TRIGGER: number
  }
  showCounts?: boolean
}

export function FeedTypeFilterChips({
  activeFilters,
  onFilterChange,
  counts,
  showCounts = true,
}: FeedTypeFilterProps) {
  const { resolvedTheme } = useTheme()
  const twitterColor = resolvedTheme === "dark" ? SOURCE_TYPE_COLORS.TWITTER_DARK : SOURCE_TYPE_COLORS.TWITTER_LIGHT

  const isAll = activeFilters.includes("ALL") || activeFilters.length === 0

  function toggle(type: SourceTypeFilter) {
    if (type === "ALL") {
      // "All" is a reset — deselect everything
      onFilterChange(["ALL"])
      return
    }

    let next: SourceTypeFilter[]
    if (isAll) {
      // Currently showing all — switch to just this type
      next = [type]
    } else if (activeFilters.includes(type)) {
      // Deselect this type
      next = activeFilters.filter((t) => t !== type)
      // If nothing left, fall back to All
      if (next.length === 0) next = ["ALL"]
    } else {
      // Add this type
      next = [...activeFilters.filter((t) => t !== "ALL"), type]
    }

    // If all specific types are selected, simplify to "ALL"
    if (SPECIFIC_TYPES.every((t) => next.includes(t))) {
      next = ["ALL"]
    }

    onFilterChange(next)
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
      <FilterChip
        active={isAll}
        onClick={() => toggle("ALL")}
        count={showCounts ? counts?.ALL : undefined}
      >
        All
      </FilterChip>
      <FilterChip
        active={!isAll && activeFilters.includes("RSS")}
        onClick={() => toggle("RSS")}
        icon={<Rss className="h-[14px] w-[14px]" />}
        count={showCounts ? counts?.RSS : undefined}
        accentColor={SOURCE_TYPE_COLORS.RSS}
      >
        RSS
      </FilterChip>
      <FilterChip
        active={!isAll && activeFilters.includes("TELEGRAM")}
        onClick={() => toggle("TELEGRAM")}
        icon={<Send className="h-[14px] w-[14px]" />}
        count={showCounts ? counts?.TELEGRAM : undefined}
        accentColor={SOURCE_TYPE_COLORS.TELEGRAM}
      >
        Telegram
      </FilterChip>
      <FilterChip
        active={!isAll && activeFilters.includes("TWITTER")}
        onClick={() => toggle("TWITTER")}
        icon={<XIcon className="h-[14px] w-[14px]" />}
        count={showCounts ? counts?.TWITTER : undefined}
        accentColor={twitterColor}
        accentBgOpacity={resolvedTheme === "dark" ? 0.1 : 0.05}
      >
        X
      </FilterChip>
      <FilterChip
        active={!isAll && activeFilters.includes("YOUTUBE")}
        onClick={() => toggle("YOUTUBE")}
        icon={<Youtube className="h-[14px] w-[14px]" />}
        count={showCounts ? counts?.YOUTUBE : undefined}
        accentColor={SOURCE_TYPE_COLORS.YOUTUBE}
      >
        YouTube
      </FilterChip>
      <FilterChip
        active={!isAll && activeFilters.includes("EVENT_TRIGGER")}
        onClick={() => toggle("EVENT_TRIGGER")}
        icon={<Sparkles className="h-[14px] w-[14px]" />}
        count={showCounts ? counts?.EVENT_TRIGGER : undefined}
        accentColor={SOURCE_TYPE_COLORS.EVENT_TRIGGER}
      >
        Event Triggers
      </FilterChip>
    </div>
  )
}
