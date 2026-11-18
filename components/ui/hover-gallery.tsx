"use client"

import { useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Hover-scrub gallery — a port of IDS's `.ids__inline-gallery`
 * (`css/components/promo-block.css` + `js/promo-block.js` in
 * github.com/intuition-tech/ids, MIT). IDS is copy-paste by design, so this is
 * a port rather than a dependency; the mechanism is theirs, two behaviours are
 * deliberately ours:
 *
 * 1. **The band never changes height and no frame is cropped.** IDS gives every
 *    image `aspect-ratio` + `object-fit: cover`, i.e. one box and a centre crop.
 *    Here frame 0 — the cover — stays in normal flow and *defines* the band, and
 *    frames 1..N are absolutely positioned over it with `object-contain`. So the
 *    band keeps the cover's own aspect ratio (the uncropped rule the cards just
 *    adopted), every frame arrives whole, and a scrub shifts no layout. The
 *    overlays carry `bg-muted`: `object-contain` letterboxes with transparency,
 *    and the cover underneath is never hidden, so without an opaque fill a
 *    portrait frame would show slices of the cover either side of itself.
 * 2. **Frames 1..N are not fetched until the first pointer touches the band.**
 *    IDS renders them all up front, and `visibility: hidden` still downloads —
 *    on a 50-card grid that is 50x the traffic for images most cards never show.
 *    Until a frame has loaded, the previously shown frame stays up, so a scrub
 *    never flashes an empty band.
 *
 * **Frames are identified by URL, not by position**, because a rotten one drops
 * out: `mediaUrls` is third-party and holds video files and icons the RSS body
 * scrape collected, plus URLs that simply rot. A frame that fails to load is
 * removed from the scrub, the count and the dashes, so the indicators never
 * advertise an image that cannot paint.
 *
 * **No keyboard scrubbing, deliberately.** The band is not focusable and the
 * cover's `alt` reads "— image 1 of N", so the other frames are discoverable;
 * every one of them is rendered in full on the detail page, which is one
 * keyboard-reachable navigation away. Arrow-key scrubbing would invent a
 * convention this codebase has nowhere else, for content that is not gated
 * behind the gesture.
 */

/**
 * Which frame the pointer is over: the band's width is split into `count` equal
 * zones, left to right.
 *
 * Pure on purpose — jsdom has no layout engine, so this is the only part of the
 * scrub that can be tested off a real browser.
 */
export function scrubIndex(
  clientX: number,
  rect: { left: number; width: number },
  count: number
): number {
  if (count <= 1 || rect.width <= 0) return 0
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return Math.min(Math.trunc(x * count), count - 1)
}

/** A horizontal travel past this is a scrub, not a tap, and must not navigate. */
const DRAG_SLOP_PX = 8

