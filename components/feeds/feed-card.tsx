"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { CardCover } from "@/components/ui/card-cover"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MorphText } from "@/components/ui/morph-text"
import { XIcon } from "@/components/ui/icons"
import { Pause, Play, Trash2, SlidersHorizontal, Rss, Send, RefreshCw, Sparkles, X, Lock, Youtube } from "lucide-react"
import { toast } from "sonner"
import { detectFlavor, FLAVOR_CONFIGS } from "@/lib/feed-flavor"
import { FLAVOR_ICONS } from "@/components/feeds/flavor-icons"
import { useFeedCover } from "@/components/feeds/use-feed-cover"
import { cn } from "@/lib/utils"
import { readRefusal, refusalCopy, RATE_LIMITED, SIGN_IN_PATH, UNAUTHORIZED, type StreamRefusal } from "@/lib/stream-refusal"
import { followServerRun } from "@/lib/parse-run-follow"
import { formatCheckedAbsolute, formatCheckedRelative } from "@/lib/materials/source-freshness"
import { useNow } from "@/components/materials/source-freshness"

interface FeedCardProps {
  source: {
    id: string
    type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
    url: string
    name: string
    coverUrl?: string | null
    isActive: boolean
    status: "ACTIVE" | "PAUSED" | "ERROR"
    errorMessage?: string | null
    lastParsedAt?: Date | null
    interestQuery?: string | null
    interestCadence?: "HOURLY" | "DAILY" | "WEEKLY" | null
    _count?: {
      materials: number
    }
  }
  // X feed retained on a non-Pro plan: kept + editable, but not parseable.
  locked?: boolean
}

