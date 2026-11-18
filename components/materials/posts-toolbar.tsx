"use client"

/**
 * The posts toolbar (RAD-318 Phase 3).
 *
 * It replaces a title cluster of three competing buttons, a full-width search
 * row and two permanent chip rows — measured in Phase 0 as 32% of the viewport
 * at every breakpoint — with one row on desktop and two fixed rows on mobile.
 *
 * Composition rules that are load-bearing rather than decorative:
 *
 *   - **Scope left, action right**, on desktop and mobile alike. The mobile
 *     rows mirror the desktop grouping instead of wrapping it.
 *   - **One number in the heading**, always meaning "what is in the grid right
 *     now": the view's exact total, replaced by the response's `total` as soon
 *     as a refinement is applied, and shown as pending rather than stale while
 *     a request is in flight.
 *   - **Two controls, not a split button.** There is no split-button primitive
 *     in `components/ui`, and a chevron half is a small unlabeled target that
 *     people miss or mistake for the primary.
 *   - **44px is written as pixels.** `--spacing` is 0.2rem, so no Tailwind
 *     height utility below `h-14` reaches the touch floor and `size="icon"` is
 *     35.2px. Mobile targets therefore carry `min-h-[44px] min-w-[44px]`
 *     explicitly; the shared Button sizes are left alone so no other screen
 *     changes.
 */

import { useCallback, useId, useRef, useState } from "react"
import { ChevronDown, Layers, Loader2, MoreHorizontal, Play, RefreshCw, Search, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MorphText } from "@/components/ui/morph-text"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SourceTypeMenu, type SourceTypeCounts } from "./source-type-menu"
import { OpenModeToggle } from "./open-mode-toggle"
import type { OpenMode } from "./use-open-mode"
import { SourceFreshness } from "./source-freshness"
import type { SourceTypeFilter } from "@/components/shared/feed-type-filter"
import { FRESHNESS_LINE_VISIBLE, hasFreshnessLine, type FreshnessProps } from "@/lib/materials/source-freshness"
import type { LastRun } from "@/lib/materials/last-run"
import type { FilterType } from "@/lib/feed-utils"

/**
 * The views, in menu order. `APPROVED` is deliberately absent: its predicate is
 * identical to `INBOX` (`lib/feed-utils.ts:62-72`), so it was two names for one
 * view. Stored `APPROVED` normalizes to `INBOX`; the database status is
 * untouched, as is `SENT_TO_NOTION`, whose predicate selects `SENT_TO_STORIES`.
 */
export const VIEWS: { value: FilterType; label: string }[] = [
  { value: "INBOX", label: "Inbox" },
  { value: "FILTERED", label: "Filtered" },
  { value: "SENT_TO_NOTION", label: "In Stories" },
  { value: "ARCHIVED", label: "Archive" },
  { value: "ALL", label: "All posts" },
]

export function viewLabel(view: FilterType): string {
  return VIEWS.find(v => v.value === view)?.label ?? "Inbox"
}

export interface PostsToolbarProps {
  view: FilterType
  onViewChange: (view: FilterType) => void
  /** Per-view totals for the menu items. */
  viewCounts?: Partial<Record<FilterType, number>>
  /** The one heading number. `"pending"` while the current query is in flight. */
  headingCount: number | "pending" | null

  sourceTypes: SourceTypeFilter[]
  onSourceTypesChange: (next: SourceTypeFilter[]) => void
  sourceTypeCounts?: SourceTypeCounts
  /** True on /feeds/[id]: types are forced to all and the control is hidden. */
  hideSourceTypes?: boolean

  search: string
  onSearchChange: (value: string) => void

  /**
   * Where a card click opens a post or story (RAD-345). Optional so the
   * toolbar stays usable without it (the control is simply not rendered) —
   * the `bulkDelete` precedent.
   */
  openMode?: OpenMode
  onOpenModeChange?: (next: OpenMode) => void

  /** Identity of a source page, rendered in place of the view trigger's heading. */
  sourceName?: React.ReactNode
  leading?: React.ReactNode
  trailing?: React.ReactNode

  isRunning?: boolean
  /** The phase label shown on the disabled primary during a run. */
  runningLabel?: string
  /**
   * Handed out so the owner can return focus here when the processing card is
   * dismissed. The card is a grid cell; removing it would otherwise drop focus
   * to `body` and lose the user's place on the page entirely.
   */
  parseButtonRef?: React.Ref<HTMLButtonElement>
  onParse: () => void
  onGroupStories: () => void
  onRefilter: () => void

  /** Account-wide bulk delete; omitted on a source page and outside its views. */
  bulkDelete?: { count: number; isDeleting: boolean; onDelete: () => void }

  /** When the scope's sources were last checked (RAD-424); omitted → no line. */
  freshness?: FreshnessProps
  /** The last parse run's result on this device, headline of the freshness line. */
  lastRun?: LastRun | null
}