export function HoverGallery({
  images,
  alt,
  imageClassName,
  onCoverLoad,
  onCoverError,
}: {
  /** Frame 0 is the cover and sets the band's height. At least 2 entries, deduped. */
  images: string[]
  alt: string
  /** The cover's classes, owned by CardCover so the crop policy lives in one file. */
  imageClassName: string
  /** The cover has a size — CardCover releases its reserved height on this. */
  onCoverLoad?: () => void
  /** The cover is the band's height, so its failure is the band's failure. */
  onCoverError?: () => void
}) {
  const bandRef = useRef<HTMLDivElement>(null)
  // Read once per hover: only `left`/`width` are used, and neither changes
  // while the pointer is inside. Reading per `pointermove` forced a layout at
  // pointer rate, against a grid that may be mid-FLIP.
  const rectRef = useRef<{ left: number; width: number } | null>(null)
  // The frame the pointer asks for. A ref, not state: a scrub crosses zones at
  // pointer rate and only a CHANGE of the shown frame deserves a render.
  const wantedRef = useRef(0)
  const loadedRef = useRef<Set<string>>(new Set([images[0]]))
  // Where a touch went down, and whether it has travelled. `touch-action:
  // pan-y` leaves horizontal movement to us, so the browser never claims the
  // gesture and synthesises a click on lift — which the host card turns into a
  // navigation. A scrub must not open the post.
  const downXRef = useRef<number | null>(null)
  const draggedRef = useRef(false)
  // Which device is scrubbing. A mouse *hovers*: leaving the band ends the
  // hover and the cover comes back. A finger does not hover — lifting it ends
  // the gesture, and snapping back to the cover would undo the swipe the reader
  // just made. Reported from production (2026-09-12): on touch the second frame
  // never appeared at all, because the lift also cleared the frame the gesture
  // had asked for while its image was still downloading.
  const pointerTypeRef = useRef("mouse")
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState(0)
  const [armed, setArmed] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)

  // The frames that can actually paint. The cover stays regardless — it is the
  // band's height, and CardCover drops a failed cover and remounts the gallery
  // on the next frame.
  const live = images.filter((src, index) => index === 0 || !failed.has(src))
  const shownIndex = Math.min(shown, live.length - 1)

  function measure() {
    const band = bandRef.current
    if (!band) return
    const rect = band.getBoundingClientRect()
    rectRef.current = { left: rect.left, width: rect.width }
  }

  function arm(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType) pointerTypeRef.current = event.pointerType
    measure()
    setScrubbing(true)
    if (!armed) setArmed(true)
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    downXRef.current = event.clientX
    draggedRef.current = false
    arm(event)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (
      downXRef.current !== null &&
      Math.abs(event.clientX - downXRef.current) > DRAG_SLOP_PX
    ) {
      draggedRef.current = true
    }

    const rect = rectRef.current
    if (!rect) return
    const wanted = scrubIndex(event.clientX, rect, live.length)
    if (wanted === wantedRef.current) return
    wantedRef.current = wanted
    // Hold the current frame until the wanted one can actually paint.
    if (loadedRef.current.has(live[wanted])) setShown(wanted)
  }

  function handleLeave(event?: React.PointerEvent<HTMLDivElement>) {
    const pointerType = event?.pointerType || pointerTypeRef.current
    downXRef.current = null
    rectRef.current = null
    setScrubbing(false)
    // A lifted finger (or a gesture iOS takes over mid-swipe, which arrives as
    // `pointercancel`) leaves the frame it ended on standing, and leaves
    // `wantedRef` alone so a frame that is still downloading can still take its
    // place when it arrives. The chip keeps saying which frame that is.
    if (pointerType === "touch" || pointerType === "pen") return
    wantedRef.current = 0
    setShown(0)
  }

  function handleLoaded(src: string) {
    loadedRef.current.add(src)
    if (live[wantedRef.current] === src) setShown(wantedRef.current)
  }

  function handleFailed(src: string) {
    setFailed((prev) => {
      const next = new Set(prev)
      next.add(src)
      return next
    })
    // Whatever zone the pointer is in, the cover is always safe to show.
    wantedRef.current = 0
    setShown(0)
  }

  return (
    <div
      ref={bandRef}
      // `pan-y` keeps vertical scrolling with the page while a horizontal drag
      // scrubs — the gesture split IDS relies on. A tap is still a tap, so the
      // card's own click-through keeps working; a drag is swallowed below.
      className="group/gallery relative w-full touch-pan-y"
      onPointerEnter={arm}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={handleLeave}
      // No `onPointerUp`: for a touch pointer the browser fires `pointerout` and
      // `pointerleave` right after the lift (the pointer stops existing), so the
      // gesture's end already arrives here — whereas a mouse button lifting
      // inside the band is mid-hover and must change nothing.
      onPointerCancel={handleLeave}
      onClickCapture={(event) => {
        if (!draggedRef.current) return
        event.preventDefault()
        event.stopPropagation()
        draggedRef.current = false
        downXRef.current = null
      }}
    >
      <img
        src={images[0]}
        alt={`${alt} — image 1 of ${live.length}`}
        loading="lazy"
        className={imageClassName}
        onLoad={onCoverLoad}
        onError={onCoverError}
      />

      {armed &&
        live.slice(1).map((src, i) => {
          const index = i + 1
          return (
            <img
              key={`${index}-${src}`}
              src={src}
              alt=""
              // `bg-muted` is load-bearing, not decoration — see (1) above.
              className={cn(
                "absolute inset-0 h-full w-full bg-muted object-contain",
                index === shownIndex ? "visible" : "invisible"
              )}
              onLoad={() => handleLoaded(src)}
              onError={() => handleFailed(src)}
            />
          )
        })}

      <Badge
        size="sm"
        variant="subtle"
        aria-hidden="true"
        className="absolute right-2 top-2 bg-card/85 text-foreground shadow-[var(--shadow-card)] backdrop-blur-sm type-counter"
      >
        {shownIndex + 1}/{live.length}
      </Badge>

      {/* Position dashes, IDS's `__dashes`: one per frame, the current one wide.
          On a glass pill because they sit over arbitrary photography.

          The scrubbing state is a data attribute, not a second `opacity-*`
          class: `cn` is tailwind-merge, which resolves a same-group conflict by
          deleting the earlier class — an unprefixed `opacity-100` would remove
          the base `opacity-0` from the string outright and park the pill over
          every card the pointer ever brushed. A variant-prefixed class loses
          that fight by design. */}
      <div
        aria-hidden="true"
        data-scrubbing={scrubbing || undefined}
        className="absolute inset-x-0 bottom-2 flex justify-center opacity-0 transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-snap)] group-hover/gallery:opacity-100 data-[scrubbing]:opacity-100 motion-reduce:transition-none"
      >
        <div className="flex items-center gap-1 rounded-full bg-card/75 px-2 py-1.5 shadow-[var(--shadow-card)] backdrop-blur-sm">
          {live.map((src, index) => (
            <span
              key={src}
              className={cn(
                "h-[3px] rounded-full transition-[width,background-color] duration-[var(--dur-fast)] ease-[var(--ease-snap)] motion-reduce:transition-none",
                index === shownIndex ? "w-4 bg-foreground" : "w-1.5 bg-foreground/30"
              )}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