export function FeedCard({ source, locked = false }: FeedCardProps) {
  const router = useRouter()
  const now = useNow()
  // Brand identity is derived on read from the URL — no stored column (RAD-268).
  // Branded feeds keep the RSS tint; the glyph + label carry the brand.
  const flavor = source.type === "RSS" ? detectFlavor(source.url) : null
  const FlavorIcon = flavor ? FLAVOR_ICONS[flavor] : null
  // Band or avatar is read off the image itself, not the feed type: an RSS
  // `<image>` logo is as square as a Telegram channel photo.
  const cover = useFeedCover(source.type, source.coverUrl)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isParsing, setIsParsing] = useState(false)
  const [parsingStatus, setParsingStatus] = useState<string>("")
  const [materialsCreated, setMaterialsCreated] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string>(source.errorMessage ?? "")
  // RAD-326, RAD-406: a refused run is not the feed's error — it gets its own
  // neutral notice, which says why and what gets the user past it.
  const [refusal, setRefusal] = useState<StreamRefusal | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A rate-limit notice names a wait; it leaves when the wait is over.
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // RAD-407: the status follow after a dropped stream, so unmount can end it.
  const followRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setErrorMessage(source.errorMessage ?? "")
  }, [source.errorMessage])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      followRef.current?.abort()
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  async function handleDelete() {
    if (!confirm("Are you sure? This will delete the feed and all associated posts.")) {
      return
    }

    setIsDeleting(true)
    try {
      const response = await fetch(`/api/feeds/${source.id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to delete feed")
      }

      window.dispatchEvent(new Event("radaric:stats-changed"))
      router.refresh()
      toast.success("Feed deleted")
    } catch (error) {
      console.error("Error deleting feed:", error)
      toast.error("Error deleting feed")
      setIsDeleting(false)
    }
  }

  async function handleTogglePause() {
    try {
      const response = await fetch(`/api/feeds/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isActive: !source.isActive,
          status: source.isActive ? "PAUSED" : "ACTIVE",
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to update feed")
      }

      router.refresh()
      toast.success(source.isActive ? "Feed paused" : "Feed activated")
    } catch (error) {
      console.error("Error toggling feed:", error)
      toast.error("Error updating feed")
    }
  }

  /** The run finished cleanly — from its stream, or from the status follow. */
  function finishParse(totalPosts: number) {
    setIsParsing(false)
    setParsingStatus(`Done: ${totalPosts} new posts`)
    router.refresh()
    toast.success(`Parsing complete: ${totalPosts} new posts`)

    // Clear status after 3 seconds
    statusTimerRef.current = setTimeout(() => {
      setParsingStatus("")
      setMaterialsCreated(0)
    }, 3000)
  }

  function failParse(message: string) {
    setIsParsing(false)
    setErrorMessage(message)
    setParsingStatus("Parsing error")
    toast.error(`Error: ${message}`)
  }

  /**
   * The stream is gone but the run is not (RAD-407). Parse runs are
   * server-owned and a proxy can cut this stream, so a drop is
   * followed through `/api/parse-stream/status` — the same loop the posts card
   * uses — until the run settles. Only a run the server has no record of, or a
   * status check that keeps failing, ends in an error.
   */
  function followDroppedRun(runId: string | null) {
    setParsingStatus("Connection lost — still parsing on the server…")
    const controller = new AbortController()
    followRef.current = controller

    void followServerRun({
      signal: controller.signal,
      // The run `parse_start` named; without it only a run seen running counts,
      // so an earlier run kept by the registry is never reported as this one.
      runId,
      onProgress: snapshot => {
        setMaterialsCreated(snapshot.approved + snapshot.filtered)
        setParsingStatus("Still parsing on the server…")
      },
    }).then(result => {
      if (result.outcome === "aborted") return
      followRef.current = null
      if (result.outcome === "unauthorized") {
        // The session ended mid-follow. No refresh: signed out, it would
        // navigate to the sign-in page and take this notice with it.
        showRefusal({ code: UNAUTHORIZED })
        return
      }
      if (result.outcome === "gone") {
        failParse("Lost the connection, and the server has no record of this parse. Refresh to see what arrived.")
        router.refresh()
        return
      }
      const { status, results } = result.snapshot
      const errors = results?.errors ?? []
      if (errors.length > 0) {
        failParse(errors[0])
        router.refresh()
        return
      }
      if (status === "stopped") {
        setIsParsing(false)
        setParsingStatus("")
        setMaterialsCreated(0)
        router.refresh()
        toast.info("Parsing was stopped")
        return
      }
      finishParse((results?.approved ?? 0) + (results?.filtered ?? 0))
    })
  }

  function showRefusal(next: StreamRefusal) {
    setIsParsing(false)
    setParsingStatus("")
    setRefusal(next)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = null
    // A rate limit names a wait, so its notice leaves when the wait is over.
    // Signing in or verifying is not something time fixes; that notice stays.
    if (next.code === RATE_LIMITED) {
      noticeTimerRef.current = setTimeout(() => setRefusal(null), next.retryAfter * 1000)
    }
    toast.warning(refusalCopy(next))
  }

  async function handleParse() {
    setIsParsing(true)
    setMaterialsCreated(0)
    setErrorMessage("")
    setRefusal(null)
    setParsingStatus("Connecting to server...")
    followRef.current?.abort()

    try {
      const eventSource = new EventSource(`/api/parse-stream?sourceIds=${source.id}`)
      eventSourceRef.current = eventSource
      // Set on the stream's last frame. A transport error after it is the
      // connection closing, not a drop — and never a reason to follow the run.
      let ended = false
      // The server's id for this run, from `parse_start` (RAD-407).
      let runId: string | null = null

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          switch (data.type) {
            case "parse_start":
              if (typeof data.runId === "string") runId = data.runId
              break

            case "source_start":
              console.log(`[SSE] Parsing started: ${data.sourceName}`)
              setParsingStatus(`Parsing channel: ${data.sourceName}`)
              break

            case "material_created":
              setMaterialsCreated(prev => {
                const newCount = prev + 1
                setParsingStatus(`Posts processed: ${newCount}`)
                return newCount
              })
              break

            case "parse_complete":
              ended = true
              eventSource?.close()
              // Use actual count from server results, not local state
              finishParse((data.results?.approved || 0) + (data.results?.filtered || 0))
              break

            case "error": {
              ended = true
              eventSource?.close()
              // RAD-326, RAD-406: an in-band refusal — rate limit, ended
              // session, unverified email. Say why and what fixes it, never
              // retry on our own, and leave the feed's own error state alone.
              const refused = readRefusal(data)
              if (refused) {
                showRefusal(refused)
                break
              }
              // Run-level errors send `error`, source-level ones `message`.
              const message = data.message || data.error || "Unknown error"
              console.error("Parsing error:", message)
              failParse(message)
              break
            }
          }
        } catch (error) {
          console.error("Error parsing SSE message:", error)
        }
      }

      eventSource.onerror = (error) => {
        eventSource?.close()
        if (ended) return
        ended = true
        console.error("EventSource error:", error)
        // RAD-407: never abort-on-disconnect, and never call the run lost
        // while the server may still be parsing it.
        followDroppedRun(runId)
      }
    } catch (error) {
      console.error("Error starting parse:", error)
      eventSourceRef.current?.close()
      setIsParsing(false)
      setErrorMessage("Error starting parsing")
      setParsingStatus("Start error")
      toast.error("Error starting parsing")
    }
  }

  async function handleClearError() {
    try {
      const response = await fetch(`/api/feeds/${source.id}/clear-error`, {
        method: "POST",
      })

      if (!response.ok) {
        throw new Error("Failed to clear error")
      }

      setErrorMessage("")
      window.dispatchEvent(new Event("radaric:stats-changed"))
      router.refresh()
    } catch (error) {
      console.error("Error clearing feed error:", error)
      toast.error("Failed to clear error")
    }
  }

  return (
    <Card className="transition-all">
      {cover.shape === "banner" && <CardCover src={cover.src} alt={source.name} />}

      <CardContent className="p-4">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {cover.probe}
            {cover.shape === "avatar" && (
              <img
                data-feed-avatar
                ref={cover.ref}
                src={cover.src}
                alt={source.name}
                onError={cover.onError}
                className={cn(
                  "h-10 w-10 rounded-full flex-shrink-0",
                  // A logo that is not square keeps its edges inside the circle.
                  cover.square ? "object-cover" : "object-contain bg-muted"
                )}
              />
            )}
            <h3 className="font-semibold leading-snug">{source.name}</h3>
          </div>
          <p
            className="text-sm text-muted-foreground line-clamp-8 break-all"
            title={(source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && source.interestQuery
              ? source.interestQuery
              : source.url}
          >
            {(source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && source.interestQuery
              ? source.interestQuery
              : source.url}
          </p>
        </div>

        {/* Parsing Status */}
        {isParsing && parsingStatus && (
          <div className="mt-3 rounded-md bg-info-subtle p-3 transition-all duration-200">
            <div className="flex items-center gap-2 text-sm">
              <RefreshCw className="h-[16px] w-[16px] animate-spin text-info" />
              <span className="font-medium text-foreground">
                {parsingStatus}
              </span>
              {materialsCreated > 0 && (
                <Badge variant="info" className="ml-auto">
                  {/* One flex item: `gap` would detach the sign from its number. */}
                  <span className="type-counter">
                    +<MorphText timing="fast" coalesceMs={120}>{materialsCreated}</MorphText>
                  </span>
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Error Message */}
        {errorMessage && !isParsing && (
          <div className="mt-3 rounded-md bg-destructive-subtle p-3 transition-all duration-200" role="alert">
            <div className="flex items-start gap-2">
              <p className="text-sm text-foreground flex-1">
                <span className="font-medium">Error:</span> {errorMessage}
              </p>
              <button
                onClick={handleClearError}
                className="flex-shrink-0 p-0.5 rounded text-destructive/60 hover:text-destructive hover:bg-destructive-subtle/70 transition-colors"
                aria-label="Dismiss error"
              >
                <X className="h-[16px] w-[16px]" />
              </button>
            </div>
          </div>
        )}

        {/* Refused (RAD-326, RAD-406) — neutral: the feed is fine; the request
            was early, the session ended, or the email is not verified yet. */}
        {/* The live region stays mounted and only its content changes: a
            region inserted with its text already inside is not announced by
            many screen readers. */}
        <div role="status">
          {refusal && !isParsing && (
            <div className="mt-3 rounded-md bg-muted p-3 transition-all duration-200">
              <p className="text-sm text-foreground">{refusalCopy(refusal)}</p>
              {refusal.code === UNAUTHORIZED && (
                <Link href={SIGN_IN_PATH} className="mt-1 inline-block text-sm font-medium link">
                  Sign in
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Success Status (temporary) */}
        {!isParsing && parsingStatus && parsingStatus.startsWith("Done") && (
          <div className="mt-3 rounded-md bg-primary-subtle p-3 transition-all duration-200">
            <p className="text-sm text-foreground font-medium">
              ✓ {parsingStatus}
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              source.type === "RSS"
                ? "bg-[#f76b15]/15 text-[#f76b15]"
                : source.type === "TELEGRAM"
                  ? "bg-[#0090ff]/15 text-[#0090ff]"
                  : source.type === "TWITTER"
                    ? "bg-foreground/10 text-foreground"
                    : source.type === "YOUTUBE"
                      // Token idiom (not brand #FF0000 text — fails AA on white);
                      // soft wash + glyph keeps it distinct from the destructive
                      // Error badge beside it.
                      ? "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-400"
                      : "bg-[#8e4ec6]/15 text-[#8e4ec6]"
            }
          >
            {source.type === "RSS" &&
              (FlavorIcon ? (
                <FlavorIcon className="mr-1 h-[14px] w-[14px]" />
              ) : (
                <Rss className="mr-1 h-[14px] w-[14px]" />
              ))}
            {source.type === "TELEGRAM" && <Send className="mr-1 h-[14px] w-[14px]" />}
            {source.type === "TWITTER" && <XIcon className="mr-1 h-[14px] w-[14px]" />}
            {source.type === "YOUTUBE" && <Youtube className="mr-1 h-[14px] w-[14px]" />}
            {(source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && <Sparkles className="mr-1 h-[14px] w-[14px]" />}
            {source.type === "RSS" && (flavor ? FLAVOR_CONFIGS[flavor].label : "RSS")}
            {source.type === "TELEGRAM" && "TG"}
            {source.type === "TWITTER" && "X"}
            {source.type === "YOUTUBE" && "YouTube"}
            {(source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && "Event Trigger"}
          </Badge>

          {locked && (
            <Badge variant="secondary" className="gap-1">
              <Lock className="h-[14px] w-[14px]" />
              Locked · Pro
            </Badge>
          )}

          {source.status === "PAUSED" && (
            <Badge variant="secondary">Paused</Badge>
          )}

          {source.status === "ERROR" && errorMessage && (
            <Badge variant="destructive">Error</Badge>
          )}

          {(source.type === "INTEREST" || source.type === "EVENT_TRIGGER") && source.interestCadence && (
            <Badge variant="secondary">
              {source.interestCadence === "HOURLY" && "Hourly"}
              {source.interestCadence === "DAILY" && "Daily"}
              {source.interestCadence === "WEEKLY" && "Weekly"}
            </Badge>
          )}

          {source._count && (
            <Badge variant="secondary">
              <span>
                <MorphText>{source._count.materials}</MorphText> posts
              </span>
            </Badge>
          )}

          {source.lastParsedAt && (
            // RAD-424: relative text with the absolute timestamp as its label. The
            // server and the browser may differ in clock and locale, so the text
            // is excused from hydration comparison rather than gated on mount
            // (which would pop the badge in).
            <Badge
              variant="outline"
              className="text-xs"
              // Set only once mounted: the card is server-rendered and React never
              // patches attributes on hydration, so a server-built title would keep
              // Railway's timezone and locale.
              title={now ? `Last checked ${formatCheckedAbsolute(new Date(source.lastParsedAt))}` : undefined}
            >
              <RefreshCw className="mr-1 h-[14px] w-[14px]" aria-hidden="true" />
              <span suppressHydrationWarning>
                Checked {formatCheckedRelative(new Date(source.lastParsedAt), now ?? new Date())}
              </span>
            </Badge>
          )}
        </div>

        {locked && (
          <p className="mt-3 text-xs text-muted-foreground">
            X parsing needs Radaric Pro.{" "}
            <Link
              href="/settings/billing"
              className="font-medium link"
            >
              Upgrade
            </Link>
          </p>
        )}
      </CardContent>

      <CardFooter className="bg-muted/50 p-0 flex-col">
        <Link
          href={`/feeds/${source.id}/edit`}
          className="flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <SlidersHorizontal className="h-[14px] w-[14px]" />
          Edit Feed & Rules
        </Link>
        <div className="grid grid-cols-3 w-full">
          <button
            onClick={locked ? () => router.push("/settings/billing") : handleParse}
            disabled={isParsing || isDeleting}
            title={locked ? "Upgrade to Pro to parse X accounts" : isParsing ? "Parsing..." : "Run parsing"}
            aria-label={locked ? "Upgrade to Pro to parse X accounts" : isParsing ? "Parsing..." : "Run parsing"}
            className="flex items-center justify-center py-2.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {locked ? (
              <Lock className="h-[16px] w-[16px]" />
            ) : (
              <RefreshCw className={`h-[16px] w-[16px] ${isParsing ? "animate-spin" : ""}`} />
            )}
          </button>

          <button
            onClick={handleTogglePause}
            disabled={isParsing || isDeleting}
            title={source.isActive ? "Pause" : "Activate"}
            aria-label={source.isActive ? "Pause" : "Activate"}
            className="flex items-center justify-center py-2.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {source.isActive ? (
              <Pause className="h-[16px] w-[16px]" />
            ) : (
              <Play className="h-[16px] w-[16px]" />
            )}
          </button>

          <button
            onClick={handleDelete}
            disabled={isDeleting || isParsing}
            title="Delete"
            aria-label="Delete"
            className="flex items-center justify-center py-2.5 text-muted-foreground hover:text-destructive hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <Trash2 className="h-[16px] w-[16px]" />
          </button>
        </div>
      </CardFooter>
    </Card>
  )
}
