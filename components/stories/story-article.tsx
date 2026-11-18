"use client"

/**
 * A story's reading body (RAD-345) — everything `/stories/[id]` and the side
 * peek have in common: status badges, headline, byline, rubrics, action rail,
 * deck, media, markdown body, key takeaways, sources, related coverage, and the
 * material/inbox provenance lists.
 *
 * Extracted from `StoryDetail` when the peek was built. As with
 * `MaterialArticle`: the page keeps its shell, its handlers and its delete
 * dialog; this component takes `actions`.
 *
 * Two peek-specific behaviours, both opt-in so the page is untouched:
 *   - `onOpenMaterial` — a material row in the provenance list swaps the peek
 *     to that post instead of navigating the whole page away. Modified clicks
 *     still fall through to the canonical link.
 *   - No `sm:` viewport assumptions for the provenance rows below the body —
 *     a `sm:` class fires in a 400px panel on a 1440px screen, so rows and
 *     thumbs size off the article's own width via `@container`. The reading
 *     column itself is supplied by the shell (page) or `PeekColumn` (peek), and
 *     the two are the same stack, so no `variant` is needed here.
 */

import { useState } from "react"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import { formatDistanceToNow, format } from "date-fns"
import { enUS } from "date-fns/locale"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { isHtml } from "@/lib/html-utils"
import { stripHtml } from "@/lib/sanitize"
import { isNewTabClick } from "@/lib/peek/click"
import {
  convertTelegramEntitiesToReact,
  adjustEntitiesForExcerpt,
  type TelegramEntity,
} from "@/lib/telegram-entities-to-react"
import { MaterialFeedbackButtons } from "@/components/materials/material-feedback-buttons"
import { MaterialMedia } from "@/components/materials/material-media"
import { mediaKindFromUrl, previewImageUrl, storyDetailMedia } from "@/lib/media-urls"
import { ActionRail, ReadingTitle, SectionLabel } from "@/components/reading/reading-layout"
import { ReadingActions, type ReadingAction } from "@/components/reading/reading-actions"

export interface StoryArticleMaterial {
  id: string
  title: string
  url: string
  content: string
  contentEntities?: TelegramEntity[] | null
  publishedAt: Date | null
  thumbnailUrl: string | null
  mediaUrls: string[]
  aiEvaluation: "APPROVED" | "FILTERED"
  aiConfidence: number
  aiReasoning: string | null
  userStatus: string
  createdAt: string
  feed: {
    id: string
    name: string
    type: string
  }
  feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
}

export interface StoryArticleInboxItem {
  id: string
  externalId: string
  messageId: number
  rawText: string | null
  extractedUrl: string | null
  extractedTitle: string | null
  mediaUrls: string[]
  thumbnailUrl: string | null
  sourceChannel: string | null
  status: string
  createdAt: string
}

export interface StoryArticleStory {
  id: string
  title: string
  languageFlag: string | null
  summary: string
  body: string
  keyPoints: string[]
  sourceUrls: string[]
  rubrics: string[]
  archiveLinks: unknown
  notionPageId: string | null
  notionUrl: string | null
  status: string
  version: number
  createdAt: string
  updatedAt: string
  materials: StoryArticleMaterial[]
  inboxItems: StoryArticleInboxItem[]
}

/**
 * How many visual tiles the media grid mounts before the reader asks for the
 * rest. A story of six RSS posts can carry 90 frames; three rows of two keep
 * the body within reach, and the round-robin order makes those six a sample of
 * different posts rather than the lead post's album.
 */
const MEDIA_PREVIEW_MAX = 6

/** A URL as a reader wants to see it: no scheme, no `www.`, no trailing slash. */
function prettyUrl(url: string) {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "")
}

/**
 * The one heading level the story body is structured with. Sections on this page
 * are separated by a heading and whitespace rather than by a framed panel — the
 * post page reads well for the same reason.
 */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base sm:text-lg font-semibold tracking-tight">{children}</h2>
}

