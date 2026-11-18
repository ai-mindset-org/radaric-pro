"use client"

import { useState, useRef, useEffect, memo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { CardCover } from "@/components/ui/card-cover"
import { cardGalleryImages, coverHasVideo } from "@/lib/media-urls"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ExternalLink, Send, Trash2, Archive, ArchiveRestore, CheckCircle, Layers, ChevronDown, Loader2, Play } from "lucide-react"
import { format } from "date-fns"
import { enUS } from "date-fns/locale"
import { DeleteMaterialDialog } from "./delete-material-dialog"
import {
  convertTelegramEntitiesToReact,
  adjustEntitiesForExcerpt,
  shiftContentEntities,
} from "@/lib/telegram-entities-to-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { isHtml } from "@/lib/html-utils"
import { isAuxNewTab, isNewTabClick } from "@/lib/peek/click"
import { stripHtml } from "@/lib/sanitize"
import { splitDerivedBody } from "@/lib/title"
import { MaterialTitle } from "./material-title"
import { MaterialFeedbackButtons } from "./material-feedback-buttons"

interface MaterialCardProps {
  material: {
    id: string
    title: string
    url: string
    content: string
    contentEntities?: Array<{ className: string; offset: number; length: number; url?: string }> | null
    publishedAt: Date | null
    thumbnailUrl?: string | null
    mediaUrls?: string[] | null
    aiEvaluation: "APPROVED" | "FILTERED"
    aiConfidence: number
    userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
    feed: {
      id: string
      name: string
      type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
    }
    feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
    /** Present (non-empty) when the current user has saved this material. */
    savedItems?: Array<{ id: string }>
  }
  // Story mode (optional)
  story?: {
    id: string
    title: string
    summary: string
    rubrics: string[]
    sourceUrls: string[]
    status: string
    version: number
    createdAt: string
  }
  storyMaterials?: Array<{
    id: string
    title: string
    url: string
    feed: { id: string; name: string; type: string }
    publishedAt: Date | null
    createdAt: string
    userStatus?: string
  }>
  sourceCount?: number
  isWide?: boolean
  /**
   * The cover band, decided by the caller — a story cell passes the frames of
   * every loaded member post (`storyGalleryImages`) and whether its cover
   * frame's owner carries a video. Absent → the card derives both from its own
   * `material`, as every post card does. `images: []` means no band at all.
   */
  cover?: { images: string[]; hasVideo: boolean }
  /**
   * Present when the list opens details in the side peek (drawer mode). Plain
   * clicks then open the peek instead of navigating, and the element that was
   * clicked is handed back so focus can return to it when the peek closes.
   * Modified clicks (cmd/ctrl/shift/alt, middle) keep opening the canonical
   * page in a new tab in both modes.
   */
  onOpen?: (kind: "post" | "story", id: string, origin: HTMLElement | null) => void
  onStoryFeedback?: (feedbackType: "LIKE" | "DISLIKE") => Promise<void>
  // The return value is deliberately loose: the list's batch handlers report
  // success (`false` = rolled back) so an open peek can stay open on a failure.
  onSendToNotion?: (id: string) => Promise<unknown> | unknown
  onDelete?: (id: string, feedback?: { sourceFeedback?: string; globalFeedback?: string }) => Promise<unknown> | unknown
  onArchive?: (id: string) => Promise<unknown> | unknown
  onRestore?: (id: string) => Promise<unknown> | unknown
  /** Called after the user unsaves this material (used by the Library to refresh). */
  onUnsave?: () => void
  /** Hide the Save toggle — used for auto-collected sources the user didn't save. */
  hideSave?: boolean
}

