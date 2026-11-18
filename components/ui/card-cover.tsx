"use client"

import { useState } from "react"
import { HoverGallery } from "@/components/ui/hover-gallery"
import { cn } from "@/lib/utils"

/**
 * The cover band at the top of a card — a post, a story, a source.
 *
 * The image is NEVER cropped: it keeps its own aspect ratio and the band takes
 * whatever height that is, so cards in a grid row no longer share a cover
 * height. That is the point — a logo, a screenshot and a 16:9 still each arrive
 * whole rather than as a centre slice. `max-h` is the one guard (a 1:4
 * infographic would otherwise own the whole column) and `object-contain` lets
 * such an image shrink inside the band rather than lose its edges.
 *
 * **Height is reserved until the image reports its own.** A replaced element
 * with `h-auto`, no `width`/`height` attributes and no bytes yet lays out at
 * 0px, so without a floor every cover would pop in and shove the rest of the
 * grid down — and the bands this replaced (`h-48`, `aspect-video`) did reserve
 * space. `min-h-48` is that floor, released on the cover's `load`. The durable
 * fix is to store each cover's dimensions at parse time and emit them as
 * attributes; until the schema carries them, this keeps the grid still.
 *
 * `surface-mask-top` clips the band to the host card's superellipse: an
 * `overflow-hidden` clip follows `border-radius`, i.e. an arc, which cuts more
 * corner than the squircle and would show through on every WebKit engine. See
 * the mask section in `app/globals.css`.
 *
 * A failed cover frame is dropped and the next frame becomes the cover
 * (RAD-399) — cover URLs are third-party and rot, and a story's gallery mixes
 * several posts' images, so one dead frame must not take the others down. Only
 * when every frame has failed does the band hide, rather than leave an empty
 * grey slab. The band owns that decision for both branches, so no child reaches
 * across a component boundary to hide it.
 *
 * Pass `images` (2+ URLs, cover first) and the band becomes a hover-scrub
 * gallery instead of a still — see `HoverGallery`. One image, or none, renders
 * exactly the still below, listeners and indicators included.
 *
 * Identity imagery is deliberately NOT this component: avatars, favicons and
 * the 48px `icon-tile` stay cropped to their circle or app-icon square, because
 * there the shape is the convention, not a crop of the content.
 */

/**
 * The crop policy, as classes. Lives here — the one file that owns "a cover is
 * never cropped" — and is handed to `HoverGallery` for its cover frame so the
 * two cannot drift.
 */
const COVER_IMAGE_CLASS = "w-full h-auto max-h-[560px] object-contain"

export function CardCover({
  src,
  alt,
  images,
  className,
  badge,
}: {
  /** The still. Ignored when `images` carries 2+ frames. */
  src: string
  alt: string
  images?: string[]
  /**
   * Extra classes for the band. Must NOT include `rounded-*`: the superellipse
   * mask needs `border-radius: 0` to paint, and `cn` would let a caller's
   * radius win over the utility's reset.
   */
  className?: string
  /**
   * An overlay pinned over the band — the video play badge. It survives every
   * frame failing (which then renders a muted band instead of `null`) because
   * the badge is the only signal left that the post carries a video.
   */
  badge?: React.ReactNode
}) {
  // A duplicate URL would collide with a sibling's React key and hand a frame
  // the wrong `onLoad`; `images` is a public prop, so dedupe at the boundary.
  const candidates = images && images.length > 1 ? Array.from(new Set(images)) : [src]
  // Failed frames by URL: the cover is always the first frame still standing.
  const [failedFrames, setFailedFrames] = useState<ReadonlySet<string>>(() => new Set())
  // Which cover reported its height. Keyed by URL, not a boolean: a new cover
  // (a promotion, or a story regrouping under a different first frame) lays out
  // at 0px until its own bytes arrive, and with every frame failed the floor is
  // what keeps a badge-only band visible at all.
  const [sizedFor, setSizedFor] = useState<string | null>(null)

  const remaining = candidates.filter((url) => !failedFrames.has(url))
  const cover = remaining[0]
  const frames = remaining.length > 1 ? remaining : null
  const failed = remaining.length === 0
  const sized = !failed && sizedFor === cover

  function handleCoverError() {
    setFailedFrames((prev) => new Set(prev).add(cover))
  }

  // Every frame failed: hide the band, but never when a badge rides on it.
  if (failed && !badge) return null

  return (
    <div
      className={cn(
        "surface-mask-top relative w-full bg-muted overflow-hidden",
        !sized && "min-h-48",
        className
      )}
    >
      {!failed &&
        (frames ? (
          <HoverGallery
            // Remount on a new cover: the gallery's loaded/failed bookkeeping
            // assumes frame 0 never changes underneath it.
            key={cover}
            images={frames}
            alt={alt}
            imageClassName={COVER_IMAGE_CLASS}
            onCoverLoad={() => setSizedFor(cover)}
            onCoverError={handleCoverError}
          />
        ) : (
          <img
            // Keyed like the gallery, so a queued error from the previous URL
            // cannot land on its successor.
            key={cover}
            src={cover}
            alt={alt}
            loading="lazy"
            className={COVER_IMAGE_CLASS}
            onLoad={() => setSizedFor(cover)}
            onError={handleCoverError}
          />
        ))}

      {badge && (
        <span
          data-video-badge
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 left-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
        >
          {badge}
        </span>
      )}
    </div>
  )
}
