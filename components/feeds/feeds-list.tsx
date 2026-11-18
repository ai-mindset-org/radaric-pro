"use client"

import { useState, useMemo } from "react"
import { Plus, ArrowUpDown } from "lucide-react"
import Link from "next/link"
import { FeedCard } from "./feed-card"
import {
  FeedTypeFilterChips,
  type SourceTypeFilter,
} from "@/components/shared/feed-type-filter"
import { Button } from "@/components/ui/button"
import { FilterChip } from "@/components/ui/filter-chip"

type StatusFilter = "ALL" | "ACTIVE" | "PAUSED" | "ERROR"
type SortOption = "date-desc" | "date-asc" | "name-asc" | "name-desc"

interface Feed {
  id: string
  type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
  url: string
  name: string
  coverUrl?: string | null
  isActive: boolean
  status: "ACTIVE" | "PAUSED" | "ERROR"
  createdAt: Date | string
  lastParsedAt?: Date | null
  interestQuery?: string | null
  errorMessage?: string | null
  interestCadence?: "HOURLY" | "DAILY" | "WEEKLY" | null
  _count?: {
    materials: number
  }
}

interface FeedsListProps {
  initialSources: Feed[]
  includesTwitter?: boolean
}

export function FeedsList({ initialSources, includesTwitter = true }: FeedsListProps) {
  const [sourceTypeFilters, setSourceTypeFilters] = useState<SourceTypeFilter[]>(["ALL"])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [sort, setSort] = useState<SortOption>("date-desc")

  // Calculate counts for each type
  const typeCounts = useMemo(
    () => ({
      ALL: initialSources.length,
      RSS: initialSources.filter((s) => s.type === "RSS").length,
      TELEGRAM: initialSources.filter((s) => s.type === "TELEGRAM").length,
      TWITTER: initialSources.filter((s) => s.type === "TWITTER").length,
      YOUTUBE: initialSources.filter((s) => s.type === "YOUTUBE").length,
      EVENT_TRIGGER: initialSources.filter((s) => s.type === "INTEREST" || s.type === "EVENT_TRIGGER").length,
    }),
    [initialSources]
  )

  // Calculate counts for each status (use isActive for accurate filtering)
  const statusCounts = useMemo(
    () => ({
      ALL: initialSources.length,
      ACTIVE: initialSources.filter((s) => s.isActive).length,
      PAUSED: initialSources.filter((s) => !s.isActive).length,
      ERROR: initialSources.filter((s) => !!s.errorMessage).length,
    }),
    [initialSources]
  )

  // Filter and sort sources
  const filteredSources = useMemo(() => {
    const filtered = initialSources.filter((s) => {
      if (!sourceTypeFilters.includes("ALL")) {
        const matchesType = sourceTypeFilters.some((st) => {
          if (st === "EVENT_TRIGGER") return s.type === "EVENT_TRIGGER" || s.type === "INTEREST"
          return s.type === st
        })
        if (!matchesType) return false
      }
      if (statusFilter === "ACTIVE" && !s.isActive) return false
      if (statusFilter === "PAUSED" && s.isActive) return false
      if (statusFilter === "ERROR" && !s.errorMessage) return false
      return true
    })

    return filtered.sort((a, b) => {
      switch (sort) {
        case "name-asc":
          return a.name.localeCompare(b.name)
        case "name-desc":
          return b.name.localeCompare(a.name)
        case "date-asc":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        case "date-desc":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
    })
  }, [initialSources, sourceTypeFilters, statusFilter, sort])

  return (
    <>
      {/* Filter section */}
      <div className="py-3">
        <FeedTypeFilterChips
          activeFilters={sourceTypeFilters}
          onFilterChange={setSourceTypeFilters}
          counts={typeCounts}
        />
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <span className="text-xs text-muted-foreground font-medium mb-2 block">
              Status
            </span>
            <div className="flex gap-2">
              <FilterChip
                active={statusFilter === "ALL"}
                onClick={() => setStatusFilter("ALL")}
                count={statusCounts.ALL}
              >
                All
              </FilterChip>
              <FilterChip
                active={statusFilter === "ACTIVE"}
                onClick={() => setStatusFilter("ACTIVE")}
                count={statusCounts.ACTIVE}
              >
                Enabled
              </FilterChip>
              <FilterChip
                active={statusFilter === "PAUSED"}
                onClick={() => setStatusFilter("PAUSED")}
                count={statusCounts.PAUSED}
              >
                Paused
              </FilterChip>
              {statusCounts.ERROR > 0 && (
                <FilterChip
                  active={statusFilter === "ERROR"}
                  onClick={() => setStatusFilter("ERROR")}
                  count={statusCounts.ERROR}
                  className={statusFilter === "ERROR"
                    ? "!bg-destructive-subtle !text-destructive hover:!bg-destructive-subtle/70"
                    : "!text-destructive"
                  }
                >
                  Errors
                </FilterChip>
              )}
            </div>
          </div>
          <div className="ml-auto">
            <span className="text-xs text-muted-foreground font-medium mb-2 block">
              Sort
            </span>
            <div className="flex gap-2">
              <FilterChip
                active={sort === "date-desc" || sort === "date-asc"}
                onClick={() => setSort((s) => s === "date-desc" ? "date-asc" : "date-desc")}
              >
                <ArrowUpDown className="h-3 w-3 mr-1" />
                Date {sort === "date-asc" ? "↑" : sort === "date-desc" ? "↓" : ""}
              </FilterChip>
              <FilterChip
                active={sort === "name-asc" || sort === "name-desc"}
                onClick={() => setSort((s) => s === "name-asc" ? "name-desc" : "name-asc")}
              >
                <ArrowUpDown className="h-3 w-3 mr-1" />
                Name {sort === "name-asc" ? "↑" : sort === "name-desc" ? "↓" : ""}
              </FilterChip>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1">
        {filteredSources.length === 0 ? (
          <EmptyFilterState />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 items-start">
            {filteredSources.map((source) => (
              <FeedCard
                key={source.id}
                source={source}
                locked={source.type === "TWITTER" && !includesTwitter}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function EmptyFilterState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl surface-card p-8 md:p-12">
      <h3 className="text-lg font-semibold">No feeds</h3>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        No feeds of the selected type
      </p>
      <div className="mt-4">
        <Button asChild variant="outline">
          <Link href="/feeds/new">
            <Plus className="mr-2 h-[16px] w-[16px]" />
            Add feed
          </Link>
        </Button>
      </div>
    </div>
  )
}
