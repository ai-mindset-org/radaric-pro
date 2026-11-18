"use client"

/**
 * A material's reading body (RAD-345) — the part `/posts/[id]` and the side
 * peek have in common: status row, headline, byline, action rail, media,
 * select-to-save body, AI reasoning.
 *
 * Extracted from `MaterialDetailPage` when the peek was built, so the page and
 * the peek cannot drift apart. The **page shell stays with the page**
 * (`ReadingShell`'s sticky back bar and card chrome) and the **handlers stay
 * with the owner** (the page owns its own fetch-and-navigate handlers; the peek
 * passes the list's optimistic ones) — this component only decides where the
 * pixels go, and takes `actions` as a prop for that reason.
 *
 * `variant` is a layout contract, not a padding tweak:
 *   - `page` — inside `ReadingShell`: the hero bleeds to the shell's edges and
 *     the media gallery can take two columns on a wide card.
 *   - `peek` — inside the panel: no card chrome (the panel is the card), the
 *     hero is capped to a band so the headline stays on the first screen and is
 *     never the browser's highest-priority fetch, and every column decision
 *     reads the PANEL's width (`@container`), not the viewport's — a `sm:`
 *     breakpoint would fire in a 400px panel on a 1440px screen.
 */

import { ExternalLink, Archive, ArchiveRestore, Sparkles } from "lucide-react"
import { format } from "date-fns"
import { enUS } from "date-fns/locale"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  convertTelegramEntitiesToReact,
  shiftContentEntities,
  type TelegramEntity,
} from "@/lib/telegram-entities-to-react"
import { MaterialFeedbackButtons } from "./material-feedback-buttons"
import { MaterialMedia } from "./material-media"
import { MaterialTitle } from "./material-title"
import { ExcerptSaver } from "./excerpt-saver"
import { isHtml } from "@/lib/html-utils"
import { sanitizeHtml, stripHtml } from "@/lib/sanitize"
import { isDerivedTitle, splitDerivedBody, splitDerivedBodyHtml } from "@/lib/title"
import { coverIsVideoPoster, detailGalleryMedia, mediaKindFromUrl, previewImageUrl, sameImageKey } from "@/lib/media-urls"
import {
  ActionRail,
  ReadingHero,
  ReadingTitle,
  SectionLabel,
} from "@/components/reading/reading-layout"
import { ReadingActions, type ReadingAction } from "@/components/reading/reading-actions"

export interface MaterialArticleMaterial {
  id: string
  title: string
  url: string
  content: string
  contentEntities?: TelegramEntity[] | null
  publishedAt: Date | null
  thumbnailUrl?: string | null
  mediaUrls?: string[]
  aiEvaluation: "APPROVED" | "FILTERED"
  aiConfidence: number
  aiReasoning: string | null
  userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
  feed: {
    id: string
    name: string
    type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
  }
  feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
}

