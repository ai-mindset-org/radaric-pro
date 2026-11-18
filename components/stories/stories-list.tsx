"use client"

import { useState, useMemo, useEffect, useCallback, useRef } from "react"
import { formatDistanceToNow, isToday, isThisWeek } from "date-fns"
import { enUS } from "date-fns/locale"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FilterChip } from "@/components/ui/filter-chip"
import { StoryCard } from "./story-card"
import {
  BookOpen,
  Clock,
  AlertCircle,
  Loader2,
  RefreshCw,
  Search,
  CheckCircle2,
  Trash2,
  X,
  Inbox,
  ArrowUpDown,
  EyeOff,
} from "lucide-react"
import { toast } from "sonner"
import { previewImageUrl } from "@/lib/media-urls"

interface Story {
  id: string
  title: string
  languageFlag: string | null
  summary: string
  rubrics: string[]
  sourceUrls: string[]
  notionUrl: string | null
  status: string
  version: number
  createdAt: string
  updatedAt: string
  inboxItems?: Array<{
    thumbnailUrl: string | null
    mediaUrls: string[]
  }>
  _count: {
    inboxItems: number
  }
}

function getStoryPreview(story: Story): string | null {
  const item = story.inboxItems?.[0]
  if (!item) return null
  // An image only — `mediaUrls[0]` may be a video, which paints as a broken
  // band in `CardCover` (RAD-359).
  return previewImageUrl({ thumbnailUrl: item.thumbnailUrl, mediaUrls: item.mediaUrls })
}

interface InboxItem {
  id: string
  externalId: string
  rawText: string | null
  extractedUrl: string | null
  extractedTitle: string | null
  status: string
  errorMessage: string | null
  retryCount: number
  createdAt: string
  storyId: string | null
}

type TimeFilter = "all" | "today" | "week"
type SortBy = "newest" | "oldest" | "title-asc" | "title-desc" | "recently-updated"
type QueueView = null | "ERROR" | "PENDING"

const VIEWED_STORIES_KEY = "radaric-story-viewed-times"

function getViewedTimes(): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(VIEWED_STORIES_KEY) || "{}")
  } catch {
    return {}
  }
}

function markStoryViewed(storyId: string) {
  const times = getViewedTimes()
  times[storyId] = new Date().toISOString()
  localStorage.setItem(VIEWED_STORIES_KEY, JSON.stringify(times))
}

function hasNewSources(story: Story): boolean {
  const times = getViewedTimes()
  const lastViewed = times[story.id]
  if (!lastViewed) return true // Never viewed — treat as new
  return new Date(story.updatedAt) > new Date(lastViewed)
}

const POLL_INTERVAL_MS = 30_000

