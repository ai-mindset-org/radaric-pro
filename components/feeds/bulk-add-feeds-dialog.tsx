"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, FileText, Loader2, Rss, Send, Upload, X, Youtube } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MorphText } from "@/components/ui/morph-text"
import { XIcon } from "@/components/ui/icons"
import { FeedDiscoveryProgress } from "@/components/onboarding/feed-discovery-progress"
import type { ExtractedFeed } from "@/lib/onboarding-types"
import { detectFlavor, isFeedFlavor, FLAVOR_CONFIGS, type FeedFlavor } from "@/lib/feed-flavor"
import { FLAVOR_ICONS } from "@/components/feeds/flavor-icons"

type Stage = "input" | "parsing" | "review"
type ReviewFeed = ExtractedFeed & { id: string; removed?: boolean }

const FEED_TYPE_DOT: Record<string, string> = {
  RSS: "bg-[var(--color-feed-rss,#f76b15)]",
  TELEGRAM: "bg-info",
  TWITTER: "bg-muted-foreground",
  YOUTUBE: "bg-[#e5484d]",
}
const FEED_TYPE_LABEL: Record<string, string> = {
  RSS: "RSS",
  TELEGRAM: "Telegram",
  TWITTER: "Twitter/X",
  YOUTUBE: "YouTube",
}

// Branded RSS presets (Substack, GitHub, …) are plain RSS under the hood but
// carry a brand identity derived on read from the resolved feed URL
// (detectFlavor). The review step groups by that flavor so each brand shows its
// own glyph + label — matching feed-card and the sidebar. The dot keeps the RSS
// tint: brand is carried by icon + label, never color alone (RAD-268 idiom).
type GroupKey = "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | FeedFlavor

const GROUP_ORDER: GroupKey[] = [
  "RSS", "SUBSTACK", "BLUESKY", "MASTODON", "PRODUCTHUNT", "GITHUB", "ARXIV",
  "TELEGRAM", "TWITTER", "YOUTUBE",
]

// Flavor groups are RSS underneath, so their dot follows the RSS tint.
const GROUP_BASE_TYPE: Record<GroupKey, "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE"> = {
  RSS: "RSS", SUBSTACK: "RSS", BLUESKY: "RSS", MASTODON: "RSS",
  PRODUCTHUNT: "RSS", GITHUB: "RSS", ARXIV: "RSS",
  TELEGRAM: "TELEGRAM", TWITTER: "TWITTER", YOUTUBE: "YOUTUBE",
}

const GROUP_ICON: Record<GroupKey, React.ComponentType<{ className?: string }>> = {
  RSS: Rss,
  TELEGRAM: Send,
  TWITTER: XIcon,
  YOUTUBE: Youtube,
  ...FLAVOR_ICONS,
}

const groupLabel = (key: GroupKey): string =>
  isFeedFlavor(key) ? FLAVOR_CONFIGS[key].label : FEED_TYPE_LABEL[key]

const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_FEEDS = 300
const WARN_FEEDS = 280

const STAGE_TITLES: Record<Stage, string> = {
  input: "Add feeds",
  parsing: "Finding feeds",
  review: "Review feeds",
}

interface BulkAddFeedsDialogProps {
  children: React.ReactNode
}