export function StoryArticle({
  story,
  actions,
  onOpenMaterial,
  onFeedback,
}: {
  story: StoryArticleStory
  actions: ReadingAction[]
  onOpenMaterial?: (materialId: string) => void
  /** The owner's feedback side effects (propagate to sibling materials, auto-archive). */
  onFeedback?: (feedbackType: "LIKE" | "DISLIKE", primaryMaterialId: string) => void
}) {
  const primaryMaterial = story.materials[0]
  const isAllArchived = story.materials.length > 0 && story.materials.every(m => m.userStatus === "ARCHIVED")
  const archiveLinkItems = Array.isArray(story.archiveLinks) ? story.archiveLinks as { title: string; url: string; issueNumber?: number }[] : []

  // Every member post's media, then the inbox items' (RAD-400) — see
  // `storyDetailMedia` for the order and the dedupe.
  const media = storyDetailMedia(story)
  const mediaCount = media.visual.length + media.files.length
  // "Show more" mounts the rest rather than unhiding it, so a 90-frame story
  // does not fetch 90 images up front. There is no collapse back.
  const [showAllMedia, setShowAllMedia] = useState(false)
  // Images that failed to load, by entry key. They leave the list BEFORE the
  // cap is applied, so a broken tile gives its slot to the next frame instead
  // of leaving five tiles and a button. "Media (N)" still counts them — the
  // post page's label counts what the post carries, not what loaded.
  const [failedMedia, setFailedMedia] = useState<ReadonlySet<string>>(() => new Set())
  const liveVisual = media.visual.filter((entry) => !failedMedia.has(entry.key))
  const shownVisual = showAllMedia ? liveVisual : liveVisual.slice(0, MEDIA_PREVIEW_MAX)
  const hiddenVisual = showAllMedia ? 0 : liveVisual.length - shownVisual.length

  /** In the peek, a material row swaps the peek; modified clicks keep the link. */
  function handleMaterialLink(e: React.MouseEvent, materialId: string) {
    if (!onOpenMaterial) return
    if (isNewTabClick(e)) return
    e.preventDefault()
    onOpenMaterial(materialId)
  }

  return (
    <div className="@container">
      <div className="mt-4 sm:mt-0 space-y-6">
      {/* Header — one item per line. The byline used to sit opposite the badges
          in a single flex row, which on a phone collided with them instead of
          wrapping. */}
      <div className="space-y-2.5 sm:space-y-3">
        <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
          <Badge variant={story.status === "SENT_TO_NOTION" ? "default" : story.status === "ERROR" ? "destructive" : "secondary"} size="sm">
            {story.status === "SENT_TO_NOTION" ? "In Notion" : story.status === "ERROR" ? "Error" : "Draft"}
          </Badge>
          <span className="text-[0.8125rem] sm:text-sm font-medium text-muted-foreground type-counter">v{story.version}</span>
          {isAllArchived && (
            <Badge variant="subtle" size="sm">Archived</Badge>
          )}
        </div>

        <ReadingTitle>{story.title}</ReadingTitle>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] sm:text-sm text-muted-foreground">
          {primaryMaterial && (
            <>
              <Link
                href={`/feeds/${primaryMaterial.feed.id}`}
                className="font-medium text-foreground/80 hover:text-foreground hover:underline transition-colors"
              >
                {primaryMaterial.feed.name}
              </Link>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={new Date(story.createdAt).toISOString()}>
            {format(new Date(story.createdAt), "d MMM yyyy, HH:mm", { locale: enUS })}
          </time>
        </div>
      </div>

      {/* Rubrics */}
      {story.rubrics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {story.rubrics.map((r) => (
            <Badge key={r} variant="outline" size="sm">{r}</Badge>
          ))}
        </div>
      )}

      <ActionRail>
        {primaryMaterial && (
          <MaterialFeedbackButtons
            compact
            materialId={primaryMaterial.id}
            existingFeedback={primaryMaterial.feedbacks?.[0] ?? null}
            onFeedbackSubmitted={onFeedback ? (feedbackType) => onFeedback(feedbackType, primaryMaterial.id) : undefined}
          />
        )}
        <ReadingActions actions={actions} />
      </ActionRail>

      {/* The story itself — deck, imagery, body. Structured by type, not by boxes:
          every section below is plain flow on the card, headed rather than framed. */}
      <div className="space-y-8">
        {/* Deck — the summary, set as a lead paragraph instead of a labelled panel */}
        {story.summary && (
          <p className="text-lg sm:text-xl leading-relaxed text-pretty">{story.summary}</p>
        )}

        {/* Media — every member post's frames, then the inbox items'. An image
            keeps its link-wrapped still in a fixed 16:9 box (`object-contain`
            letterboxes onto `bg-muted`, so tiles line up whatever the ratio);
            a playable entry goes through `MaterialMedia`, which owns its own
            link, so nothing playable sits inside an `<a>` (a nested player
            would fight the link). A player needs the full measure on a narrow
            column, hence `col-span-2` below `@sm`. Files (audio, documents,
            "not mirrored") are no tiles: they stack below the grid, all of
            them, outside the cap. Keyed by `entry.key`, not the URL: two
            channels can both carry `tg://photo/12`. */}
        {mediaCount > 0 && (
          <section className="space-y-3">
            <SectionLabel>Media ({mediaCount})</SectionLabel>
            {shownVisual.length > 0 && (
              <div className="grid grid-cols-2 gap-3 @sm:gap-4">
                {shownVisual.map((entry) =>
                  entry.kind === "image" ? (
                    <a
                      key={entry.key}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block aspect-video rounded-lg overflow-hidden bg-muted"
                    >
                      <img
                        src={entry.url}
                        alt={entry.alt}
                        loading="lazy"
                        className="h-full w-full object-contain"
                        onError={() =>
                          setFailedMedia((prev) => new Set(prev).add(entry.key))
                        }
                      />
                    </a>
                  ) : (
                    <div key={entry.key} className="col-span-2 @sm:col-span-1">
                      <MaterialMedia url={entry.url} poster={entry.poster} alt={entry.alt} />
                    </div>
                  )
                )}
              </div>
            )}
            {hiddenVisual > 0 && (
              <Button
                variant="ghost"
                className="min-h-[44px]"
                onClick={() => setShowAllMedia(true)}
              >
                Show {hiddenVisual} more
              </Button>
            )}
            {media.files.length > 0 && (
              <div className="flex flex-col gap-3">
                {media.files.map((entry) => (
                  <MaterialMedia key={entry.key} url={entry.url} alt={entry.alt} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Body — markdown, at the same measure and scale as a post */}
        {story.body && (
        <div className="prose prose-base prose-ink max-w-none dark:prose-invert text-[1.0625rem] leading-[1.65] prose-p:text-[1.0625rem] prose-p:leading-[1.65] prose-li:leading-[1.65] prose-headings:font-semibold! prose-headings:tracking-tight [&_a]:link prose-img:rounded-lg prose-video:rounded-lg prose-pre:rounded-md prose-kbd:rounded-xs prose-hr:border-hairline break-words">
          <ReactMarkdown
            components={{
              a: ({ ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
              // The body is LLM-authored markdown; a stray `#` must not mint a
              // second h1 under the story title.
              h1: ({ ...props }) => <h2 {...props} />,
              h2: ({ ...props }) => <h3 {...props} />,
            }}
          >
            {story.body}
          </ReactMarkdown>
        </div>
        )}

        {/* Key Points */}
        {story.keyPoints.length > 0 && (
          <section className="space-y-3">
            <SectionHeading>Key takeaways</SectionHeading>
            <ul className="list-disc space-y-2 pl-5 marker:text-muted-foreground">
              {story.keyPoints.map((point, i) => (
                <li key={i} className="text-[1.0625rem] leading-relaxed text-pretty">{point}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Source URLs */}
        {story.sourceUrls.length > 0 && (
          <section className="space-y-3">
            <SectionHeading>Sources</SectionHeading>
            <ul className="space-y-2">
              {story.sourceUrls.map((url, i) => (
                <li key={i}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={url}
                    className="inline-flex items-baseline gap-2 text-[1.0625rem] link"
                  >
                    <ExternalLink className="h-[14px] w-[14px] shrink-0 self-start translate-y-[0.15em]" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{prettyUrl(url)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Archive links */}
        {archiveLinkItems.length > 0 && (
          <section className="space-y-3">
            <SectionHeading>Related coverage</SectionHeading>
            <ul className="space-y-2">
              {archiveLinkItems.map((link, i) => (
                <li key={i}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-baseline gap-2 text-[1.0625rem] link"
                  >
                    <ExternalLink className="h-[14px] w-[14px] shrink-0 self-start translate-y-[0.15em]" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {link.title}
                      {link.issueNumber && (
                        <span className="text-muted-foreground"> (#{link.issueNumber})</span>
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* What the story was built from. The section rules are gone, so the seam
          is whitespace: `pt-4` adds to the 19.2px sibling gap rather than
          collapsing into it, putting a 32px break here against the 25.6px that
          separates the story's own sections. */}
      <div className="pt-4 space-y-8 empty:hidden">
      {story.materials.length > 0 && (
        <section className="space-y-3">
          <SectionHeading>Materials ({story.materials.length})</SectionHeading>
          <div className="divide-y divide-hairline">
            {story.materials.map((material) => {
              // Only three lines are ever shown, so never ship the whole parsed
              // article into the payload to be clipped by line-clamp.
              // Entities index the raw Telegram text and only the Telegram
              // worker writes them — never strip HTML under live entities.
              const entities =
                material.contentEntities && material.contentEntities.length > 0
                  ? material.contentEntities
                  : null
              const text =
                !entities && isHtml(material.content)
                  ? stripHtml(material.content)
                  : material.content
              const clipped = text.slice(0, 600)
              const clippedEntities = entities ? adjustEntitiesForExcerpt(entities, 600) : null
              const cleanContent = text.length > 600 ? `${clipped}…` : text
              // The row thumb is the post's cover as every other surface
              // reads it (`previewImageUrl`), so a Land Book member shows the
              // site its hero shows rather than Landbook's branded card
              // (RAD-432).
              const thumb = previewImageUrl(material)
              return (
                <article key={material.id} className="flex gap-4 py-5 first:pt-1 last:pb-0">
                  {thumb && (
                    <Link
                      href={`/posts/${material.id}`}
                      aria-hidden="true"
                      tabIndex={-1}
                      className="shrink-0"
                      onClick={(e) => handleMaterialLink(e, material.id)}
                    >
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        // Row thumb: the box stays fixed and `object-contain`
                        // does the uncropping, letterboxing onto `bg-muted`. A
                        // free width would start every title at a different x.
                        className="h-16 w-24 @sm:h-20 @sm:w-32 rounded-lg object-contain bg-muted"
                        onError={(e) => {
                          const parent = e.currentTarget.parentElement
                          if (parent) parent.style.display = "none"
                        }}
                      />
                    </Link>
                  )}

                  <div className="min-w-0 flex-1 space-y-2">
                    <Link
                      href={`/posts/${material.id}`}
                      className="type-heading block font-semibold leading-snug text-pretty hover:text-primary-emphasis transition-colors"
                      onClick={(e) => handleMaterialLink(e, material.id)}
                    >
                      {material.title}
                    </Link>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <span className={cn(
                        "h-2 w-2 rounded-full shrink-0",
                        material.aiEvaluation === "APPROVED" ? "bg-green-bright" : "bg-destructive"
                      )} />
                      <span>{material.aiEvaluation === "APPROVED" ? "Approved" : "Filtered"}</span>
                      <span>·</span>
                      <span className="type-counter">{material.aiConfidence}%</span>
                      <span>·</span>
                      <span>{material.feed.name}</span>
                      {material.publishedAt && (
                        <>
                          <span>·</span>
                          <span>{format(new Date(material.publishedAt), "d MMM yyyy", { locale: enUS })}</span>
                        </>
                      )}
                    </div>

                    <p className="text-[1.0625rem] text-muted-foreground leading-relaxed text-pretty line-clamp-3">
                      {clippedEntities && clippedEntities.length > 0
                        ? convertTelegramEntitiesToReact(cleanContent, clippedEntities, "compact")
                        : cleanContent}
                    </p>

                    {material.aiReasoning && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground">AI reasoning. </span>
                        {material.aiReasoning}
                      </p>
                    )}

                    <a
                      href={material.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm link"
                    >
                      <ExternalLink className="h-[14px] w-[14px]" />
                      Open original
                    </a>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {/* Source Inbox Items (Telegram pipeline) */}
      {story.inboxItems.length > 0 && (
        <section className="space-y-3">
          <SectionHeading>Inbox items ({story.inboxItems.length})</SectionHeading>
          <div className="divide-y divide-hairline">
            {story.inboxItems.map((item) => (
              <div key={item.id} className="flex gap-4 py-5 first:pt-1 last:pb-0">
                {item.thumbnailUrl && (
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-16 w-24 @sm:h-20 @sm:w-32 shrink-0 rounded-lg object-contain bg-muted"
                    onError={(e) => {
                      e.currentTarget.style.display = "none"
                    }}
                  />
                )}

                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="type-heading font-semibold leading-snug">
                      {item.extractedTitle || item.sourceChannel || `Message #${item.messageId}`}
                    </span>
                    <Badge variant="subtle" size="sm">{item.status}</Badge>
                  </div>

                  {item.rawText && (
                    <p className="text-[1.0625rem] text-muted-foreground leading-relaxed text-pretty line-clamp-3">
                      {item.rawText}
                    </p>
                  )}

                  {item.mediaUrls.filter(
                    (u) => u !== item.thumbnailUrl && mediaKindFromUrl(u) === "image"
                  ).length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {item.mediaUrls
                        .filter((u) => u !== item.thumbnailUrl && mediaKindFromUrl(u) === "image")
                        .map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                            <img
                              src={url}
                              alt={`Media ${i + 1}`}
                              loading="lazy"
                              className="h-16 w-auto max-w-48 rounded-lg object-contain bg-muted"
                              onError={(e) => {
                                e.currentTarget.style.display = "none"
                              }}
                            />
                          </a>
                        ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>
                      {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: enUS })}
                    </span>
                    {item.extractedUrl && (
                      <>
                        <span>·</span>
                        <a
                          href={item.extractedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={item.extractedUrl}
                          className="min-w-0 [overflow-wrap:anywhere] link"
                        >
                          {prettyUrl(item.extractedUrl)}
                        </a>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      </div>
      </div>
    </div>
  )
}