export function StoriesList({
  initialStories,
  pendingCount,
  errorCount,
  processedToday,
}: {
  initialStories: Story[]
  pendingCount: number
  errorCount: number
  processedToday: number
}) {
  const [stories, setStories] = useState(initialStories)
  const [counts, setCounts] = useState({ pendingCount, errorCount, processedToday })
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all")
  const [sortBy, setSortBy] = useState<SortBy>("newest")
  const [hideErrors, setHideErrors] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [isPolling, setIsPolling] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [queueView, setQueueView] = useState<QueueView>(null)
  const [queueItems, setQueueItems] = useState<InboxItem[]>([])
  const [isLoadingQueue, setIsLoadingQueue] = useState(false)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())

  const fetchStories = useCallback(async () => {
    try {
      const res = await fetch("/api/stories?limit=100")
      if (!res.ok) return
      const data = await res.json()
      if (data.stories) {
        setStories(data.stories)
        setCounts({
          pendingCount: data.pendingCount ?? 0,
          errorCount: data.errorCount ?? 0,
          processedToday: data.processedToday ?? 0,
        })
      }
    } catch {
      // Silently ignore — will retry on next interval
    }
  }, [])

  const fetchQueueItems = useCallback(async (status: "ERROR" | "PENDING") => {
    setIsLoadingQueue(true)
    try {
      const res = await fetch(`/api/inbox-items?status=${status}&limit=100`)
      if (!res.ok) return
      const data = await res.json()
      setQueueItems(data.items ?? [])
    } catch {
      // Silently ignore
    } finally {
      setIsLoadingQueue(false)
    }
  }, [])

  const handleOpenQueue = useCallback(async (status: "ERROR" | "PENDING") => {
    if (queueView === status) {
      setQueueView(null)
      return
    }
    setQueueView(status)
    await fetchQueueItems(status)
  }, [queueView, fetchQueueItems])

  const handleDeleteItem = useCallback(async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id))
    try {
      const res = await fetch(`/api/inbox-items/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || "Delete failed")
        return
      }
      setQueueItems((prev) => prev.filter((item) => item.id !== id))
      setCounts((prev) => ({
        ...prev,
        errorCount: queueView === "ERROR" ? Math.max(0, prev.errorCount - 1) : prev.errorCount,
        pendingCount: queueView === "PENDING" ? Math.max(0, prev.pendingCount - 1) : prev.pendingCount,
      }))
      toast.success("Deleted")
    } catch {
      toast.error("Network error")
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [queueView])

  const handleRetryItem = useCallback(async (id: string) => {
    setRetryingIds((prev) => new Set(prev).add(id))
    try {
      const res = await fetch(`/api/inbox-items/${id}/retry`, { method: "POST" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setQueueItems((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, errorMessage: data.error || "Retry failed", retryCount: item.retryCount + 1 } : item
          )
        )
        toast.error(data.error || "Retry failed")
        return
      }
      const data = await res.json().catch(() => ({ success: true }))
      if (data.success) {
        setQueueItems((prev) => prev.filter((item) => item.id !== id))
        setCounts((prev) => ({
          ...prev,
          errorCount: queueView === "ERROR" ? Math.max(0, prev.errorCount - 1) : prev.errorCount,
          pendingCount: queueView === "PENDING" ? Math.max(0, prev.pendingCount - 1) : prev.pendingCount,
        }))
        toast.success("Processed successfully")
        await fetchStories()
      }
    } catch {
      toast.error("Network error")
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [queueView, fetchStories])

  const handleDeleteAll = useCallback(async () => {
    if (queueItems.length === 0) return
    const toDelete = [...queueItems]
    for (const item of toDelete) {
      await handleDeleteItem(item.id)
    }
    await fetchStories()
  }, [queueItems, handleDeleteItem, fetchStories])

  useEffect(() => {
    refreshTimerRef.current = setInterval(fetchStories, POLL_INTERVAL_MS)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [fetchStories])

  const filteredStories = useMemo(() => {
    let result = stories

    // Hide errors by default
    if (hideErrors && !statusFilter) {
      result = result.filter((s) => s.status !== "ERROR")
    }

    // Status filter
    if (statusFilter) {
      result = result.filter((s) => s.status === statusFilter)
    }

    // Time filter
    if (timeFilter === "today") {
      result = result.filter((s) => isToday(new Date(s.createdAt)))
    } else if (timeFilter === "week") {
      result = result.filter((s) => isThisWeek(new Date(s.createdAt), { weekStartsOn: 1 }))
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.summary.toLowerCase().includes(q) ||
          s.rubrics.some((r) => r.toLowerCase().includes(q))
      )
    }

    // Sort
    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        case "oldest":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        case "title-asc":
          return a.title.localeCompare(b.title)
        case "title-desc":
          return b.title.localeCompare(a.title)
        case "recently-updated":
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        default:
          return 0
      }
    })

    return result
  }, [stories, statusFilter, timeFilter, searchQuery, sortBy, hideErrors])

  const handlePoll = async () => {
    setIsPolling(true)
    try {
      const res = await fetch("/api/stories/poll", { method: "POST" })
      const data = await res.json()
      if (res.ok) {
        toast.success(`Processed: ${data.processed} successful, ${data.errors} errors`)
        await fetchStories()
      } else {
        toast.error(data.error || "Processing failed")
      }
    } catch {
      toast.error("Network error")
    } finally {
      setIsPolling(false)
    }
  }

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 lg:mt-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Stories</h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI-generated editorial stories from your approved posts
          </p>
        </div>
        <Button onClick={handlePoll} disabled={isPolling} variant="outline" size="sm">
          {isPolling ? (
            <Loader2 className="h-[16px] w-[16px] mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-[16px] w-[16px] mr-2" />
          )}
          Process
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 h-[16px] w-[16px] text-muted-foreground" />
        <Input
          placeholder="Search by title, description, or category..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <FilterChip active={timeFilter === "all"} onClick={() => setTimeFilter("all")}>All</FilterChip>
        <FilterChip active={timeFilter === "today"} onClick={() => setTimeFilter("today")}>Today</FilterChip>
        <FilterChip active={timeFilter === "week"} onClick={() => setTimeFilter("week")}>This week</FilterChip>

        <div className="h-6 w-px bg-border mx-1 self-center" />

        <FilterChip active={statusFilter === null} onClick={() => setStatusFilter(null)}>All statuses</FilterChip>
        <FilterChip active={statusFilter === "DRAFT"} onClick={() => setStatusFilter("DRAFT")}>Drafts</FilterChip>
        <FilterChip active={statusFilter === "SENT_TO_NOTION"} onClick={() => setStatusFilter("SENT_TO_NOTION")}>In Notion</FilterChip>
        {stories.some((s) => s.status === "ERROR") && (
          <FilterChip active={statusFilter === "ERROR"} onClick={() => setStatusFilter("ERROR")}>Errors</FilterChip>
        )}

        <div className="h-6 w-px bg-border mx-1 self-center" />

        {stories.some((s) => s.status === "ERROR") && (
          <FilterChip
            active={hideErrors}
            onClick={() => setHideErrors(!hideErrors)}
            icon={<EyeOff className="h-[14px] w-[14px]" />}
          >
            Hide errors
          </FilterChip>
        )}
      </div>

      {/* Sort */}
      <div className="flex gap-2 flex-wrap items-center">
        <ArrowUpDown className="h-[14px] w-[14px] text-muted-foreground" />
        <FilterChip active={sortBy === "newest"} onClick={() => setSortBy("newest")}>Newest</FilterChip>
        <FilterChip active={sortBy === "oldest"} onClick={() => setSortBy("oldest")}>Oldest</FilterChip>
        <FilterChip active={sortBy === "title-asc"} onClick={() => setSortBy("title-asc")}>Title A→Z</FilterChip>
        <FilterChip active={sortBy === "title-desc"} onClick={() => setSortBy("title-desc")}>Title Z→A</FilterChip>
        <FilterChip active={sortBy === "recently-updated"} onClick={() => setSortBy("recently-updated")}>Recently updated</FilterChip>
      </div>

      {/* Pipeline status bar */}
      <div className="flex items-center gap-4 text-sm rounded-md bg-muted/50 px-4 py-2.5">
        <button
          type="button"
          className={`flex items-center gap-1.5 hover:underline ${queueView === "PENDING" ? "font-bold" : ""}`}
          onClick={() => handleOpenQueue("PENDING")}
        >
          <Clock className="h-[14px] w-[14px] text-muted-foreground" />
          In queue: <strong className="type-counter">{counts.pendingCount}</strong>
        </button>
        {counts.errorCount > 0 && (
          <button
            type="button"
            className={`flex items-center gap-1.5 text-destructive hover:underline ${queueView === "ERROR" ? "font-bold" : ""}`}
            onClick={() => handleOpenQueue("ERROR")}
          >
            <AlertCircle className="h-[14px] w-[14px]" />
            Errors: <strong className="type-counter">{counts.errorCount}</strong>
          </button>
        )}
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="h-[14px] w-[14px]" />
          {/* One flex item: the row's gap would otherwise replace the space. */}
          <span>Today: <span className="type-counter">{counts.processedToday}</span></span>
        </span>
        <span className="ml-auto text-muted-foreground">
          <span className="type-counter">{filteredStories.length}</span> of <span className="type-counter">{stories.length}</span> stories
        </span>
      </div>

      {/* Queue items panel */}
      {queueView && (
        <div className="rounded-xl surface-card">
          <div className="flex items-center justify-between px-4 py-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Inbox className="h-[16px] w-[16px]" />
              {queueView === "ERROR" ? "Processing errors" : "In queue"}
              <Badge variant="secondary" className="text-xs type-counter">{queueItems.length}</Badge>
            </h3>
            <div className="flex items-center gap-2">
              {queueItems.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDeleteAll}
                  className="text-xs h-7 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-[14px] w-[14px] mr-1" />
                  Delete all
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setQueueView(null)}
                className="h-7 w-7 p-0"
                aria-label="Close queue panel"
              >
                <X className="h-[16px] w-[16px]" />
              </Button>
            </div>
          </div>
          {isLoadingQueue ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-[20px] w-[20px] animate-spin text-muted-foreground" />
            </div>
          ) : queueItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No items
            </div>
          ) : (
            <div className="space-y-1">
              {queueItems.map((item) => (
                <QueueItemRow
                  key={item.id}
                  item={item}
                  isDeleting={deletingIds.has(item.id)}
                  isRetrying={retryingIds.has(item.id)}
                  onDelete={handleDeleteItem}
                  onRetry={handleRetryItem}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stories list */}
      {filteredStories.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <BookOpen className="h-[48px] w-[48px] mx-auto mb-4 opacity-30" />
          {searchQuery.trim() ? (
            <>
              <p className="type-heading text-lg font-medium">Nothing found</p>
              <p className="text-sm mt-1">
                Try changing your search or resetting filters
              </p>
            </>
          ) : (
            <>
              <p className="type-heading text-lg font-medium">No stories yet</p>
              <p className="text-sm mt-1">
                Send a post to Stories from your inbox — AI will generate an editorial story
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:gap-6 grid-cols-1 min-[640px]:grid-cols-2 min-[1280px]:grid-cols-3 min-[1700px]:grid-cols-4 min-[1920px]:grid-cols-5 min-[2400px]:grid-cols-6">
          {filteredStories.map((story, index) => {
            const delay = Math.min(index * 50, 500)
            return (
              <div
                key={story.id}
                className="will-animate animate-fade-in-scale"
                style={{ animationDelay: `${delay}ms` }}
              >
                <StoryCard
                  story={story}
                  previewUrl={getStoryPreview(story)}
                  hasNewSources={hasNewSources(story)}
                  onView={() => markStoryViewed(story.id)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function QueueItemRow({
  item,
  isDeleting,
  isRetrying,
  onDelete,
  onRetry,
}: {
  item: InboxItem
  isDeleting: boolean
  isRetrying: boolean
  onDelete: (id: string) => void
  onRetry: (id: string) => void
}) {
  const label = item.extractedTitle || item.extractedUrl || item.rawText?.slice(0, 120) || item.externalId
  const domain = item.extractedUrl
    ? (() => { try { return new URL(item.extractedUrl).hostname.replace("www.", "") } catch { return null } })()
    : null

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium">{label}</p>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {domain && <span>{domain}</span>}
          <span>
            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: enUS })}
          </span>
          {item.retryCount > 0 && <span>attempts: <span className="type-counter">{item.retryCount}</span></span>}
        </div>
        {item.errorMessage && (
          <p className="text-xs text-destructive mt-1 line-clamp-2">{item.errorMessage}</p>
        )}
      </div>
      <Badge
        variant={item.status === "ERROR" ? "destructive" : "secondary"}
        className="text-xs shrink-0"
      >
        {item.status === "ERROR" ? "Error" : item.status}
      </Badge>
      {item.status === "ERROR" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onRetry(item.id)}
          disabled={isRetrying || isDeleting}
          aria-label="Retry processing"
        >
          {isRetrying ? (
            <Loader2 className="h-[16px] w-[16px] animate-spin" />
          ) : (
            <RefreshCw className="h-[16px] w-[16px]" />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => onDelete(item.id)}
        disabled={isDeleting || isRetrying}
        aria-label="Delete item"
      >
        {isDeleting ? (
          <Loader2 className="h-[16px] w-[16px] animate-spin" />
        ) : (
          <Trash2 className="h-[16px] w-[16px]" />
        )}
      </Button>
    </div>
  )
}