export function BulkAddFeedsDialog({ children }: BulkAddFeedsDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>("input")
  const [text, setText] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState("")
  const [feeds, setFeeds] = useState<ExtractedFeed[]>([])
  const [reviewFeeds, setReviewFeeds] = useState<ReviewFeed[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const parseAbortRef = useRef<AbortController | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)

  const resetAll = useCallback(() => {
    parseAbortRef.current?.abort()
    parseAbortRef.current = null
    saveAbortRef.current?.abort()
    saveAbortRef.current = null
    setStage("input")
    setText("")
    setFile(null)
    setError("")
    setIsLoading(false)
    setIsSaving(false)
    setFeeds([])
    setReviewFeeds([])
  }, [])

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      resetAll()
    }
    setOpen(next)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > MAX_FILE_SIZE) {
      setError("File too large. Max 5 MB.")
      return
    }
    setFile(f)
    setError("")
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.size > MAX_FILE_SIZE) {
      setError("File too large. Max 5 MB.")
      return
    }
    setFile(f)
    setError("")
  }, [])

  const isAbortError = (e: unknown) =>
    e instanceof DOMException && e.name === "AbortError"

  const handleSubmit = async () => {
    if (!text.trim() && !file) return
    setIsLoading(true)
    setError("")
    const controller = new AbortController()
    parseAbortRef.current = controller

    try {
      const fd = new FormData()
      if (text.trim()) fd.append("text", text.trim())
      if (file) fd.append("file", file)

      const res = await fetch("/api/onboarding/parse-feeds", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error || "Failed to parse feeds")
        setIsLoading(false)
        return
      }

      setStage("parsing")
      setIsLoading(false)

      const reader = res.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      const parsed: ExtractedFeed[] = []
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === "feed") {
              parsed.push(ev.feed)
              setFeeds([...parsed])
            } else if (ev.type === "update") {
              // Match by name alone — `url` can change when pending WEBSITE
              // resolves into RSS with a different feedUrl, so a composite
              // key would miss the replacement.
              const i = parsed.findIndex((f) => f.name === ev.feed.name)
              if (i !== -1) {
                parsed[i] = ev.feed
                setFeeds([...parsed])
              }
            } else if (ev.type === "complete") {
              setFeeds([...parsed])
            } else if (ev.type === "error") {
              setError(ev.message)
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } catch (e) {
      if (isAbortError(e)) return
      setError("An error occurred. Try pasting URLs one per line.")
      setIsLoading(false)
    }
  }

  const handleDiscoveryComplete = (resolved: ExtractedFeed[]) => {
    const found: ReviewFeed[] = resolved
      .filter((f) => f.status === "found")
      .map((f, i) => {
        const url = f.feedUrl || f.url || ""
        return {
          ...f,
          id: `bulk-${i}`,
          type: f.type === "WEBSITE" ? "RSS" : f.type,
          url,
        }
      })
      .filter((f) => f.url)
    setReviewFeeds(found)
    setStage("review")
  }

  const removeFeed = (id: string) => {
    setReviewFeeds((prev) =>
      prev.map((f) => (f.id === id ? { ...f, removed: true } : f))
    )
    toast("Feed removed", {
      action: {
        label: "Undo",
        onClick: () =>
          setReviewFeeds((prev) =>
            prev.map((f) => (f.id === id ? { ...f, removed: false } : f))
          ),
      },
      duration: 5000,
    })
  }

  const activeReview = useMemo(
    () => reviewFeeds.filter((f) => !f.removed),
    [reviewFeeds]
  )
  const grouped = useMemo(
    () =>
      activeReview.reduce<Partial<Record<GroupKey, ReviewFeed[]>>>((acc, f) => {
        // Branded RSS feeds group under their flavor; everything else under its type.
        const key: GroupKey =
          f.type === "RSS" ? detectFlavor(f.url ?? "") ?? "RSS" : (f.type as GroupKey)
        ;(acc[key] ??= []).push(f)
        return acc
      }, {}),
    [activeReview]
  )
  const groups = useMemo(
    () => GROUP_ORDER.filter((k) => grouped[k]?.length),
    [grouped]
  )
  const notFoundCount = useMemo(
    () => feeds.filter((f) => f.status === "not_found").length,
    [feeds]
  )

  const overCap = activeReview.length > MAX_FEEDS
  const nearCap = activeReview.length >= WARN_FEEDS && !overCap

  const handleSave = async () => {
    if (!activeReview.length || overCap) return
    setIsSaving(true)
    const controller = new AbortController()
    saveAbortRef.current = controller
    try {
      const res = await fetch("/api/onboarding/save-feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feeds: activeReview.map((f) => ({
            name: f.name,
            url: f.url || "",
            type: f.type,
          })),
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error || "Failed to save feeds")
        return
      }
      const body = (await res.json()) as {
        created: number
        skipped: number
        twitterSkipped?: number
      }
      const created = body.created ?? 0
      const skipped = body.skipped ?? 0
      const twitterSkipped = body.twitterSkipped ?? 0
      // X feeds dropped because the plan is Lite — surface it so the skip isn't silent.
      const xNote = twitterSkipped
        ? ` · ${twitterSkipped} X feed${twitterSkipped === 1 ? "" : "s"} need Pro`
        : ""
      toast.success(
        created > 0
          ? `${created} feed${created === 1 ? "" : "s"} added${
              skipped ? ` (${skipped} already existed)` : ""
            }${xNote}`
          : twitterSkipped
            ? `X feeds need Radaric Pro — ${twitterSkipped} skipped`
            : "All feeds already existed"
      )
      router.refresh()
      resetAll()
      setOpen(false)
    } catch (e) {
      if (isAbortError(e)) return
      toast.error("Error saving feeds")
    } finally {
      saveAbortRef.current = null
      setIsSaving(false)
    }
  }

  const backToInput = () => {
    parseAbortRef.current?.abort()
    parseAbortRef.current = null
    setStage("input")
    setFeeds([])
    setReviewFeeds([])
    setError("")
  }

  const saveCountLabel = `${activeReview.length} feed${
    activeReview.length === 1 ? "" : "s"
  } selected`

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-full max-sm:max-w-full max-sm:rounded-none sm:max-h-[85vh] sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 pb-4 pt-6 text-left">
          <DialogTitle>{STAGE_TITLES[stage]}</DialogTitle>
          <DialogDescription>
            {stage === "input" &&
              "Paste links, drop a file, or type — RSS, Telegram, Twitter, YouTube, or website URLs. We'll resolve everything."}
            {stage === "parsing" && "Resolving every source you pasted."}
            {stage === "review" &&
              (activeReview.length > 0 ? (
                <>
                  <MorphText>{activeReview.length}</MorphText>{" "}
                  feed{activeReview.length === 1 ? "" : "s"} found. Remove any you don&apos;t need.
                </>
              ) : (
                "Nothing selected. Go back to add more input."
              ))}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-stable px-6 py-5">
          {stage === "input" && (
            <div className="space-y-4">
              <label htmlFor="bulk-feed-input" className="sr-only">
                Paste feeds — one per line, any format
              </label>
              <textarea
                id="bulk-feed-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                className="w-full resize-none rounded-lg bg-secondary px-4 py-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                placeholder={
                  "Paste your feeds here...\n\nRSS, websites, Telegram, Twitter/X, YouTube — in any format"
                }
              />
              <button
                type="button"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                aria-describedby="bulk-feed-dropzone-hint"
                className="flex w-full flex-col items-center gap-2 rounded-lg bg-secondary py-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              >
                {file ? (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-[16px] w-[16px] text-muted-foreground" />
                    <span>{file.name}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        setFile(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          e.stopPropagation()
                          setFile(null)
                        }
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove file"
                    >
                      <X className="h-[14px] w-[14px]" />
                    </span>
                  </div>
                ) : (
                  <>
                    <Upload className="h-[18px] w-[18px] text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      Upload file
                    </span>
                    <span
                      id="bulk-feed-dropzone-hint"
                      className="text-xs text-muted-foreground"
                    >
                      .txt .json .md .opml — max 5 MB
                    </span>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.json,.md,.opml"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </button>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          {stage === "parsing" && (
            <FeedDiscoveryProgress
              feeds={feeds}
              error={error}
              onComplete={handleDiscoveryComplete}
              onBack={backToInput}
            />
          )}

          {stage === "review" && (
            <div className="space-y-5">
              {overCap && (
                <div
                  className="flex items-start gap-2 rounded-lg bg-destructive-subtle p-4"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-[16px] w-[16px] shrink-0 text-destructive" />
                  <p className="text-sm text-destructive">
                    Too many feeds ({activeReview.length} / {MAX_FEEDS}).
                    Remove at least {activeReview.length - MAX_FEEDS} before
                    saving.
                  </p>
                </div>
              )}
              {nearCap && (
                <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-4">
                  <AlertTriangle className="mt-0.5 h-[16px] w-[16px] shrink-0 text-warning" />
                  <p className="text-sm text-warning">
                    {activeReview.length} of {MAX_FEEDS} — you&apos;re close to
                    the limit. Consider removing some.
                  </p>
                </div>
              )}
              {notFoundCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-4">
                  <AlertTriangle className="mt-0.5 h-[16px] w-[16px] shrink-0 text-warning" />
                  <p className="text-sm text-warning">
                    {notFoundCount} source{notFoundCount === 1 ? "" : "s"}{" "}
                    couldn&apos;t be resolved and {notFoundCount === 1 ? "was" : "were"}{" "}
                    skipped. Paste a direct feed URL and try again if you need{" "}
                    {notFoundCount === 1 ? "it" : "them"}.
                  </p>
                </div>
              )}
              {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No feeds to save. Go back and try different input.
                </p>
              ) : (
                <div className="space-y-8">
                  {groups.map((key) => {
                    const tf = grouped[key]!
                    const GroupIcon = GROUP_ICON[key]
                    return (
                      <div key={key}>
                        <div className="mb-2 flex items-center gap-2">
                          <GroupIcon className="h-[14px] w-[14px] text-muted-foreground" />
                          <h3 className="type-tag text-sm font-medium uppercase tracking-wider text-muted-foreground">
                            {groupLabel(key)}
                          </h3>
                          <span className="text-sm text-muted-foreground">
                            (<span className="type-counter">{tf.length}</span>)
                          </span>
                        </div>
                        <div className="space-y-1">
                          {tf.map((f) => (
                            <div
                              key={f.id}
                              className="group flex items-start gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
                            >
                              <div
                                className={`mt-1.5 h-[8px] w-[8px] shrink-0 rounded-full ${FEED_TYPE_DOT[GROUP_BASE_TYPE[key]]}`}
                              />
                              <div className="min-w-0 flex-1">
                                <span className="text-sm font-medium">
                                  {f.name}
                                </span>
                                <p className="truncate text-xs text-muted-foreground">
                                  {f.url}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeFeed(f.id)}
                                className="-m-2 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-muted-foreground transition-opacity hover:text-destructive focus:opacity-100 max-sm:opacity-60 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                aria-label={`Remove ${f.name}`}
                              >
                                <X className="h-[16px] w-[16px]" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
          {stage === "input" && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isLoading || (!text.trim() && !file)}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-[16px] w-[16px] motion-safe:animate-spin" />
                    Finding feeds...
                  </>
                ) : (
                  "Find feeds"
                )}
              </Button>
            </div>
          )}

          {stage === "parsing" && (
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={backToInput}
                className="text-muted-foreground"
              >
                <ArrowLeft className="mr-1 h-[16px] w-[16px]" />
                Back
              </Button>
              <Button
                variant="ghost"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
            </div>
          )}

          {stage === "review" && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={backToInput}
                className="text-muted-foreground"
              >
                <ArrowLeft className="mr-1 h-[16px] w-[16px]" />
                Back
              </Button>
              <span
                className="hidden text-xs text-muted-foreground sm:inline"
                aria-live="polite"
              >
                {saveCountLabel}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={isSaving || activeReview.length === 0 || overCap}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-[16px] w-[16px] motion-safe:animate-spin" />
                      Saving...
                    </>
                  ) : (
                    // One element: `Button` is `inline-flex gap-2`.
                    <span>
                      Save <MorphText>{activeReview.length}</MorphText>{" "}
                      feed{activeReview.length === 1 ? "" : "s"}
                    </span>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
