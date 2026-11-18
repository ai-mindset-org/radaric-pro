/* eslint-disable @typescript-eslint/no-explicit-any */
"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { MaterialCard } from "./material-card"
import { coverHasVideo, storyGalleryImages, storyLeadMaterial } from "@/lib/media-urls"
import { AnimatedGrid } from "./animated-grid"
import { Search, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { type SourceTypeFilter } from "@/components/shared/feed-type-filter"
import { PostsToolbar } from "./posts-toolbar"
import { ProcessingCell } from "./processing-card"
import { usePostProcessing } from "./use-post-processing"
import { useLiveCounts } from "./use-live-counts"
import { useOpenMode, type OpenMode } from "./use-open-mode"
import { PostPeek } from "./post-peek"
import { StoryPeek, invalidateStoryPeekCache } from "@/components/stories/story-peek"
import { PeekHost } from "@/components/peek/peek-host"
import { parsePeek, peekHref, samePeek, type PeekTarget } from "@/lib/peek/peek-state"
import { peekNeighbour, planPeekClose, planPeekOpen } from "@/lib/peek/peek-nav"
import { navKeyIntent } from "@/lib/peek/keyboard"
import { startFirstParse } from "@/lib/materials/first-run"
import { collectedCount } from "@/lib/materials/processing-state"
import { lastRunKey, readLastRun, writeLastRun, type LastRun } from "@/lib/materials/last-run"
import type { FreshnessProps } from "@/lib/materials/source-freshness"
import { buildPostsUrl } from "@/lib/materials/posts-query"
import { buildRenderItems, getFilterPredicate, matchesSourceTypes, type FilterType, type RenderItem } from "@/lib/feed-utils"
import { toast } from "sonner"
import { safeSessionGet, safeSessionSet } from "@/lib/safe-storage"

/** Tell the dashboard shell to refetch /api/stats (updates the sidebar Inbox counts). */
function notifyStatsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("radaric:stats-changed"))
  }
}

type Material = {
  id: string
  title: string
  url: string
  content: string
  contentEntities?: any[] | null
  publishedAt: Date | null
  thumbnailUrl?: string | null
  mediaUrls?: string[]
  aiEvaluation: "APPROVED" | "FILTERED"
  aiConfidence: number
  aiReasoning: string | null
  createdAt: string
  userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
  feed: {
    id: string
    name: string
    type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
  }
  feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
  savedItems?: Array<{ id: string }>
  storyId?: string | null
  story?: {
    id: string
    title: string
    summary: string
    rubrics: string[]
    sourceUrls: string[]
    status: string
    version: number
    createdAt: string
    _count: { materials: number; inboxItems: number }
  } | null
}

interface ServerCounts {
  filter: Record<string, number>
  sourceType?: Record<string, number>
}

interface MaterialsListProps {
  initialMaterials: Material[]
  totalCount?: number
  serverCounts?: ServerCounts
  hasNotionIntegration?: boolean
  /**
   * Hide the source-type filter chip row. Used on the per-source view
   * (/feeds/[id]) where the source type is already known and the
   * breakdown would be degenerate. Also forces sourceTypeFilters to ["ALL"]
   * so a cross-page filter on /posts can't silently empty this list.
   * Default false preserves /posts behaviour.
   */
  hideSourceTypeFilter?: boolean
  /**
   * Override the default page title ("Posts"). Pass `null` to hide the
   * heading entirely (e.g. when the caller renders its own <h1>).
   */
  title?: React.ReactNode | null
  /**
   * Override the default subtitle. Pass `null` to hide it. Ignored when
   * `title === null`.
   */
  subtitle?: React.ReactNode | null
  /**
   * Rendered before the title block in the header row. Used by
   * /feeds/[id] to show the source cover next to the feed name —
   * unifies the per-source layout with /posts (no separate hero band).
   */
  leading?: React.ReactNode
  /**
   * Rendered after the Group / AI Rules / Run Parsing toolbar. Used by
   * /feeds/[id] to add an Edit button next to the toolbar.
   */
  headerExtra?: React.ReactNode
  /**
   * Scope the Group Stories / AI Rules / Run Parsing actions to a single
   * feed. When set, each action sends `?feedId=...` to its SSE endpoint,
   * and parseAllFeeds uses `[feedId]` instead of fetching every active
   * feed. Omit for the global /posts view.
   */
  feedId?: string
  /**
   * Scope the Group Stories / AI Rules / Run Parsing actions to a folder's
   * visible member sources (RAD-393). Mutually exclusive with `feedId`. When
   * set, each action sends `?folderId=...` to its SSE endpoint, every
   * `/api/posts` read carries `folderId`, and parseAllFeeds uses
   * `folderSourceIds`. The source-type filter stays visible (multi-source scope).
   */
  folderId?: string
  /** The folder's visible member source ids — Run Parsing parses exactly these. */
  folderSourceIds?: string[]
  /**
   * The scope's display name on a multi-source page (`/folders/[id]`). Renders
   * the heading like a source page while leaving the source-type filter
   * visible — the two concerns are now separate flags.
   */
  scopeName?: string
  /**
   * Number of active sources for the automatic first parse. Set only on an
   * eligible first visit to /posts; the run is server-owned and the processing
   * card observes it. See lib/materials/first-run.ts.
   */
  firstRunSourceCount?: number
  /**
   * Story-DB Notion integration flag. The toolbar's `hasNotionIntegration` is
   * the posts database; `/stories/[id]` has always keyed its own controls off
   * `storyNotionDatabaseId`, and the story peek must offer exactly what the
   * page offers.
   */
  hasStoryNotionIntegration?: boolean
  /**
   * Deep-link target read from `?post=` / `?story=` by the server page and
   * passed down before hydration (RAD-345). The list never calls
   * `useSearchParams` — several suites factory-mock `next/navigation` with
   * `useRouter` only, and the hook would throw in all of them.
   */
  initialPeek?: PeekTarget | null
  /**
   * When this scope's sources were last checked (RAD-424), built by the server
   * page from `Feed.lastParsedAt`. Re-read by `router.refresh()` after a run.
   */
  freshness?: FreshnessProps
}

/**
 * How long the exiting peek keeps its content mounted. Must outlast the
 * `--dur-close` slide (150ms) — Radix unmounts the content when its own exit
 * animation ends, and a shorter hold would blank the panel mid-slide.
 */
const PEEK_EXIT_MS = 220

const MIN_VISIBLE_COUNT = 20
/** Search asks for more than a page because its results are not paged. */
const SEARCH_LIMIT = 200

/** The processing card is an ordinary cell alongside the post cells. */
type GridCell = RenderItem | { type: "processing"; key: string; date: number }

/**
 * Hoisted so the cell memo stays pure. `Date.now()` inside the factory made the
 * value differ per recomputation — and disagree between StrictMode's two runs —
 * for nothing: the card is keyed by `key` and nothing reads its `date`. It
 * would become a real bug the day cells are sorted by date.
 */
const PROCESSING_CELL = { type: "processing" as const, key: "processing-card", date: 0 }

/** Stories built from 4+ sources get a double-width cell. */
function isWideItem(item: GridCell): boolean {
  if (item.type !== "story") return false
  const { story, materials } = item.story
  return (story._count?.materials ?? materials.length) + (story._count?.inboxItems ?? 0) >= 4
}

/**
 * The peek header's title on the very first render of a deep link — derived
 * from the SSR payload, so a shared `?post=` URL names the panel immediately
 * instead of after a fetch. A story's headline is only on its cell, which is
 * why this reads `storyId` off the materials.
 */
function initialPeekTitle(target: PeekTarget | null, materials: Material[]): string {
  if (!target) return ""
  if (target.kind === "post") return materials.find(m => m.id === target.id)?.title ?? ""
  const carrier = materials.find(m => m.storyId === target.id && m.story)
  return carrier?.story?.title ?? ""
}

const DEFAULT_TITLE = "Posts"
const DEFAULT_SUBTITLE = "View and manage collected posts"