const TOUCH = "min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"

export function PostsToolbar({
  view,
  onViewChange,
  viewCounts,
  headingCount,
  sourceTypes,
  onSourceTypesChange,
  sourceTypeCounts,
  hideSourceTypes,
  search,
  onSearchChange,
  openMode,
  onOpenModeChange,
  sourceName,
  leading,
  trailing,
  isRunning = false,
  runningLabel = "Parsing…",
  parseButtonRef,
  onParse,
  onGroupStories,
  onRefilter,
  bulkDelete,
  freshness,
  lastRun,
}: PostsToolbarProps) {
  const searchId = useId()
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // An active query keeps the row open on its own, on every width — derived
  // rather than synchronised, so a query arriving from session storage after
  // hydration cannot leave the input hidden.
  const searchVisible = searchOpen || search.trim().length > 0

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    // Focus lands on the input the row opened for, not wherever it was.
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  const closeSearch = useCallback(() => {
    onSearchChange("")
    setSearchOpen(false)
    // The trigger is `sm:hidden`, so on desktop it is not rendered at all and
    // `focus()` is a silent no-op that leaves focus on <body> — the exact
    // "keyboard user loses the page" failure the card's dismiss handling exists
    // to prevent. Ask whether the focus actually took rather than inspecting
    // layout: `offsetParent` and computed style both read as "visible" under
    // jsdom, which would make the test green over a live defect.
    const trigger = searchTriggerRef.current
    trigger?.focus()
    if (trigger && document.activeElement === trigger) return
    searchInputRef.current?.focus()
  }, [onSearchChange])

  // The heading count matches the heading word's SIZE (it inherits the
  // trigger's text-xl/2xl) while keeping its normal weight — a smaller number
  // read as a caption beside the word rather than the one number of the screen.
  // The pending skeleton is a swap, not a morph on purpose: a value arriving
  // from a request must not roll, it must resolve.
  const count =
    headingCount === "pending" ? (
      <>
        <span
          className="ml-2 inline-block h-[0.7em] w-[2em] rounded-xs bg-muted animate-pulse"
          aria-hidden="true"
        />
        <span className="sr-only">Counting matching posts</span>
      </>
    ) : typeof headingCount === "number" ? (
      // Coalesced unconditionally: during a parse this count is refreshed per
      // stream frame, and a toggled window could briefly show the last value.
      <MorphText
        className="ml-2 font-normal text-muted-foreground"
        timing={isRunning ? "fast" : "base"}
        coalesceMs={120}
      >
        {headingCount}
      </MorphText>
    ) : null

  const searchField = (
    <div className="relative w-full sm:w-[240px] lg:w-[300px]">
      <label htmlFor={searchId} className="sr-only">
        Search posts
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 z-10 h-[16px] w-[16px] -translate-y-1/2 -scale-x-100 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={searchId}
        ref={searchInputRef}
        type="search"
        placeholder="Search posts…"
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") closeSearch()
        }}
        className="pl-9 pr-9"
      />
      {search.length > 0 && (
        <button
          type="button"
          onClick={closeSearch}
          aria-label="Clear search"
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X className="h-[16px] w-[16px]" aria-hidden="true" />
        </button>
      )}
    </div>
  )

  const onSourcePage = sourceName !== undefined

  const viewMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={onSourcePage ? "outline" : "ghost"}
          className={
            onSourcePage
              ? `${TOUCH} shrink-0 gap-1 px-2 text-sm sm:h-9`
              : `${TOUCH} -ml-2 gap-1 px-2 text-xl font-bold md:text-2xl sm:h-10`
          }
        >
          {onSourcePage ? (
            <span className="truncate">{viewLabel(view)}</span>
          ) : (
            <h1 className="truncate">{viewLabel(view)}</h1>
          )}
          {count}
          <ChevronDown className="h-[18px] w-[18px] opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup value={view} onValueChange={next => onViewChange(next as FilterType)}>
          {VIEWS.map(item => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <span className="flex-1">{item.label}</span>
              {typeof viewCounts?.[item.value] === "number" && (
                <span className="ml-2 text-xs type-counter text-muted-foreground">{viewCounts[item.value]}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const moreActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="More actions" className={`${TOUCH} sm:h-9 sm:w-9`}>
          <MoreHorizontal className="h-[16px] w-[16px]" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onGroupStories} disabled={isRunning}>
          <Layers className="mr-2 h-[16px] w-[16px]" aria-hidden="true" />
          Group stories
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRefilter} disabled={isRunning}>
          <RefreshCw className="mr-2 h-[16px] w-[16px]" aria-hidden="true" />
          Run AI rules
        </DropdownMenuItem>
        {bulkDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={bulkDelete.onDelete}
              disabled={bulkDelete.isDeleting || bulkDelete.count === 0}
              className="text-destructive focus:text-destructive"
            >
              {bulkDelete.isDeleting ? (
                <Loader2 className="mr-2 h-[16px] w-[16px] animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="mr-2 h-[16px] w-[16px]" aria-hidden="true" />
              )}
              {/* Explicitly account-wide: this endpoint ignores search, types and source. */}
              Delete all {viewLabel(view).toLowerCase()} posts ({bulkDelete.count})
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    /**
     * One grid, one instance of every control. The mobile "two fixed rows" and
     * the desktop single row are the same elements placed differently — nothing
     * is duplicated behind a `hidden` class, so there is one search input, one
     * More-actions trigger and one set of ids at every width, and the rows are
     * placement, not wrapping.
     *
     *   mobile   [ view ........ ][ search ][ parse ]
     *            [ types ..................][ more  ]
     *            [ search field, when open ........ ]
     *
     *   desktop  [ view ][ types ][ ..... ][ search ][ parse ][ more ]
     */
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 sm:grid-cols-[auto_auto_1fr_auto_auto_auto]">
      <div className="col-start-1 row-start-1 flex items-center gap-3 min-w-0 sm:col-start-1">
        {leading}
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-3">
            {/*
              On a source page the source keeps the heading and the view selector
              sits beside it — the page is "Alpha Journal, filtered", not "Inbox".
              Long names truncate visually and stay available accessibly.
            */}
            {onSourcePage && (
              <h1 className="min-w-0 truncate text-xl font-bold md:text-2xl" title={typeof sourceName === "string" ? sourceName : undefined}>
                {sourceName}
              </h1>
            )}
            {viewMenu}
            {onOpenModeChange && (
              <OpenModeToggle value={openMode ?? "page"} onChange={onOpenModeChange} />
            )}
          </div>
          {/* RAD-424: when the scope was last checked belongs to the scope's
              name, not to the Run parsing button. It sits under the heading at
              every width, so no grid cell moves. */}
          {FRESHNESS_LINE_VISIBLE && freshness && hasFreshnessLine(freshness) && (
            <SourceFreshness freshness={freshness} lastRun={lastRun} />
          )}
        </div>
      </div>

      {!hideSourceTypes && (
        <div className="col-start-1 row-start-2 justify-self-start sm:col-start-2 sm:row-start-1">
          <SourceTypeMenu
            value={sourceTypes}
            onChange={onSourceTypesChange}
            counts={sourceTypeCounts}
            touchTarget
            className="sm:min-h-0 sm:min-w-0 sm:h-9"
          />
        </div>
      )}

      {/* Mobile only: the trigger that opens the search row. */}
      <Button
        ref={searchTriggerRef}
        variant="outline"
        size="icon"
        aria-label="Search posts"
        aria-expanded={searchVisible}
        onClick={() => (searchVisible ? closeSearch() : openSearch())}
        className={`${TOUCH} col-start-2 row-start-1 sm:hidden`}
      >
        <Search className="h-[16px] w-[16px] -scale-x-100" aria-hidden="true" />
      </Button>

      {/* The field itself: its own full-width row on mobile, inline on desktop. */}
      <div
        className={[
          searchVisible ? "block" : "hidden",
          "col-span-3 col-start-1 row-start-3 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:block",
        ].join(" ")}
      >
        {searchField}
      </div>

      <Button
        ref={parseButtonRef}
        onClick={onParse}
        disabled={isRunning}
        // The visible label changes with the phase and collapses to an icon
        // below `sm`; the accessible name follows the phase rather than staying
        // "Run parsing", which would announce the wrong thing all run long.
        aria-label={isRunning ? runningLabel : "Run parsing"}
        className={`${TOUCH} col-start-3 row-start-1 sm:col-start-5 sm:h-9`}
      >
        {isRunning && <Loader2 className="h-[16px] w-[16px] animate-spin" aria-hidden="true" />}
        <span className={isRunning ? "hidden sm:inline sm:ml-2" : "hidden sm:inline"}>
          {isRunning ? runningLabel : "Run parsing"}
        </span>
        {!isRunning && <Play className="h-[16px] w-[16px] sm:hidden" aria-hidden="true" />}
      </Button>

      <div className="col-start-3 row-start-2 justify-self-end sm:col-start-6 sm:row-start-1">{moreActions}</div>

      {/* Placed, not auto-flowed. Every other cell in this grid declares its
          position; leaving the one caller-supplied slot to auto-placement means
          `/feeds/[id]`'s Edit button sits wherever the algorithm puts it. These
          are the cells it lands in today — the spacer on desktop, between types
          and More on mobile — now stated rather than inferred. */}
      {trailing && (
        <div className="col-start-2 row-start-2 justify-self-start sm:col-start-3 sm:row-start-1">{trailing}</div>
      )}
    </div>
  )
}