function MaterialCardImpl({
  material,
  story,
  storyMaterials,
  sourceCount = 0,
  isWide = false,
  cover,
  onOpen,
  onStoryFeedback,
  onSendToNotion,
  onDelete,
  onArchive,
  onRestore,
}: MaterialCardProps) {
  const router = useRouter()
  const [isSendingToNotion, setIsSendingToNotion] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [showAllMaterials, setShowAllMaterials] = useState(false)
  const archiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current)
    }
  }, [])

  const isStory = !!story
  const displayTitle = story ? story.title : material.title

  // Derive from props — parent handles optimistic updates
  const sentToNotion = material.userStatus === "SENT_TO_NOTION" || story?.status === "SENT_TO_NOTION"

  const showRestore = isStory
    ? (storyMaterials ?? []).length > 0 && (storyMaterials ?? []).every(m => m.userStatus === "ARCHIVED")
    : material.userStatus === "ARCHIVED"

  async function handleSendToNotion(e: React.MouseEvent) {
    e.stopPropagation()
    if (!onSendToNotion || isProcessing) return

    setIsSendingToNotion(true)
    setIsProcessing(true)
    try {
      const id = story ? story.id : material.id
      await onSendToNotion(id)
    } catch (error) {
      console.error("MaterialCard: send to Notion failed", error)
    } finally {
      setIsSendingToNotion(false)
      setIsProcessing(false)
    }
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (isProcessing) return
    setDeleteDialogOpen(true)
  }

  async function handleDeleteConfirm(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    if (onDelete) {
      setIsProcessing(true)
      try {
        await onDelete(material.id, feedback)
      } finally {
        setIsProcessing(false)
      }
    }
  }

  async function handleArchive(e: React.MouseEvent) {
    e.stopPropagation()
    if (!material.id || !onArchive || isProcessing) return
    setIsProcessing(true)
    try {
      await onArchive(material.id)
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleRestore(e: React.MouseEvent) {
    e.stopPropagation()
    if (!material.id || !onRestore || isProcessing) return
    setIsProcessing(true)
    try {
      await onRestore(material.id)
    } finally {
      setIsProcessing(false)
    }
  }

  function handleFeedbackSubmitted(feedbackType: "LIKE" | "DISLIKE") {
    // Propagate feedback to story materials (primary material is handled by MaterialFeedbackButtons)
    if (onStoryFeedback) {
      onStoryFeedback(feedbackType)
    }

    if (feedbackType === "DISLIKE" && onArchive) {
      setIsArchiving(true)
      archiveTimerRef.current = setTimeout(async () => {
        try {
          await onArchive(material.id)
        } catch {
          setIsArchiving(false)
        }
      }, 450)
    }
  }

  /** The canonical page for this card — what a new-tab click opens. */
  const canonicalHref = story ? `/stories/${story.id}` : `/posts/${material.id}`

  function openInNewTab() {
    // `noopener,noreferrer`: a same-origin page could otherwise reach back
    // through `window.opener`.
    window.open(canonicalHref, "_blank", "noopener,noreferrer")
  }

  function handleCardClick(e: React.MouseEvent) {
    // A card on its way out is inert: AnimatedGrid pins it with pointer-events:none.
    if (isArchiving) return
    if (isNewTabClick(e)) {
      e.preventDefault()
      openInNewTab()
      return
    }
    if (onOpen) {
      onOpen(story ? "story" : "post", story ? story.id : material.id, e.currentTarget as HTMLElement)
      return
    }
    router.push(canonicalHref)
  }

  /**
   * Middle click does not fire `click` in any browser — it fires `auxclick`.
   */
  function handleCardAuxClick(e: React.MouseEvent) {
    if (!isAuxNewTab(e)) return
    // A middle click that lands on a nested link is that link's own new-tab
    // gesture — let the browser open its href rather than hijacking it for
    // the card's canonical page.
    const link = (e.target as HTMLElement).closest?.("a[href]")
    if (link && e.currentTarget.contains(link)) return
    e.preventDefault()
    openInNewTab()
  }

  /**
   * Keyboard activation. `Card` already exposes `role="button" tabIndex={0}`
   * when interactive, but nothing listened for Enter/Space, so a keyboard user
   * could focus a card and never open it. Guarded to the card itself: key
   * events from the nested utility buttons (archive, delete, send) bubble and
   * must not also activate the card.
   */
  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget) return
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    if (onOpen) {
      onOpen(story ? "story" : "post", story ? story.id : material.id, e.currentTarget as HTMLElement)
      return
    }
    router.push(canonicalHref)
  }

  function handleShowMore(e: React.MouseEvent) {
    e.stopPropagation()
    setShowAllMaterials(true)
  }

  const excerptLength = 600
  // Telegram entities index the raw message text and only the Telegram worker
  // writes them, so entities and HTML content never coexist: strip HTML only
  // when there is nothing to keep offset-aligned.
  const hasTelegramEntities = !!(material.contentEntities && material.contentEntities.length > 0)
  const cleanContent =
    !hasTelegramEntities && isHtml(material.content) ? stripHtml(material.content) : material.content
  // Never repeat a derived headline at the top of the excerpt — excerpt only
  // what follows it. `cutLength` re-bases Telegram entity offsets (which are
  // relative to the FULL content) onto that shorter remainder.
  const excerptSource = isStory ? cleanContent : splitDerivedBody(material.title, cleanContent)
  const cutLength = cleanContent.length - excerptSource.length
  const excerpt = excerptSource.slice(0, excerptLength) + (excerptSource.length > excerptLength ? "..." : "")

  const excerptEntities =
    material.contentEntities && material.contentEntities.length > 0
      ? adjustEntitiesForExcerpt(shiftContentEntities(material.contentEntities, cutLength), excerptLength)
      : null

  // One function decides both whether there is a cover and what it is. Gating
  // on `thumbnailUrl` instead would render the band for a thumbnail that is a
  // video embed or a `tg://` placeholder — unrenderable — while a perfectly
  // good image sat unused in `mediaUrls`, and would hide the band entirely for
  // a material that has media but no thumbnail.
  //
  // A story cell hands its cover in (`cover`, RAD-399): the gallery then spans
  // every member post and the badge follows the cover frame's owner, so neither
  // may be re-derived from `material` — the primary alone.
  const galleryImages = cover ? cover.images : cardGalleryImages(material)
  const showVideoBadge = cover ? cover.hasVideo : coverHasVideo(material)

  const showInStoriesBadge = material.userStatus === "SENT_TO_STORIES"
  const showInNotionBadge = sentToNotion || material.userStatus === "SENT_TO_NOTION"

  // Story materials list
  const MAX_VISIBLE = 3
  const visibleMaterials = showAllMaterials
    ? (storyMaterials ?? [])
    : (storyMaterials ?? []).slice(0, MAX_VISIBLE)
  const hiddenCount = (storyMaterials?.length ?? 0) - MAX_VISIBLE

  return (
    <Card
      interactive
      className="transition-colors duration-150"
      onClick={handleCardClick}
      onAuxClick={handleCardAuxClick}
      onKeyDown={handleCardKeyDown}
    >
      {/* Cover — uncropped, and a hover-scrub gallery when the post carries
          more than one image. See CardCover / HoverGallery. */}
      {galleryImages.length > 0 && (
        <CardCover
          src={galleryImages[0]}
          alt={displayTitle || "Post image"}
          images={galleryImages}
          badge={
            showVideoBadge ? (
              <Play className="h-[16px] w-[16px] fill-current" aria-hidden="true" />
            ) : undefined
          }
        />
      )}

      <CardContent className="p-4 space-y-3 overflow-hidden">
        {/* Header: AI status dot + confidence */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn(
              "h-2 w-2 rounded-full shrink-0",
              material.aiEvaluation === "APPROVED" ? "bg-green-bright" : "bg-destructive"
            )} />
            <span className="text-xs text-muted-foreground">
              {material.aiEvaluation === "APPROVED" ? "Approved" : "Filtered"}
            </span>
          </div>

          <span className="text-xs text-muted-foreground type-counter">
            {material.aiConfidence}%
          </span>
        </div>

        {/* Source count badge + rubrics (story only) */}
        {isStory && (
          <div className="flex items-center gap-2 flex-wrap">
            {sourceCount > 1 && (
              <Badge variant="secondary">
                <Layers className="h-[14px] w-[14px] mr-1" />
                <span><span className="type-counter">{sourceCount}</span> sources</span>
              </Badge>
            )}
            {story.rubrics.map((r) => (
              <Badge key={r} variant="outline" className="text-xs">
                {r}
              </Badge>
            ))}
          </div>
        )}

        {/* Title — a derived headline keeps the lede's own link. */}
        <h3 className={cn(
          "font-semibold leading-snug line-clamp-8",
          isWide && "text-lg sm:text-xl"
        )}>
          {isStory ? (
            displayTitle
          ) : (
            <MaterialTitle
              title={material.title}
              content={material.content}
              contentEntities={material.contentEntities}
            />
          )}
        </h3>

        {/* Source + date */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link
            href={`/feeds/${material.feed.id}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:text-foreground hover:underline transition-colors"
          >
            {material.feed.name}
          </Link>
          <span>·</span>
          {material.publishedAt && (
            <span suppressHydrationWarning>{format(new Date(material.publishedAt), "d MMM yyyy", { locale: enUS })}</span>
          )}
        </div>

        {/* Excerpt / Summary — omitted entirely when a derived headline
            already said everything the post has (nothing follows it). */}
        {(isStory || excerpt.length > 0) && (
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-6">
            {isStory
              ? story.summary
              : excerptEntities && excerptEntities.length > 0
                ? convertTelegramEntitiesToReact(excerpt, excerptEntities, "compact")
                : excerpt}
          </p>
        )}

        {/* Expandable materials list (story only) */}
        {isStory && storyMaterials && storyMaterials.length > 0 && (
          <div className="space-y-1 pt-3">
            {visibleMaterials.map((m) => (
              <MaterialRow key={m.id} material={m} />
            ))}
            {!showAllMaterials && hiddenCount > 0 && (
              <button
                onClick={handleShowMore}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-2 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-sm"
              >
                <ChevronDown className="h-[14px] w-[14px]" />
                Show {hiddenCount} more
              </button>
            )}
          </div>
        )}

        {/* Status badges */}
        {(showInNotionBadge || showInStoriesBadge || showRestore || material.userStatus === "READ") && (
          <div className="flex items-center gap-2 flex-wrap">
            {showInNotionBadge && (
              <Badge variant="outline" size="sm">In Notion</Badge>
            )}
            {!isStory && showInStoriesBadge && (
              <Badge variant="outline" size="sm">
                <CheckCircle className="mr-1 h-[12px] w-[12px]" />
                In Stories
              </Badge>
            )}
            {showRestore && (
              <Badge variant="subtle" size="sm">Archived</Badge>
            )}
            {material.userStatus === "READ" && (
              <Badge variant="subtle" size="sm">Read</Badge>
            )}
          </div>
        )}

        {/* Actions: feedback signals (focal) + quiet icon utilities */}
        <div className="flex items-center gap-1 pt-3 flex-wrap">
          {/* Signals — pulled toward the content grid (-ml-2 keeps breathing room in p-4). */}
          <MaterialFeedbackButtons
            className="-ml-2"
            materialId={material.id}
            existingFeedback={material.feedbacks?.[0] ?? null}
            onFeedbackSubmitted={handleFeedbackSubmitted}
            compact
          />

          {/* Utilities — quiet, icon-only, pushed right. */}
          <div className="ml-auto flex items-center gap-1">
            {!isStory && (
              <Button variant="ghost" size="icon" asChild aria-label="Open original" title="Open original">
                <a
                  href={material.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-[16px] w-[16px]" />
                </a>
              </Button>
            )}

            {onSendToNotion && !sentToNotion && !showInNotionBadge && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSendToNotion}
                disabled={isSendingToNotion || isProcessing}
                aria-label="Send to Notion"
                title="Send to Notion"
              >
                {isSendingToNotion ? (
                  <Loader2 className="h-[16px] w-[16px] animate-spin" />
                ) : (
                  <Send className="h-[16px] w-[16px]" />
                )}
              </Button>
            )}

            {(onArchive || onRestore) &&
              (showRestore ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleRestore}
                  disabled={isProcessing}
                  aria-label={isStory ? "Restore all" : "Restore"}
                  title={isStory ? "Restore all" : "Restore"}
                >
                  <ArchiveRestore className="h-[16px] w-[16px]" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleArchive}
                  disabled={isProcessing}
                  aria-label={isStory ? "Archive all" : "Archive"}
                  title={isStory ? "Archive all" : "Archive"}
                >
                  <Archive className="h-[16px] w-[16px]" />
                </Button>
              ))}

            {onDelete && (
              <Button
                size="icon"
                variant="ghost"
                onClick={handleDelete}
                disabled={isProcessing}
                className="ml-2 hover:text-destructive hover:bg-destructive-subtle"
                aria-label={isStory ? "Delete all" : "Delete"}
                title={isStory ? "Delete all" : "Delete"}
              >
                <Trash2 className="h-[16px] w-[16px]" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      <DeleteMaterialDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        materialTitle={displayTitle}
        isStory={isStory}
      />
    </Card>
  )
}

function MaterialRow({
  material,
}: {
  material: {
    id: string
    title: string
    url: string
    feed: { id: string; name: string; type: string }
    publishedAt: Date | null
    createdAt: string
  }
}) {
  return (
    <div className="flex items-center gap-3 py-2 text-sm min-h-[44px]">
      <div className="flex-1 min-w-0">
        <a
          href={material.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium truncate block hover:text-primary transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {material.title}
        </a>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          <span>{material.feed.name}</span>
          {material.publishedAt && (
            <>
              <span>·</span>
              <span suppressHydrationWarning>{format(new Date(material.publishedAt), "d MMM yyyy", { locale: enUS })}</span>
            </>
          )}
        </div>
      </div>
      <a
        href={material.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-2 -m-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
        aria-label="Open original"
      >
        <ExternalLink className="h-[14px] w-[14px]" />
      </a>
    </div>
  )
}

/**
 * Memoised because `MaterialsList` re-renders once per streamed material during
 * a parse, and without this every mounted card re-renders with it — 45 cards
 * re-rendered to insert one.
 *
 * The memo only holds while the props are referentially stable, which is true
 * for a plain post card (`material` comes straight out of state; the four
 * handlers are `useCallback`-stable in `MaterialsList`) and deliberately NOT
 * true for a story cell, whose `storyMaterials` array and per-story callbacks
 * are rebuilt each render. Stories are a small minority of cells; closing that
 * case means keying the callbacks per story, which is a separate change.
 *
 * Nor does it hold for `SavedMaterialsGrid`'s manually-saved branch, which
 * spreads `material` to inject `savedItems` and passes an inline `onUnsave`
 * (its `autoCollected` branch passes `material` straight through and does
 * hold). That grid re-renders rarely, so the failed compare costs nothing.
 */
export const MaterialCard = memo(MaterialCardImpl)