export function MaterialArticle({
  material,
  actions,
  variant = "page",
}: {
  material: MaterialArticleMaterial
  actions: ReadingAction[]
  variant?: "page" | "peek"
}) {
  const isPeek = variant === "peek"

  // Real images, embeds and Telegram placeholders — minus the cover the hero
  // already shows. See `detailGalleryMedia` for what gets dropped and why.
  // When the cover is not a paint-able image (a legacy `.mp4` thumbnail), the
  // hero falls back to the first real image and the gallery must not repeat it.
  const heroSrc = previewImageUrl(material)
  const heroKey = heroSrc ? sameImageKey(heroSrc) : null
  const keptMedia = detailGalleryMedia(material).filter(
    (url) => heroKey === null || sameImageKey(url) !== heroKey
  )
  // The cover is a video's poster only on a Telegram post whose own thumbnail
  // is not one of its frames (the mirror's `_thumb.jpg`). Any other cover — an
  // RSS og:image, an album's photo — is an editorial image, not a video frame.
  // Shared with the story page's grid (RAD-400).
  const coverIsPoster = coverIsVideoPoster(material)
  // A post whose only media is one video plays it in the hero — otherwise its
  // poster paints as the hero and again as the player's first frame right
  // under it. An editorial cover keeps the hero; the video stays below.
  const heroVideoUrl =
    keptMedia.length === 1 &&
    mediaKindFromUrl(keptMedia[0]) === "video" &&
    (heroSrc === null || coverIsPoster)
      ? keptMedia[0]
      : null
  const galleryMedia = heroVideoUrl ? [] : keptMedia
  // The poster maps to the first playable entry (the parser emits one poster
  // per message, and the first video is the one it belongs to in practice).
  const firstVideoUrl = coverIsPoster
    ? galleryMedia.find((url) => mediaKindFromUrl(url) === "video") ?? null
    : null

  const isArchived = material.userStatus === "ARCHIVED"
  const isHtmlContent = isHtml(material.content)
  // A derived lede title is already the opening of `content` — the card shows
  // it as a headline and cuts it out of the excerpt (splitDerivedBody). The
  // reading page shows the same headline and must cut the same words out of
  // the body, or the opening sentence prints twice. Compare against the same
  // plain text the card uses, so an HTML body (RSS) is recognized too.
  const plainContent = isHtmlContent ? stripHtml(material.content) : material.content
  const hasDerivedTitle = isDerivedTitle(material.title, plainContent)

  let bodyContent = material.content
  let bodyEntities = material.contentEntities ?? null
  if (hasDerivedTitle) {
    if (isHtmlContent) {
      bodyContent = splitDerivedBodyHtml(material.title, material.content, plainContent)
    } else {
      bodyContent = splitDerivedBody(material.title, material.content)
      // Telegram entity offsets are relative to the FULL content; re-base them
      // onto the remainder (see shiftContentEntities).
      const cut = material.content.length - bodyContent.length
      if (cut > 0 && bodyEntities && bodyEntities.length > 0) {
        bodyEntities = shiftContentEntities(bodyEntities, cut)
      }
    }
  }

  // Uncropped, like the card cover: the hero shows the whole image and the
  // band takes its height. The cap is viewport-relative so a portrait cover
  // can't push the headline off the first screen; only past it does
  // `object-contain` letterbox instead of crop. The peek caps it tighter —
  // the panel is shorter, and the headline must survive the image — but the
  // hero's box is the page's: it bleeds to the column's edge on mobile and
  // cancels the card inset from `sm` up, exactly like `ReadingHero`.
  const heroClassName = cn(
    "w-full h-auto object-contain",
    isPeek ? "max-h-[40svh]" : "max-h-[60svh] sm:max-h-[80svh]"
  )

  const heroImage = heroVideoUrl ? (
    <video
      src={heroVideoUrl}
      poster={heroSrc ?? undefined}
      controls
      playsInline
      preload="metadata"
      className={cn("block", heroClassName)}
    />
  ) : heroSrc ? (
    <img
      src={heroSrc}
      alt={material.title}
      loading="eager"
      fetchPriority={isPeek ? undefined : "high"}
      className={heroClassName}
      onError={(e) => {
        const p = e.currentTarget.parentElement
        if (p) p.style.display = "none"
      }}
    />
  ) : null

  return (
    // `@container`: the gallery and the story rows inside this body size
    // themselves off the ARTICLE's width, so the same markup works in an 850px
    // page card and a 400px peek panel.
    <div className="@container">
      {/* Hero cover — full-bleed on mobile, clipped by the card from sm up; in
          the peek the same wrapper bleeds it to the (cardless) column's edge. */}
      {heroImage && <ReadingHero>{heroImage}</ReadingHero>}

      <div className={heroImage ? "mt-6" : "mt-4 sm:mt-0"}>
        {/* Status row — dot + verdict left, confidence right. `min-w-0` +
            wrapping badges so a long status set never pushes the number off. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap min-w-0">
            <span className="flex items-center gap-2 shrink-0">
              <span className={cn(
                "h-2 w-2 rounded-full shrink-0",
                material.aiEvaluation === "APPROVED" ? "bg-green-bright" : "bg-destructive"
              )} />
              <span className="text-[0.8125rem] sm:text-sm font-medium text-muted-foreground">
                {material.aiEvaluation === "APPROVED" ? "Approved" : "Filtered"}
              </span>
            </span>

            {material.userStatus === "SENT_TO_NOTION" && (
              <Badge variant="outline" size="sm">In Notion</Badge>
            )}

            {material.userStatus === "SENT_TO_STORIES" && (
              <Badge variant="outline" size="sm">In Stories</Badge>
            )}

            {isArchived && (
              <Badge variant="subtle" size="sm">Archived</Badge>
            )}
          </div>

          <span className="text-[0.8125rem] sm:text-sm font-medium text-muted-foreground type-counter shrink-0">
            {material.aiConfidence}%
          </span>
        </div>

        {/* The same headline the card shows, derived or authored: the two
            surfaces must not disagree about a post's title — including the
            lede's own link, which `MaterialTitle` re-maps onto a derived
            headline (RAD-337; links only, RAD-365). A derived one is followed
            by the body *after* it (bodyContent above). */}
        <div className="mt-2.5 sm:mt-3">
          <ReadingTitle>
            <MaterialTitle
              title={material.title}
              content={material.content}
              contentEntities={material.contentEntities}
            />
          </ReadingTitle>
        </div>

        {/* Byline — sits tight under the headline so the two read as one unit. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] sm:text-sm text-muted-foreground">
          <Link
            href={`/feeds/${material.feed.id}`}
            className="font-medium text-foreground/80 hover:text-foreground hover:underline transition-colors"
          >
            {material.feed.name}
          </Link>
          {material.publishedAt && (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={new Date(material.publishedAt).toISOString()}>
                {format(new Date(material.publishedAt), "d MMMM yyyy, HH:mm", {
                  locale: enUS,
                })}
              </time>
            </>
          )}
        </div>

        <ActionRail>
          <MaterialFeedbackButtons
            compact
            materialId={material.id}
            existingFeedback={material.feedbacks?.[0] ?? null}
          />
          <ReadingActions actions={actions} />
        </ActionRail>
      </div>

      {/* Media Gallery */}
      {galleryMedia.length > 0 && (
        <div className="mt-7 space-y-3">
          <SectionLabel>Media ({galleryMedia.length})</SectionLabel>
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3 @sm:gap-4">
            {galleryMedia.map((mediaUrl, index) => (
              <div key={mediaUrl} className="relative rounded-lg overflow-hidden">
                <MaterialMedia
                  url={mediaUrl}
                  alt={`Media ${index + 1}`}
                  title={`Video ${index + 1}`}
                  poster={mediaUrl === firstVideoUrl ? heroSrc ?? undefined : undefined}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content — select any passage to save it as a citation.
          17px/1.65 on mobile: with the card frame gone the measure is wide
          enough to carry reading-size type, which 14px `prose-sm` was not. */}
      <ExcerptSaver materialId={material.id}>
        <div className="mt-7 prose prose-base prose-ink max-w-none dark:prose-invert text-[1.0625rem] leading-[1.65] prose-p:text-[1.0625rem] prose-p:leading-[1.65] prose-li:leading-[1.65] prose-headings:font-semibold! prose-headings:tracking-tight [&_a]:link prose-img:rounded-lg prose-video:rounded-lg prose-pre:rounded-md prose-kbd:rounded-xs prose-hr:border-hairline break-words">
          {bodyContent === "" ? null : bodyEntities && bodyEntities.length > 0 ? (
            <div className="whitespace-pre-wrap">
              {convertTelegramEntitiesToReact(bodyContent, bodyEntities, "full")}
            </div>
          ) : isHtmlContent ? (
            <div
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(bodyContent) }}
            />
          ) : (
            <p className="whitespace-pre-wrap">{bodyContent}</p>
          )}
        </div>
      </ExcerptSaver>

      {/* AI Reasoning */}
      {material.aiReasoning && (
        <div className="mt-8 rounded-xl bg-muted ring-1 ring-inset ring-hairline p-4 sm:p-5">
          <SectionLabel as="h3" className="flex items-center gap-1.5">
            <Sparkles className="h-[14px] w-[14px] text-primary-emphasis" />
            AI Reasoning
          </SectionLabel>
          <p className="mt-2 text-sm sm:text-[0.9375rem] text-muted-foreground leading-relaxed break-words">
            {material.aiReasoning}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The two actions every article offers, so the page and the peek do not have to
 * re-derive them: open the original, and archive-or-restore by status.
 */
export function baseMaterialActions(material: {
  url: string
  userStatus: MaterialArticleMaterial["userStatus"]
}, handlers: { onArchive: () => void; onRestore: () => void }): ReadingAction[] {
  return [
    {
      key: "open",
      label: "Open original",
      icon: ExternalLink,
      href: material.url,
    },
    material.userStatus === "ARCHIVED"
      ? { key: "restore", label: "Restore", icon: ArchiveRestore, onSelect: handlers.onRestore }
      : { key: "archive", label: "Archive", icon: Archive, onSelect: handlers.onArchive },
  ]
}