export function MaterialsList({
  initialMaterials,
  totalCount = 0,
  serverCounts,
  hasNotionIntegration = false,
  hideSourceTypeFilter = false,
  title = DEFAULT_TITLE,
  subtitle = DEFAULT_SUBTITLE,
  leading,
  headerExtra,
  feedId,
  folderId,
  folderSourceIds,
  scopeName,
  firstRunSourceCount = 0,
  hasStoryNotionIntegration = false,
  initialPeek = null,
  freshness,
}: MaterialsListProps) {
  const router = useRouter()
  const [materials, setMaterials] = useState<Material[]>(initialMaterials)
  const [streamedMaterials, setStreamedMaterials] = useState<Material[]>([])
  const [hasMore, setHasMore] = useState(initialMaterials.length < totalCount)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchResults, setSearchResults] = useState<Material[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Which `/api/posts` response the screen still wants. Both reads below are
   * fired from effects that can overlap — a fast filter switch, a search
   * settling after the filter changed — and a late response that merges into
   * state is not a cosmetic race: it drops rows for the wrong predicate.
   */
  const filterRequestGeneration = useRef(0)
  const filterRequestAbort = useRef<AbortController | null>(null)
  const searchRequestGeneration = useRef(0)
  const searchRequestAbort = useRef<AbortController | null>(null)
  /** Rows fetched for the current query — the paging offset, never a cell count. */
  const [loadedRows, setLoadedRows] = useState(initialMaterials.length)
  /** The current query's own total, from the response that served it. */
  const [refinedTotal, setRefinedTotal] = useState<number | null>(null)
  // SSR-safe defaults. The persisted choices live in sessionStorage but are
  // applied AFTER mount (see the hydrate effect below) — reading storage in the
  // initializer made the client's first render differ from the server's (window
  // is undefined during SSR), triggering a React #418 hydration mismatch that
  // could blank the whole list on stricter clients (e.g. iOS Safari).
  const [activeFilter, setActiveFilter] = useState<FilterType>("INBOX")
  const [sourceTypeFilters, setSourceTypeFilters] = useState<SourceTypeFilter[]>(["ALL"])
  const [searchQuery, setSearchQuery] = useState("")
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)

  // Live counts first — refreshed on `radaric:stats-changed` (every mutation
  // path and the end of a run) and on a 30s poll, so the heading moves the
  // moment a material does. Then the server-rendered counts (accurate across
  // all posts), then a local count as the last resort.
  const liveCounts = useLiveCounts(feedId ?? null, folderId ?? null)
  // The filter-change effect below runs on [activeFilter, sourceTypeFilters]
  // alone and reads a snapshot on purpose; the ref keeps the freshest counts
  // reachable there without a poll re-firing a fetch.
  const liveCountsRef = useRef(liveCounts)
  useEffect(() => {
    liveCountsRef.current = liveCounts
  })

  // --- Side peek (RAD-345) -------------------------------------------------
  // The open target lives in React state and is mirrored into the URL with the
  // native History API (`?post=` / `?story=`): opening pushes one entry, swaps
  // replace it, closing goes back to the list entry — Back closes the peek.
  const [openMode, setOpenMode] = useOpenMode()
  const [peek, setPeek] = useState<PeekTarget | null>(initialPeek ?? null)
  /**
   * `peek` is the TARGET and is held for as long as the panel needs its content;
   * `isPeekOpen` is the panel's own open state. They are separate so the close
   * can animate: Radix keeps the content mounted only while its Root stays in
   * the tree, and a null target in the same commit would tear it down instantly
   * (and flash the skeleton on the way out).
   */
  const [isPeekOpen, setIsPeekOpen] = useState(!!initialPeek)
  const [peekTitle, setPeekTitle] = useState(() => initialPeekTitle(initialPeek, initialMaterials))
  const peekRef = useRef<PeekTarget | null>(peek)
  /**
   * Panel-open mirror of the state, for event-time reads. `peekRef` alone is
   * not enough: while the exit animation runs, `peekRef` still holds the closed
   * target, and treating that as "already open" made the reopen of the same
   * card a no-op.
   */
  const isPeekOpenRef = useRef(!!initialPeek)
  useEffect(() => {
    peekRef.current = peek
    isPeekOpenRef.current = isPeekOpen
  }, [peek, isPeekOpen])
  /**
   * The item as it was when the peek opened. The live list copy wins while it
   * exists; this only keeps an open peek alive when the list resets underneath
   * it (`router.refresh()`, a parse finishing, the initialMaterials effect).
   */
  const peekSnapshotRef = useRef<Material | null>(null)
  /** The element the peek was opened from — focus returns here on close. */
  const peekOriginRef = useRef<HTMLElement | null>(null)
  /**
   * `closePeek` reached from handlers defined above it. The delete handlers are
   * `useCallback([])` on purpose (their identity is what keeps every card's memo
   * alive), so they cannot list `closePeek` as a dependency — a ref keeps both.
   */
  const closePeekRef = useRef<() => void>(() => {})
  /**
   * `planPeekAdvance` reached from `handleArchive` for the same reason: the
   * archive handler is `useCallback([])`, the planner needs `openPeek`. It
   * RETURNS the opener for the next cell — null when there is nowhere to go —
   * so the caller can wait for the archive to land before using it.
   */
  const planPeekAdvanceRef = useRef<(target: PeekTarget) => (() => void) | null>(() => null)
  /**
   * A close can be requested twice in one tick — the delete handler closes, and
   * the peek surface closes again when its own `onDelete` resolves. A second
   * `history.back()` would walk past the list to whatever came before it, so the
   * first close wins and the flag is cleared by the next open.
   */
  const peekClosingRef = useRef(false)
  /** Cleared when the exit has finished (or a new target cancels it). */
  const peekCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hydrate filter state from sessionStorage AFTER mount. Initial render (SSR +
  // client) uses the SSR-safe defaults above, so they always match — then we
  // apply the persisted choice here. This replaces reading storage in the
  // useState initializers, which made the first client render differ from the
  // server and triggered a React #418 hydration mismatch (could blank the list
  // on iOS Safari). The hydratedRef gate keeps the persist effects below from
  // overwriting stored values with the defaults during this mount pass.
  const hydratedRef = useRef(false)
  useEffect(() => {
    const savedFilter = safeSessionGet("radaric-materials-filter")
    if (savedFilter && ["ALL", "INBOX", "APPROVED", "FILTERED", "SENT_TO_NOTION", "ARCHIVED"].includes(savedFilter)) {
      // `APPROVED` has the same predicate as `INBOX` (lib/feed-utils.ts:62-72)
      // and is no longer offered as a separate view; a stored one normalizes
      // rather than selecting a view the menu cannot show as checked.
      setActiveFilter((savedFilter === "APPROVED" ? "INBOX" : savedFilter) as FilterType)
    }
    // Per-source views (/feeds/[id]) force ["ALL"] and must not inherit a
    // cross-page source-type filter from /posts sessionStorage.
    if (!hideSourceTypeFilter) {
      const savedSourceType = safeSessionGet("radaric-materials-source-type")
      if (savedSourceType) {
        try {
          const parsed = JSON.parse(savedSourceType)
          // Validate: a stored array can contain anything a past version wrote.
          // Legacy INTEREST folds into EVENT_TRIGGER, and an empty or unknown
          // selection normalizes to ALL rather than to an impossible filter.
          if (Array.isArray(parsed)) {
            const valid = parsed
              .map(t => (t === "INTEREST" ? "EVENT_TRIGGER" : t))
              .filter((t): t is SourceTypeFilter =>
                ["ALL", "RSS", "TELEGRAM", "TWITTER", "YOUTUBE", "EVENT_TRIGGER"].includes(t)
              )
            setSourceTypeFilters(valid.length > 0 ? [...new Set(valid)] : ["ALL"])
          }
        } catch {
          // Legacy single-value format — migrate
          if (["ALL", "RSS", "TELEGRAM", "TWITTER", "YOUTUBE", "INTEREST", "EVENT_TRIGGER"].includes(savedSourceType)) {
            setSourceTypeFilters([savedSourceType as SourceTypeFilter])
          }
        }
      }
    }
    const savedSearch = safeSessionGet("radaric-materials-search")
    if (savedSearch) setSearchQuery(savedSearch)
    hydratedRef.current = true
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist filter state to sessionStorage (only once hydrated, so the mount
  // pass never overwrites a stored choice with the SSR default).
  useEffect(() => {
    if (hydratedRef.current) safeSessionSet("radaric-materials-filter", activeFilter)
  }, [activeFilter])
  useEffect(() => {
    if (hideSourceTypeFilter || !hydratedRef.current) return
    safeSessionSet("radaric-materials-source-type", JSON.stringify(sourceTypeFilters))
  }, [sourceTypeFilters, hideSourceTypeFilter])
  useEffect(() => {
    if (hydratedRef.current) safeSessionSet("radaric-materials-search", searchQuery)
  }, [searchQuery])

  // On filter change: fetch fresh page from server to avoid mixed pagination state.
  // The initial load is filter-agnostic (96 most recent), so client-side filtering
  // may not have the correct "first page" for any specific filter.
  //
  // Intentional dep omissions: combinedMaterials, materials, serverCounts and
  // totalCount are read but not in deps — this effect should only fire on filter
  // *changes*, not on every data arrival. serverCounts comes from the server
  // component (stable between navigations); combinedMaterials and materials
  // would cause infinite loops (fetch → update → re-run). Both are read only to
  // size the current view, so a one-render-stale snapshot is correct here.
   
  useEffect(() => {
    const predicate = getFilterPredicate(activeFilter) as (m: any) => boolean
    let matching = combinedMaterials.filter(predicate)
    if (!sourceTypeFilters.includes("ALL")) {
      matching = matching.filter((m: any) => matchesSourceTypes(m, sourceTypeFilters))
    }
    const matchingCount = matching.length

    // Source-type-aware total. Server counts are NOT cross-filtered (sourceType
    // counts include all statuses, status counts include all source types), so
    // min() overestimates. This is acceptable: it errs toward showing "Load More"
    // rather than hiding content. The fetch response's data.total corrects it.
    // Read through the ref, not the state: the heading and this Load-more
    // boundary must agree, and the poll that moves one moves the other.
    const liveFilter = liveCountsRef.current?.filter
    const sourceTypeServerCounts = liveCountsRef.current?.sourceType ?? serverCounts?.sourceType
    let filterTotal: number
    if (!sourceTypeFilters.includes("ALL") && sourceTypeServerCounts) {
      const statusTotal = liveFilter?.[activeFilter] ?? serverCounts?.filter?.[activeFilter] ?? totalCount
      const sourceTotal = sourceTypeFilters.reduce((sum, st) => sum + (sourceTypeServerCounts[st] ?? 0), 0)
      filterTotal = Math.min(statusTotal, sourceTotal)
    } else {
      filterTotal = liveFilter?.[activeFilter] ?? serverCounts?.filter?.[activeFilter] ?? totalCount
    }

    // A new query: the previous one's total and page offset mean nothing here.
    setRefinedTotal(null)

    if (matchingCount < MIN_VISIBLE_COUNT && filterTotal > matchingCount) {
      // Too few local matches for a useful first screen — fetch a proper
      // first page from the server with the correct filter applied.
      fetchFilterPage(0)
    } else {
      // No request for this query, so the offset is what the server already
      // gave us that matches it — counted over `materials` alone. Streamed
      // posts arrive outside the server's ordering and would shift the offset
      // past rows that were never served.
      let served = materials.filter(predicate)
      if (!sourceTypeFilters.includes("ALL")) {
        served = served.filter((m: any) => matchesSourceTypes(m, sourceTypeFilters))
      }
      setLoadedRows(served.length)
      setHasMore(matchingCount < filterTotal)
    }
  }, [activeFilter, sourceTypeFilters])

  async function fetchFilterPage(offset: number) {
    // The request generation, and the filter/type values THIS request was built
    // for. Switching INBOX → FILTERED → ARCHIVED quickly lets the middle
    // response land last; without this it would merge using whatever
    // `activeFilter` is by then, dropping the wrong rows and setting a
    // `hasMore` that belongs to a view the user already left.
    const generation = ++filterRequestGeneration.current
    const requestFilter = activeFilter
    const requestTypes = sourceTypeFilters
    filterRequestAbort.current?.abort()
    const controller = new AbortController()
    filterRequestAbort.current = controller

    setIsLoadingMore(true)
    try {
      const url = buildPostsUrl(
        { filter: requestFilter, sourceTypes: requestTypes, sourceId: feedId ?? null, folderId: folderId ?? null, search: "" },
        offset
      )

      const res = await fetch(url, { signal: controller.signal })
      if (generation !== filterRequestGeneration.current) return
      if (res.ok) {
        const data = await res.json()
        if (generation !== filterRequestGeneration.current) return
        // The response's own count for this exact query — what the heading
        // means by "how many posts this view has".
        setRefinedTotal(typeof data.total === "number" ? data.total : null)
        if (offset === 0) {
          // First page for this filter — replace only materials matching BOTH
          // the status filter AND the source type filter being fetched.
          // Without this, selecting a source type that returns 0 results would
          // permanently discard all materials matching the status filter.
          setMaterials(prev => {
            // The filter this response was BUILT for, not the one selected now.
            const predicate = getFilterPredicate(requestFilter) as (m: any) => boolean
            const kept = prev.filter(m => {
              if (!predicate(m)) return true // doesn't match status filter — keep
              // Matches status filter: only remove if it also matches the fetched source type
              if (requestTypes.includes("ALL") || requestTypes.length === 0) {
                return false // ALL source types — replace all matching
              }
              return !matchesSourceTypes(m as any, requestTypes)
            })
            return [...kept, ...data.materials]
          })
        } else {
          setMaterials(prev => [...prev, ...data.materials])
        }
        // Rows requested so far vs the server's total. `received === 0` ends
        // paging outright: the endpoint counts with one `where` and returns
        // rows that can be post-filtered, so a total above what it can actually
        // serve would otherwise loop Load-more forever.
        setLoadedRows(offset + data.materials.length)
        setHasMore(data.materials.length > 0 && offset + data.materials.length < data.total)
      }
    } catch (error) {
      // An abort is this component superseding its own request, not a failure.
      if ((error as Error)?.name === "AbortError") return
      if (generation !== filterRequestGeneration.current) return
      toast.error("Failed to load posts")
    } finally {
      if (generation === filterRequestGeneration.current) setIsLoadingMore(false)
    }
  }

  // Sync materials state with initialMaterials prop when it changes (e.g. after router.refresh())
  useEffect(() => {
    setMaterials(initialMaterials)
    setStreamedMaterials([])
    setLoadedRows(initialMaterials.length)
    setRefinedTotal(null)
    setHasMore(initialMaterials.length < totalCount)
  }, [initialMaterials, totalCount])

  // Server-side search with debounce
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)

    if (!searchQuery.trim()) {
      setSearchResults(null)
      setRefinedTotal(null)
      setIsSearching(false)
      return
    }

    setIsSearching(true)
    searchDebounceRef.current = setTimeout(async () => {
      // Debounced, but not serialised: a slow response for "des" can still land
      // after a fast one for "design". Only the latest request may write.
      const generation = ++searchRequestGeneration.current
      searchRequestAbort.current?.abort()
      const controller = new AbortController()
      searchRequestAbort.current = controller
      try {
        const url = buildPostsUrl(
          { filter: activeFilter, sourceTypes: sourceTypeFilters, sourceId: feedId ?? null, folderId: folderId ?? null, search: searchQuery },
          0,
          SEARCH_LIMIT
        )
        const res = await fetch(url, { signal: controller.signal })
        if (generation !== searchRequestGeneration.current) return
        if (res.ok) {
          const data = await res.json()
          if (generation !== searchRequestGeneration.current) return
          setSearchResults(data.materials)
          setRefinedTotal(typeof data.total === "number" ? data.total : null)
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return
        if (generation !== searchRequestGeneration.current) return
        // Fall back to client-side search on error
        setSearchResults(null)
      } finally {
        if (generation === searchRequestGeneration.current) setIsSearching(false)
      }
    }, 300)

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, activeFilter, sourceTypeFilters, feedId, folderId])

  async function handleLoadMore() {
    if (isLoadingMore) return
    // Page from rows the server has served, not from what is mounted. A story
    // cell holds several posts and the processing card holds none, so a cell
    // count and a row offset are different numbers — using the former made
    // Load-more after a parse skip or repeat posts.
    await fetchFilterPage(loadedRows)
  }


  // Combine initial materials with streamed materials (deduplicate by id)
  const combinedMaterials = useMemo(() => {
    const seen = new Set<string>()
    const result: Material[] = []

    // Prioritize streamedMaterials (newer data)
    for (const material of [...streamedMaterials, ...materials]) {
      if (!seen.has(material.id)) {
        seen.add(material.id)
        result.push(material)
      }
    }

    return result
  }, [streamedMaterials, materials])

  // Live counts first — refreshed on `radaric:stats-changed` (every mutation
  // path and the end of a run) and on a 30s poll, so the heading moves the
  // moment a material does. Then the server-rendered counts (accurate across
  // all posts), then a local count as the last resort.
  const filterCounts = useMemo(() => {
    if (liveCounts?.filter) return liveCounts.filter
    if (serverCounts?.filter) return serverCounts.filter as Record<string, number>
    const nonDeleted = combinedMaterials.filter(m => m.userStatus !== "DELETED")
    const active = nonDeleted.filter(m =>
      m.userStatus !== "ARCHIVED"
    )
    return {
      INBOX: active.filter((m) => m.aiEvaluation === "APPROVED").length,
      APPROVED: nonDeleted.filter((m) => m.aiEvaluation === "APPROVED").length,
      FILTERED: nonDeleted.filter((m) => m.aiEvaluation === "FILTERED").length,
      SENT_TO_NOTION: nonDeleted.filter((m) => m.userStatus === "SENT_TO_NOTION" || m.userStatus === "SENT_TO_STORIES").length,
      ARCHIVED: nonDeleted.filter((m) => m.userStatus === "ARCHIVED").length,
      ALL: nonDeleted.length,
    }
  }, [combinedMaterials, serverCounts, liveCounts])

  const sourceTypeCounts = useMemo((): { ALL: number; RSS: number; TELEGRAM: number; TWITTER: number; YOUTUBE: number; EVENT_TRIGGER: number } => {
    if (liveCounts?.sourceType) return liveCounts.sourceType as any
    if (serverCounts?.sourceType) return serverCounts.sourceType as any
    const nonDeleted = combinedMaterials.filter(m => m.userStatus !== "DELETED")
    return {
      ALL: nonDeleted.length,
      RSS: nonDeleted.filter((m) => m.feed.type === "RSS").length,
      TELEGRAM: nonDeleted.filter((m) => m.feed.type === "TELEGRAM").length,
      TWITTER: nonDeleted.filter((m) => m.feed.type === "TWITTER").length,
      YOUTUBE: nonDeleted.filter((m) => m.feed.type === "YOUTUBE").length,
      EVENT_TRIGGER: nonDeleted.filter((m) => m.feed.type === "INTEREST" || m.feed.type === "EVENT_TRIGGER").length,
    }
  }, [combinedMaterials, serverCounts, liveCounts])

  /**
   * Every processing run — parse, grouping, re-filtering — goes through one
   * controller, which owns the transports and a run generation. What used to
   * live here was three EventSource refs, eight pieces of progress state and a
   * promise that `cancelParsing` deliberately never settled.
   */
  const firstRun = useMemo(
    () =>
      firstRunSourceCount > 0
        ? { sourceCount: firstRunSourceCount, start: () => startFirstParse(firstRunSourceCount) }
        : null,
    [firstRunSourceCount]
  )

  // Dismiss removes a grid cell, so focus has to be told where to go — without
  // this it falls to `body` and a keyboard user loses the page entirely.
  const parseButtonRef = useRef<HTMLButtonElement>(null)

  /**
   * The two lists as refs, read only by the per-card action handlers below.
   *
   * Those handlers are props on a memoised `MaterialCard`, so their identity has
   * to survive a streamed material arriving. Taking `materials` as a dependency
   * would rebuild them — and re-render every card — on each insertion, which is
   * exactly what the memo is there to prevent. The handlers run from user
   * events, i.e. after the commit that refreshed these refs, so reading them is
   * never stale in practice.
   */
  const materialsRef = useRef(materials)
  const streamedMaterialsRef = useRef(streamedMaterials)
  useEffect(() => {
    materialsRef.current = materials
    streamedMaterialsRef.current = streamedMaterials
  })

  const processing = usePostProcessing({
    sourceId: feedId ?? null,
    folderId: folderId ?? null,
    folderSourceIds,
    view: activeFilter,
    firstRun,
    // Streamed posts still arrive optimistically, exactly as before.
    onMaterial: material => setStreamedMaterials(prev => [material as unknown as Material, ...prev]),
    // A reconciled row (RAD-359 media backfill) is merged into the mounted card
    // by id — never inserted, or a re-parse would show the post twice.
    onMaterialUpdated: material =>
      setStreamedMaterials(prev =>
        prev.map(m => (m.id === material.id ? ({ ...m, ...material } as unknown as Material) : m))
      ),
    // One refresh per run, at the end. The old code also cleared the streamed
    // materials first, which blanked the grid until the server data arrived.
    onRefresh: () => {
      notifyStatsChanged()
      router.refresh()
    },
  })

  // The last finished parse on this device (RAD-424): read after mount, written
  // when a parse settles with success or partial. `collectedCount` is the very
  // number the processing card shows as "New posts". An observed run (the
  // automatic first one) has no per-source frames, so its count is not known
  // and it is left to the server's `checkedAt`.
  const lastRunStorageKey = lastRunKey({ feedId, folderId })
  const [lastRun, setLastRun] = useState<LastRun | null>(null)
  useEffect(() => {
    setLastRun(readLastRun(lastRunStorageKey))
  }, [lastRunStorageKey])
  const recordedGenerationRef = useRef(0)
  const previousPhaseRef = useRef<string>("idle")
  const { store: processingStore } = processing
  useEffect(() => {
    return processingStore.subscribe(() => {
      const run = processingStore.getSnapshot()
      // Record on the transition INTO "done" only. Dismiss (and Stop on a
      // finished run) bump the generation and keep phase/outcome, so without
      // this a card closed 40 minutes later would re-stamp "checked just now".
      const previousPhase = previousPhaseRef.current
      previousPhaseRef.current = run.phase
      if (run.phase !== "done" || previousPhase === "done" || run.dismissed) return
      if (run.kind !== "parse" || run.observed || run.droppedWithoutCompletion) return
      // A run this card only watches was started elsewhere — the registry is per
      // user, not per scope — so it may have covered a different set of sources.
      if (run.attachedRun) return
      // Nothing to read is not a check.
      if (run.manifestKnown && run.sources.length === 0) return
      if (run.outcome !== "success" && run.outcome !== "partial") return
      // A parse settles once, then its auto-grouping reopens and re-settles the
      // same generation; only the first settle is the parse's result.
      if (recordedGenerationRef.current === run.generation) return
      recordedGenerationRef.current = run.generation
      const result = { at: new Date().toISOString(), newPosts: collectedCount(run) }
      writeLastRun(lastRunStorageKey, result)
      setLastRun(result)
    })
  }, [processingStore, lastRunStorageKey])

  const handleDelete = useCallback(async (id: string, feedback?: { sourceFeedback?: string; globalFeedback?: string }) => {
    const origItem = materialsRef.current.find(m => m.id === id)
    const origStreamed = streamedMaterialsRef.current.find(m => m.id === id)

    // Drop it now. AnimatedGrid picks the departure up in the same commit and
    // runs the exit while the neighbours close the gap — no waiting on a timer.
    setMaterials(prev => prev.filter(m => m.id !== id))
    setStreamedMaterials(prev => prev.filter(m => m.id !== id))

    try {
      const response = await fetch(`/api/posts/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback || {}),
      })

      if (!response.ok) {
        throw new Error("Failed to delete material")
      }

      // Inbox count changed — refresh the sidebar badge instantly.
      notifyStatsChanged()

      // An item that no longer exists must not stay open behind the panel.
      if (peekRef.current?.kind === "post" && peekRef.current.id === id) closePeekRef.current()

      toast.success("Post deleted")
      return true
    } catch (error) {
      // Put it back — the grid animates the return the same way it animated the exit.
      if (origItem) setMaterials(prev => (prev.some(m => m.id === id) ? prev : [...prev, origItem]))
      if (origStreamed) setStreamedMaterials(prev => (prev.some(m => m.id === id) ? prev : [...prev, origStreamed]))
      console.error("Error deleting material:", error)
      toast.error("Error deleting material")
      // The caller decides whether anything may close on this: the card returns
      // to the grid, so an open peek on it must stay.
      return false
    }
  }, [])

  const handleArchive = useCallback(async (id: string) => {
    const origItem =
      materialsRef.current.find(m => m.id === id) || streamedMaterialsRef.current.find(m => m.id === id)

    // Archive is "done with this one": when the archived post is the one the
    // peek is showing, the panel moves on to the next visible cell instead of
    // parking on the archived copy. Planned before the optimistic update —
    // the filter may drop the card from the order by the time the request
    // returns — and opened only once the archive has landed, so a failed
    // request leaves the panel on the post it could not archive.
    const openNext = planPeekAdvanceRef.current({ kind: "post", id })

    // Optimistic update. Whether the card leaves the grid is the filter's business,
    // not ours: on INBOX the predicate drops it and AnimatedGrid animates it out;
    // on ALL it legitimately stays and simply swaps to the restore icon. The old
    // `shouldDismiss` guess got that second case wrong — it faded the card to zero
    // and then snapped it back to full opacity.
    setMaterials(prev => prev.map(m =>
      m.id === id ? { ...m, userStatus: "ARCHIVED" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      m.id === id ? { ...m, userStatus: "ARCHIVED" as const } : m
    ))

    try {
      const response = await fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "ARCHIVED" }),
      })

      if (!response.ok) {
        throw new Error("Failed to archive")
      }

      if (openNext) openNext()
      notifyStatsChanged()
      toast.success("Post moved to archive")
    } catch (error) {
      if (origItem) {
        setMaterials(prev => prev.map(m => m.id === id ? origItem : m))
        setStreamedMaterials(prev => prev.map(m => m.id === id ? origItem : m))
      }
      console.error("Error archiving material:", error)
      toast.error("Error archiving")
    }
  }, [])

  const handleRestore = useCallback(async (id: string) => {
    const origItem =
      materialsRef.current.find(m => m.id === id) || streamedMaterialsRef.current.find(m => m.id === id)

    // Optimistic update
    setMaterials(prev => prev.map(m =>
      m.id === id ? { ...m, userStatus: "NEW" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      m.id === id ? { ...m, userStatus: "NEW" as const } : m
    ))

    try {
      const response = await fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "NEW" }),
      })

      if (!response.ok) {
        throw new Error("Failed to restore")
      }

      notifyStatsChanged()
      toast.success("Post restored from archive")
    } catch (error) {
      if (origItem) {
        setMaterials(prev => prev.map(m => m.id === id ? origItem : m))
        setStreamedMaterials(prev => prev.map(m => m.id === id ? origItem : m))
      }
      console.error("Error restoring material:", error)
      toast.error("Error restoring")
    }
  }, [])

  // --- Story-level batch actions (propagate to all constituent materials) ---

  async function handleStoryArchive(materialIds: string[], storyId?: string) {
    const originalMaterials = materials
    const originalStreamedMaterials = streamedMaterials
    const idSet = new Set(materialIds)

    setMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "ARCHIVED" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "ARCHIVED" as const } : m
    ))

    const results = await Promise.allSettled(materialIds.map(id =>
      fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "ARCHIVED" }),
      }).then(res => { if (!res.ok) throw new Error() })
    ))

    notifyStatsChanged()
    invalidateStoryPeekCache(storyId)

    const failedIds = materialIds.filter((_, i) => results[i].status === "rejected")
    if (failedIds.length > 0) {
      // Rollback only failed materials
      const failedSet = new Set(failedIds)
      setMaterials(prev => prev.map(m =>
        failedSet.has(m.id) ? originalMaterials.find(om => om.id === m.id) ?? m : m
      ))
      setStreamedMaterials(prev => prev.map(m =>
        failedSet.has(m.id) ? originalStreamedMaterials.find(om => om.id === m.id) ?? m : m
      ))
      toast.error(`${failedIds.length} of ${materialIds.length} posts failed to archive`)
    } else {
      toast.success(`${materialIds.length} posts archived`)
    }
  }

  async function handleStoryDelete(materialIds: string[], feedback?: { sourceFeedback?: string; globalFeedback?: string }, storyId?: string) {
    const idSet = new Set(materialIds)
    const originalMaterials = materials.filter(m => idSet.has(m.id))
    const originalStreamed = streamedMaterials.filter(m => idSet.has(m.id))

    // Decided BEFORE the optimistic removal: once the materials leave the grid
    // the story cell is gone, so a lookup afterwards can never match.
    const peekShowsThisStory =
      !!storyId && peekRef.current?.kind === "story" && peekRef.current.id === storyId

    // Optimistic — the whole story leaves the grid now, exit and reflow together.
    setMaterials(prev => prev.filter(m => !idSet.has(m.id)))
    setStreamedMaterials(prev => prev.filter(m => !idSet.has(m.id)))

    const results = await Promise.allSettled(materialIds.map(id =>
      fetch(`/api/posts/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback || {}),
      }).then(res => { if (!res.ok) throw new Error() })
    ))

    notifyStatsChanged()
    invalidateStoryPeekCache(storyId)

    const failedIds = new Set(materialIds.filter((_, i) => results[i].status === "rejected"))
    const failedCount = failedIds.size

    if (failedCount > 0) {
      // Restore only the ones that failed; the rest stay gone.
      const restore = originalMaterials.filter(m => failedIds.has(m.id))
      const restoreStreamed = originalStreamed.filter(m => failedIds.has(m.id))
      if (restore.length > 0) {
        setMaterials(prev => [...prev, ...restore.filter(m => !prev.some(p => p.id === m.id))])
      }
      if (restoreStreamed.length > 0) {
        setStreamedMaterials(prev => [...prev, ...restoreStreamed.filter(m => !prev.some(p => p.id === m.id))])
      }
    }

    // A story that has been dissolved must not stay open behind the panel.
    if (failedCount === 0 && peekShowsThisStory) closePeekRef.current()

    if (failedCount > 0) {
      toast.error(`${failedCount} of ${materialIds.length} posts failed to delete`)
      return false
    }
    toast.success(`${materialIds.length} posts deleted`)
    return true
  }

  async function handleStoryRestore(materialIds: string[], storyId?: string) {
    const originalMaterials = materials
    const originalStreamedMaterials = streamedMaterials
    const idSet = new Set(materialIds)

    setMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "NEW" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "NEW" as const } : m
    ))

    const results = await Promise.allSettled(materialIds.map(id =>
      fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "NEW" }),
      }).then(res => { if (!res.ok) throw new Error() })
    ))

    notifyStatsChanged()
    invalidateStoryPeekCache(storyId)

    const failedIds = materialIds.filter((_, i) => results[i].status === "rejected")
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds)
      setMaterials(prev => prev.map(m =>
        failedSet.has(m.id) ? originalMaterials.find(om => om.id === m.id) ?? m : m
      ))
      setStreamedMaterials(prev => prev.map(m =>
        failedSet.has(m.id) ? originalStreamedMaterials.find(om => om.id === m.id) ?? m : m
      ))
      toast.error(`${failedIds.length} of ${materialIds.length} posts failed to restore`)
    } else {
      toast.success(`${materialIds.length} posts restored`)
    }
  }

  async function handleStoryFeedbackPropagation(primaryMaterialId: string, materialIds: string[], feedbackType: "LIKE" | "DISLIKE") {
    const remaining = materialIds.filter(id => id !== primaryMaterialId)
    if (remaining.length === 0) return

    // Optimistic update for remaining materials
    const remainingSet = new Set(remaining)
    setMaterials(prev => prev.map(m =>
      remainingSet.has(m.id) ? { ...m, feedbacks: [{ feedbackType }] } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      remainingSet.has(m.id) ? { ...m, feedbacks: [{ feedbackType }] } : m
    ))

    const results = await Promise.allSettled(remaining.map(id =>
      fetch(`/api/posts/${id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackType }),
      }).then(res => { if (!res.ok) throw new Error() })
    ))
    const failedCount = results.filter(r => r.status === "rejected").length
    if (failedCount > 0) {
      toast.error(`Feedback failed for ${failedCount} of ${remaining.length} related posts`)
    }
  }

  const handleSendToNotion = useCallback(async (materialId: string) => {
    const origItem =
      materialsRef.current.find(m => m.id === materialId) ||
      streamedMaterialsRef.current.find(m => m.id === materialId)

    setMaterials(prev => prev.map(m =>
      m.id === materialId ? { ...m, userStatus: "SENT_TO_NOTION" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      m.id === materialId ? { ...m, userStatus: "SENT_TO_NOTION" as const } : m
    ))

    try {
      const response = await fetch(`/api/posts/${materialId}/notion`, {
        method: "POST",
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || "Failed to send to Notion")
      }
      // `truncated`: the page exists, but Notion refused part of the media.
      const result = await response.json().catch(() => ({}))
      if (result.truncated) {
        toast.warning("Sent to Notion — some media could not be attached")
      } else {
        toast.success("Post sent to Notion")
      }
    } catch (error: any) {
      if (origItem) {
        setMaterials(prev => prev.map(m => m.id === materialId ? origItem : m))
        setStreamedMaterials(prev => prev.map(m => m.id === materialId ? origItem : m))
      }
      console.error("Error sending to Notion:", error)
      toast.error(error.message || "Error sending to Notion")
    }
  }, [])

  async function handleStorySendToNotion(storyId: string, materialIds: string[]) {
    const originalMaterials = materials
    const originalStreamedMaterials = streamedMaterials
    const idSet = new Set(materialIds)

    setMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "SENT_TO_NOTION" as const } : m
    ))
    setStreamedMaterials(prev => prev.map(m =>
      idSet.has(m.id) ? { ...m, userStatus: "SENT_TO_NOTION" as const } : m
    ))

    try {
      const response = await fetch(`/api/stories/${storyId}/notion`, {
        method: "POST",
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || "Failed to send story to Notion")
      }
      invalidateStoryPeekCache(storyId)
      toast.success("Story sent to Notion")
    } catch (error: any) {
      setMaterials(originalMaterials)
      setStreamedMaterials(originalStreamedMaterials)
      console.error("Error sending story to Notion:", error)
      toast.error(error.message || "Error sending story to Notion")
    }
  }

  async function handleBulkDelete(filter: "FILTERED" | "ARCHIVED") {
    const count = filter === "FILTERED" ? filterCounts.FILTERED : filterCounts.ARCHIVED
    if (count === 0) {
      toast.info("No posts to delete")
      return
    }

    const confirmed = window.confirm(
      `Delete ${count} ${filter === "FILTERED" ? "filtered" : "archived"} posts?`
    )
    if (!confirmed) return

    setIsBulkDeleting(true)

    try {
      const response = await fetch(`/api/posts/bulk-delete?filter=${filter}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to bulk delete")
      }

      const data = await response.json()

      // Update local state - mark as deleted
      setMaterials(prev => prev.map(m => {
        if (filter === "FILTERED" && m.aiEvaluation === "FILTERED" && m.userStatus !== "DELETED") {
          return { ...m, userStatus: "DELETED" as const }
        }
        if (filter === "ARCHIVED" && m.userStatus === "ARCHIVED") {
          return { ...m, userStatus: "DELETED" as const }
        }
        return m
      }))
      setStreamedMaterials(prev => prev.map(m => {
        if (filter === "FILTERED" && m.aiEvaluation === "FILTERED" && m.userStatus !== "DELETED") {
          return { ...m, userStatus: "DELETED" as const }
        }
        if (filter === "ARCHIVED" && m.userStatus === "ARCHIVED") {
          return { ...m, userStatus: "DELETED" as const }
        }
        return m
      }))

      // Account-wide: any story in the view may have been dissolved.
      invalidateStoryPeekCache()
      toast.success(`Deleted ${data.count} posts`)
    } catch (error) {
      console.error("Error bulk deleting:", error)
      toast.error("Error deleting")
    } finally {
      setIsBulkDeleting(false)
    }
  }

  // Dialog is opened via dedicated button, not card click
  // Card click navigates to /posts/[id] full page

  // When searching, use server results (searches ALL posts); otherwise use paginated local data
  const feedSource = searchQuery.trim() && searchResults
    ? searchResults
    : combinedMaterials

  // Build unified render list: buildRenderItems is the single source of truth for filtering + grouping
  const renderItems = useMemo(() => {
    return buildRenderItems(feedSource as any, activeFilter, sourceTypeFilters)
  }, [feedSource, activeFilter, sourceTypeFilters])

  // Defensive: an empty story group would render an empty grid cell. AnimatedGrid
  // gives every item a wrapper, so drop these before they reach it rather than
  // returning null from renderItem.
  const gridItems = useMemo(
    () => renderItems.filter(item => item.type !== "story" || item.story.materials.length > 0),
    [renderItems]
  )

  /**
   * The grid's cells: the processing card first, then the posts. It occupies
   * one ordinary column (`isWideItem` returns false for it), so a story that
   * spans two is unaffected, and its key is stable so AnimatedGrid treats it as
   * one element rather than re-entering it on every state change.
   */
  // Depends on `processing.dismiss`, not on `processing`: the controller object
  // is stable across streamed frames now, but it still changes on every phase
  // transition, and this callback is a prop on the memoised card.
  const { dismiss: dismissRun } = processing
  const dismissProcessing = useCallback(() => {
    dismissRun()
    parseButtonRef.current?.focus()
  }, [dismissRun])

  /**
   * Hoisted so a plain post card's five props are all referentially stable and
   * the memo on `MaterialCard` actually holds: an inline
   * `hasNotionIntegration ? handleSendToNotion : undefined` is stable too, but
   * only by accident of the ternary, and it reads as if it were not.
   */
  const sendToNotionProp = hasNotionIntegration ? handleSendToNotion : undefined

  // --- Peek wiring (RAD-345) ----------------------------------------------

  /** The peek's prev/next walk: the visible cells, in the order they render. */
  const peekOrder = useMemo<PeekTarget[]>(
    () =>
      gridItems.map(item =>
        item.type === "story"
          ? { kind: "story" as const, id: item.story.story.id }
          : { kind: "post" as const, id: item.material.id }
      ),
    [gridItems]
  )
  const peekOrderRef = useRef(peekOrder)
  const gridItemsRef = useRef(gridItems)
  useEffect(() => {
    peekOrderRef.current = peekOrder
    gridItemsRef.current = gridItems
  }, [peekOrder, gridItems])

  const peekIndex = peek ? peekOrder.findIndex(t => samePeek(t, peek)) : -1
  const canPrevious = peekIndex > 0
  const canNext = peekIndex >= 0 && peekIndex < peekOrder.length - 1

  /** The live copy for the open post; the snapshot covers a list reset. */
  const peekMaterial = useMemo(() => {
    if (peek?.kind !== "post") return null
    const live = combinedMaterials.find(m => m.id === peek.id)
    if (live) return live
    return peekSnapshotRef.current?.id === peek.id ? peekSnapshotRef.current : null
  }, [peek, combinedMaterials])

  /** Rows the list has loaded, streamed ones included — read from event time. */
  const findListMaterial = useCallback(
    (id: string) =>
      materialsRef.current.find(m => m.id === id) ?? streamedMaterialsRef.current.find(m => m.id === id) ?? null,
    []
  )

  const titleForTarget = useCallback(
    (target: PeekTarget): string => {
      if (target.kind === "post") return findListMaterial(target.id)?.title ?? ""
      const item = gridItemsRef.current.find(i => i.type === "story" && i.story.story.id === target.id)
      return item && item.type === "story" ? item.story.story.title : ""
    },
    [findListMaterial]
  )

  /**
   * Apply a history plan. Both `push` and `replace` pass a null state: Next
   * copies its own internal history fields into whatever object it is given.
   */
  const applyPeekNav = useCallback((plan: ReturnType<typeof planPeekOpen>) => {
    if (typeof window === "undefined") return
    if (plan.type === "push") window.history.pushState(null, "", plan.url)
    else if (plan.type === "replace") window.history.replaceState(null, "", plan.url)
  }, [])

  const clearPeekCloseTimer = useCallback(() => {
    if (peekCloseTimerRef.current) {
      clearTimeout(peekCloseTimerRef.current)
      peekCloseTimerRef.current = null
    }
  }, [])

  /** Drop the content once the exit animation is over. */
  const schedulePeekContentClear = useCallback(() => {
    clearPeekCloseTimer()
    peekCloseTimerRef.current = setTimeout(() => {
      peekCloseTimerRef.current = null
      setPeek(null)
      setPeekTitle("")
    }, PEEK_EXIT_MS)
  }, [clearPeekCloseTimer])

  const openPeek = useCallback(
    (target: PeekTarget, origin: HTMLElement | null = null) => {
      // The plan reads the URL — the authority on which entry exists — not
      // `peekRef`: after a close the entry is already the clean list URL while
      // the ref still holds the exiting target.
      const plan = planPeekOpen({
        current: parsePeek(window.location.search),
        next: target,
        pathname: window.location.pathname,
        search: window.location.search,
      })
      // "none" now means the URL already names this target, so it is open;
      // a second open in the same tick must not push another entry.
      if (plan.type === "none" && isPeekOpenRef.current) return

      clearPeekCloseTimer()
      peekClosingRef.current = false
      peekOriginRef.current = origin
      peekSnapshotRef.current = findListMaterial(target.id)
      applyPeekNav(plan)
      // Written through, not only through the sync effect.
      peekRef.current = target
      isPeekOpenRef.current = true
      setIsPeekOpen(true)
      setPeek(target)
      setPeekTitle(titleForTarget(target))
    },
    [applyPeekNav, clearPeekCloseTimer, findListMaterial, titleForTarget]
  )

  /**
   * Close rewrites this history entry back to the list URL (never `back()` —
   * see `planPeekClose`), and it is optimistic: the panel slides out now while
   * the URL is cleaned underneath it. The `popstate` sync stays idempotent.
   */
  const closePeek = useCallback(() => {
    if (peekClosingRef.current || !peekRef.current) return
    peekClosingRef.current = true
    const plan = planPeekClose({
      pathname: window.location.pathname,
      search: window.location.search,
    })
    // Open state off now (the panel animates out with its content still
    // mounted), the target cleared when the exit has finished.
    isPeekOpenRef.current = false
    setIsPeekOpen(false)
    applyPeekNav(plan)
    schedulePeekContentClear()
  }, [applyPeekNav, schedulePeekContentClear])

  useEffect(() => clearPeekCloseTimer, [clearPeekCloseTimer])

  useEffect(() => {
    closePeekRef.current = closePeek
  }, [closePeek])

  const navigatePeek = useCallback(
    (direction: "next" | "previous") => {
      const current = peekRef.current
      if (!current) return
      const target = peekNeighbour(peekOrderRef.current, current, direction)
      if (target) openPeek(target)
    },
    [openPeek]
  )

  /**
   * The post archiving path's "and the next one, please": the opener for the
   * cell after `target`, or null when there is nowhere to go. Only planned
   * when `target` is what the panel shows — the last cell of a list, a target
   * outside the visible order (a deep link into another filter) and a panel
   * that is exiting all plan nothing, and the panel keeps the archived copy it
   * has been showing. Planning is separate from opening because the archive
   * request comes first: a failed one must leave the panel where it failed.
   */
  const planPeekAdvance = useCallback(
    (target: PeekTarget): (() => void) | null => {
      // `isPeekOpenRef` too: through the exit animation `peekRef` still holds
      // the closed target, and archiving that card in that window must not
      // resurrect the panel.
      if (!isPeekOpenRef.current) return null
      if (!samePeek(peekRef.current, target)) return null
      const next = peekNeighbour(peekOrderRef.current, target, "next")
      return next ? () => openPeek(next) : null
    },
    [openPeek]
  )

  useEffect(() => {
    planPeekAdvanceRef.current = planPeekAdvance
  }, [planPeekAdvance])

  /** Where focus goes when the peek closes — the card, or the toolbar. */
  const restorePeekFocus = useCallback((): HTMLElement | null => {
    const origin = peekOriginRef.current
    if (origin && document.contains(origin)) return origin
    return parseButtonRef.current
  }, [])

  const handleCardOpen = useCallback(
    (kind: "post" | "story", id: string, origin: HTMLElement | null) => {
      openPeek({ kind, id }, origin)
    },
    [openPeek]
  )

  const handlePeekTitle = useCallback((title: string) => {
    setPeekTitle(prev => (prev === title ? prev : title))
  }, [])

  const handleOpenModeChange = useCallback(
    (next: OpenMode) => {
      setOpenMode(next)
      // Switching back to full page contradicts a panel that is already open.
      if (next === "page" && peekRef.current) closePeek()
    },
    [setOpenMode, closePeek]
  )

  /** Browser Back/Forward is the single source of truth for the open target. */
  useEffect(() => {
    const onPopState = () => {
      const target = parsePeek(window.location.search)
      // An exiting peek is not "already open": Forward back into it must
      // reopen the panel, not be swallowed because the target still matches.
      if (samePeek(target, peekRef.current) && isPeekOpenRef.current) return
      if (target) {
        // Forward into a peek is an open like any other.
        clearPeekCloseTimer()
        peekClosingRef.current = false
        peekRef.current = target
        isPeekOpenRef.current = true
        setIsPeekOpen(true)
        setPeek(target)
        return
      }
      // Back out of a peek: animate out, then drop the content.
      peekClosingRef.current = true
      isPeekOpenRef.current = false
      setIsPeekOpen(false)
      schedulePeekContentClear()
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [clearPeekCloseTimer, schedulePeekContentClear])

  /** `j`/`k` walk the peek order while a peek is open. */
  useEffect(() => {
    if (!peek) return
    const onKeyDown = (event: KeyboardEvent) => {
      const intent = navKeyIntent({
        key: event.key,
        target: event.target,
        selectionCollapsed: window.getSelection()?.isCollapsed ?? true,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      })
      if (!intent) return
      event.preventDefault()
      navigatePeek(intent)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [peek, navigatePeek])


  const cells = useMemo<GridCell[]>(() => {
    const showCard = processing.isRunning || processing.isTerminal
    return showCard ? [PROCESSING_CELL, ...gridItems] : gridItems
  }, [gridItems, processing.isRunning, processing.isTerminal])

  /**
   * One number for the screen: how many posts the current query matches.
   *
   * With no refinement that is the view's server total. With one it is the
   * refined query's own total, taken from the response that served it — NOT a
   * count of mounted cards, which is capped at a page and would silently change
   * what the number means the moment a source type is picked (an account with
   * 400 Telegram posts reading "96"). The mounted count is the fallback only
   * where no request was made, because the SSR page already held enough rows —
   * there it is not an approximation of the total, it is all there is.
   *
   * Posts, never grid cells: one story cell can hold several posts.
   */
  const refined = searchQuery.trim().length > 0 || !sourceTypeFilters.includes("ALL")
  const mountedPostCount = renderItems.reduce(
    (n, item) => n + (item.type === "story" ? item.story.materials.length : 1),
    0
  )
  const headingCount: number | "pending" | null = isSearching
    ? "pending"
    : refined
      ? (refinedTotal ?? mountedPostCount)
      : (filterCounts[activeFilter] ?? totalCount)

  const runningLabel =
    processing.phase === "grouping"
      ? "Grouping stories…"
      : processing.phase === "refiltering"
        ? "Re-filtering…"
        : "Parsing…"

  /**
   * Bulk delete is account-wide: `/api/posts/bulk-delete` takes a filter and
   * nothing else — not the search, not the types, not the source, not the
   * folder. It is offered only where that scope is the honest one, labelled
   * with it, and hidden on a source or folder page, where it would read as
   * "delete this scope's posts".
   */
  const bulkDeleteAction =
    !feedId && !folderId && (activeFilter === "FILTERED" || activeFilter === "ARCHIVED")
      ? {
          count: filterCounts[activeFilter] ?? 0,
          isDeleting: isBulkDeleting,
          onDelete: () => handleBulkDelete(activeFilter as "FILTERED" | "ARCHIVED"),
        }
      : undefined

  /**
   * The scope heading. `scopeName` is the folder page (heading, type filter
   * stays visible); `hideSourceTypeFilter` is the source page (heading and the
   * type menu is hidden because a single source has one type). Undefined on
   * /posts, where the toolbar shows the view word instead.
   */
  const scopeHeading = scopeName ?? (hideSourceTypeFilter ? (title ?? undefined) : undefined)

  return (
    <div className="p-4 lg:p-8 space-y-6">
      <div className="mt-2 lg:mt-4">
        <PostsToolbar
          view={activeFilter}
          onViewChange={setActiveFilter}
          viewCounts={filterCounts}
          headingCount={headingCount}
          sourceTypes={sourceTypeFilters}
          onSourceTypesChange={setSourceTypeFilters}
          sourceTypeCounts={sourceTypeCounts}
          hideSourceTypes={hideSourceTypeFilter}
          search={searchQuery}
          onSearchChange={setSearchQuery}
          openMode={openMode}
          onOpenModeChange={handleOpenModeChange}
          sourceName={scopeHeading}
          leading={leading}
          trailing={headerExtra}
          isRunning={processing.isRunning}
          runningLabel={runningLabel}
          parseButtonRef={parseButtonRef}
          onParse={processing.startParse}
          onGroupStories={processing.startGrouping}
          onRefilter={processing.startRefilter}
          bulkDelete={bulkDeleteAction}
          freshness={freshness}
          lastRun={lastRun}
        />
        {/* Scope identity detail (type, URL, source count) keeps its place under the heading. */}
        {scopeHeading !== undefined && subtitle !== null && (
          <div className="mt-1 hidden items-center gap-2 text-sm text-muted-foreground sm:flex">{subtitle}</div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1">
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-[20px] w-[20px] animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Searching all posts...</span>
          </div>
        )}
        {/*
          The processing card is a grid item, not a branch: an empty view during
          a first run must still show the run. The empty state moves below the
          grid so it can never hide processing.
        */}
        {!isSearching && (
          <>
            <AnimatedGrid
              items={cells}
              className="grid gap-4 sm:gap-6 grid-cols-1 min-[640px]:grid-cols-2 min-[1280px]:grid-cols-3 min-[1700px]:grid-cols-4 min-[1920px]:grid-cols-5 min-[2400px]:grid-cols-6"
              style={{ gridAutoFlow: "dense" }}
              itemClassName={(item) => (isWideItem(item) ? "sm:col-span-2" : undefined)}
              renderItem={(item) => {
                if (item.type === "processing") {
                  // The store, not the state: this cell subscribes to it, so a
                  // streamed frame re-renders the card alone. Passing
                  // `processing.state` here would put every frame back through
                  // this render and re-measure the whole grid — see
                  // `ProcessingCell` and `ProcessingStore`.
                  return (
                    <ProcessingCell
                      store={processing.store}
                      onStop={processing.stop}
                      onDismiss={dismissProcessing}
                    />
                  )
                }

                if (item.type === "story") {
                  const { story, materials: storyMaterials } = item.story
                  const totalSourceCount =
                    (story._count?.materials ?? storyMaterials.length) +
                    (story._count?.inboxItems ?? 0)
                  const storyMaterialIds = storyMaterials.map(m => m.id)
                  const primaryMaterial = storyLeadMaterial(storyMaterials)!
                  // The cover spans every loaded member, primary first (RAD-399).
                  // The play badge follows the owner of the first frame; if that
                  // frame fails and CardCover promotes the next one (often another
                  // member's), the badge keeps describing the original owner — a
                  // rare mismatch, accepted rather than threading per-frame badges.
                  const storyCover = storyGalleryImages([
                    primaryMaterial,
                    ...storyMaterials.filter(m => m !== primaryMaterial),
                  ])

                  return (
                    <MaterialCard
                      material={primaryMaterial}
                      story={story}
                      storyMaterials={storyMaterials.map((m) => ({
                        id: m.id,
                        title: m.title,
                        url: m.url,
                        feed: m.feed,
                        publishedAt: m.publishedAt,
                        createdAt: m.createdAt,
                        userStatus: m.userStatus,
                      }))}
                      sourceCount={totalSourceCount}
                      isWide={isWideItem(item)}
                      cover={{
                        images: storyCover.images,
                        hasVideo: storyCover.coverOwner ? coverHasVideo(storyCover.coverOwner) : false,
                      }}
                      onOpen={openMode === "drawer" ? handleCardOpen : undefined}
                      onStoryFeedback={(feedbackType) => handleStoryFeedbackPropagation(primaryMaterial.id, storyMaterialIds, feedbackType)}
                      onSendToNotion={hasNotionIntegration ? (_id) => handleStorySendToNotion(story.id, storyMaterialIds) : undefined}
                      onArchive={(_id) => handleStoryArchive(storyMaterialIds, story.id)}
                      onDelete={(_id, feedback) => handleStoryDelete(storyMaterialIds, feedback, story.id)}
                      onRestore={(_id) => handleStoryRestore(storyMaterialIds, story.id)}
                    />
                  )
                }

                return (
                  <MaterialCard
                    material={item.material}
                    onOpen={openMode === "drawer" ? handleCardOpen : undefined}
                    onSendToNotion={sendToNotionProp}
                    onDelete={handleDelete}
                    onArchive={handleArchive}
                    onRestore={handleRestore}
                  />
                )
              }}
            />

            {/* The processing card already occupies the grid while a run is
                live, so an empty state here would tell the user to "run
                parsing" under a disabled "Parsing..." button — and put a
                second "Run parsing" on screen. It returns when the run
                settles or when there is nothing running at all. */}
            {gridItems.length === 0 && !hasMore && !processing.isRunning && (
              <EmptyState onParse={processing.startParse} />
            )}

            {/* Load more button — only when not searching */}
            {hasMore && !searchQuery.trim() && (
              <div className="flex justify-center pt-8 pb-4">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="min-w-[200px]"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="h-[16px] w-[16px] mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load more posts`
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Dialog kept for potential desktop quick-view */}

      {/*
        The side peek (RAD-345). Portaled by Radix, so it sits above the grid
        without a wrapper; the content components are keyed by target, which is
        what resets their fetch state when the target changes.
      */}
      <PeekHost
        open={isPeekOpen}
        onClose={closePeek}
        title={peekTitle}
        href={peek ? peekHref(peek) : "#"}
        onNavigate={navigatePeek}
        canPrevious={canPrevious}
        canNext={canNext}
        restoreFocus={restorePeekFocus}
      >
        {peek?.kind === "post" ? (
          <PostPeek
            key={`post:${peek.id}`}
            materialId={peek.id}
            material={peekMaterial}
            hasNotionIntegration={hasNotionIntegration}
            onDelete={handleDelete}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onSendToNotion={sendToNotionProp}
            onClosePeek={closePeek}
            onTitleResolved={handlePeekTitle}
          />
        ) : peek ? (
          <StoryPeek
            key={`story:${peek.id}`}
            storyId={peek.id}
            hasNotionIntegration={hasStoryNotionIntegration}
            onArchive={handleStoryArchive}
            onRestore={handleStoryRestore}
            onDelete={handleStoryDelete}
            onSendToNotion={hasStoryNotionIntegration ? handleStorySendToNotion : undefined}
            onFeedback={(primaryMaterialId, materialIds, feedbackType) => {
              void handleStoryFeedbackPropagation(primaryMaterialId, materialIds, feedbackType)
              // The cached copy carries the old `feedbacks`; drop it so the next
              // open reflects the signal. Read at event time — the peek is open.
              const target = peekRef.current
              invalidateStoryPeekCache(target?.kind === "story" ? target.id : undefined)
              // The grid card and `/stories/[id]` both archive on a dislike;
              // the peek must not be the one place where the signal is inert.
              if (feedbackType === "DISLIKE") {
                setTimeout(() => void handleStoryArchive(materialIds), 450)
              }
            }}
            onOpenMaterial={(materialId) => openPeek({ kind: "post", id: materialId })}
            onClosePeek={closePeek}
            onTitleResolved={handlePeekTitle}
          />
        ) : null}
      </PeekHost>
    </div>
  )
}

/**
 * Shown only when no run is live (see the render guard): a run in flight is
 * reported by the processing card, and a "Run parsing" button that disables
 * itself mid-run is a state this component no longer needs to carry.
 */
function EmptyState({ onParse }: { onParse: () => void }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-xl surface-card p-12 md:p-16">
      <div className="relative">
        <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-muted">
          <Search className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-green-bright">
          <span className="type-counter text-xs font-bold text-primary-foreground">0</span>
        </div>
      </div>
      <h3 className="mt-6 text-xl font-bold">No posts</h3>
      <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
        Add feeds in the &ldquo;Feeds&rdquo; section and run parsing to collect content
      </p>
      <div className="mt-6 flex gap-3">
        <Button variant="outline" asChild>
          <Link href="/feeds">Add feeds</Link>
        </Button>
        <Button onClick={onParse}>Run parsing</Button>
      </div>
    </div>
  )
}
