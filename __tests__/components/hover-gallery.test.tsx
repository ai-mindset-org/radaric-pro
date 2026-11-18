/**
 * @vitest-environment jsdom
 */

/**
 * The hover-scrub cover gallery (IDS `.ids__inline-gallery` port).
 *
 * jsdom has no layout engine, so the pointer-x → frame mapping is tested as the
 * pure function it was written as, and the wiring around it is tested with a
 * stubbed `getBoundingClientRect` (same approach as animated-grid.test.tsx).
 * Whether the band actually holds its height while scrubbing is verified in a
 * real browser — there is no layout here to measure.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { HoverGallery, scrubIndex } from "@/components/ui/hover-gallery"

const ORIGINAL_RECT = Element.prototype.getBoundingClientRect

const FRAMES = [
  "https://x/0.jpg",
  "https://x/1.jpg",
  "https://x/2.jpg",
  "https://x/3.jpg",
]

/** The band sits at x=0 and is 400px wide → 100px per frame for FRAMES. */
function stubBandRect(width = 400, left = 0) {
  Element.prototype.getBoundingClientRect = function () {
    return {
      left,
      top: 0,
      right: left + width,
      bottom: 200,
      width,
      height: 200,
      x: left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
}

function band() {
  // The scrub surface is the cover image's parent.
  return screen.getByRole("img", { name: /image 1 of 4/i }).parentElement!
}

function visibleExtraFrames() {
  return Array.from(document.querySelectorAll("img"))
    .filter((img) => img.getAttribute("alt") === "")
    .filter((img) => !img.className.includes("invisible"))
    .map((img) => img.getAttribute("src"))
}

function extraFrames() {
  return Array.from(document.querySelectorAll('img[alt=""]'))
}

/** The indicator pill's wrapper — the only element carrying the fade classes. */
function dashPill() {
  return document.querySelector('[class*="bottom-2"]') as HTMLElement
}

beforeEach(() => {
  stubBandRect()
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = ORIGINAL_RECT
  cleanup()
})

describe("scrubIndex", () => {
  const rect = { left: 0, width: 400 }

  it("splits the band into equal zones, left to right", () => {
    expect(scrubIndex(0, rect, 4)).toBe(0)
    expect(scrubIndex(99, rect, 4)).toBe(0)
    expect(scrubIndex(100, rect, 4)).toBe(1)
    expect(scrubIndex(250, rect, 4)).toBe(2)
    expect(scrubIndex(399, rect, 4)).toBe(3)
  })

  it("clamps past both edges instead of returning an out-of-range frame", () => {
    expect(scrubIndex(-50, rect, 4)).toBe(0)
    expect(scrubIndex(400, rect, 4)).toBe(3)
    expect(scrubIndex(9999, rect, 4)).toBe(3)
  })

  it("respects the band's offset on the page", () => {
    expect(scrubIndex(120, { left: 100, width: 400 }, 4)).toBe(0)
    expect(scrubIndex(320, { left: 100, width: 400 }, 4)).toBe(2)
  })

  it("never divides by a zero width, and a single frame is always frame 0", () => {
    expect(scrubIndex(50, { left: 0, width: 0 }, 4)).toBe(0)
    expect(scrubIndex(50, rect, 1)).toBe(0)
  })
})

describe("HoverGallery", () => {
  it("renders only the cover until a pointer arrives", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)

    const imgs = document.querySelectorAll("img")
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute("src")).toBe(FRAMES[0])
  })

  it("mounts the remaining frames on the first pointer enter", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)

    fireEvent.pointerEnter(band())

    expect(document.querySelectorAll("img")).toHaveLength(FRAMES.length)
  })

  it("shows the frame the pointer is over once it has loaded", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerEnter(el)
    // Frames report themselves ready — there is no network in jsdom.
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)

    fireEvent.pointerMove(el, { clientX: 250 })
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])

    fireEvent.pointerMove(el, { clientX: 390 })
    expect(visibleExtraFrames()).toEqual([FRAMES[3]])
  })

  it("holds the current frame until the wanted one has loaded", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerEnter(el)
    fireEvent.pointerMove(el, { clientX: 250 })

    // Nothing has loaded yet: no extra frame may cover the cover.
    expect(visibleExtraFrames()).toEqual([])

    const third = document.querySelectorAll('img[alt=""]')[1]
    fireEvent.load(third)
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])
  })

  it("returns to the cover when the pointer leaves", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerEnter(el)
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)
    fireEvent.pointerMove(el, { clientX: 250 })
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])

    fireEvent.pointerLeave(el)
    expect(visibleExtraFrames()).toEqual([])
  })

  // A touch swipe is not a hover. Reported from production on 2026-09-12: a
  // card read `1/2`, the finger went across the band, and only the cover ever
  // appeared. Two separate reasons, one per test.
  it("lands a touch swipe on the frame it ended on, even when the image loads after the finger is up", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    // First contact is what mounts frames 1..N, so on a touch device the
    // gesture and the very first byte of those images start together — the
    // finger is always faster than the network.
    fireEvent.pointerDown(el, { clientX: 10, pointerType: "touch" })
    fireEvent.pointerMove(el, { clientX: 250, pointerType: "touch" })
    fireEvent.pointerLeave(el, { clientX: 250, pointerType: "touch" })

    const third = document.querySelectorAll('img[alt=""]')[1]
    fireEvent.load(third)

    expect(visibleExtraFrames()).toEqual([FRAMES[2]])
  })

  it("keeps the frame a touch swipe ended on — a lifted finger is the end of a gesture, not a departure", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerDown(el, { clientX: 10, pointerType: "touch" })
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)
    fireEvent.pointerMove(el, { clientX: 250, pointerType: "touch" })
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])

    fireEvent.pointerLeave(el, { clientX: 250, pointerType: "touch" })
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])
    expect(screen.getByText("3/4")).toBeInTheDocument()
  })

  it("does not snap back when a mouse button lifts inside the band — the hover is still on", () => {
    // A click on a scrubbed frame must not flip the card back to the cover
    // under the cursor; only leaving the band ends a hover.
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerEnter(el, { pointerType: "mouse" })
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)
    fireEvent.pointerMove(el, { clientX: 250, pointerType: "mouse" })
    fireEvent.pointerUp(el, { clientX: 250, pointerType: "mouse" })

    expect(visibleExtraFrames()).toEqual([FRAMES[2]])
  })

  it("still returns to the cover when a MOUSE leaves, even after a drag", () => {
    // Hover has an out; the reset must survive the touch change above.
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerDown(el, { clientX: 10, pointerType: "mouse" })
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)
    fireEvent.pointerMove(el, { clientX: 250, pointerType: "mouse" })
    expect(visibleExtraFrames()).toEqual([FRAMES[2]])

    fireEvent.pointerLeave(el, { clientX: 250, pointerType: "mouse" })
    expect(visibleExtraFrames()).toEqual([])
  })

  it("counts the frames for the reader: a chip and one dash each", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)

    expect(screen.getByText("1/4")).toBeInTheDocument()
    // The dashes are the only spans inside the indicator pill.
    expect(document.querySelectorAll(".rounded-full > span")).toHaveLength(FRAMES.length)

    fireEvent.pointerEnter(band())
    for (const img of document.querySelectorAll('img[alt=""]')) fireEvent.load(img)
    fireEvent.pointerMove(band(), { clientX: 150 })

    expect(screen.getByText("2/4")).toBeInTheDocument()
  })

  it("fills each overlay, so the cover cannot show through its letterbox", () => {
    // `object-contain` letterboxes with transparency and the cover below is
    // never hidden — without an opaque fill a portrait frame would render with
    // slices of the cover either side of it.
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    fireEvent.pointerEnter(band())

    for (const frame of extraFrames()) {
      expect(frame.className).toContain("bg-muted")
    }
  })

  it("hides the dashes again once the pointer leaves", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)

    expect(dashPill()).not.toHaveAttribute("data-scrubbing")

    fireEvent.pointerEnter(band())
    expect(dashPill()).toHaveAttribute("data-scrubbing")

    fireEvent.pointerLeave(band())
    // A conditional `opacity-100` would have been merged over the base
    // `opacity-0` and parked the pill on every card the pointer brushed.
    expect(dashPill()).not.toHaveAttribute("data-scrubbing")
    expect(dashPill().className).toContain("opacity-0")
  })

  it("stops counting a frame that cannot load", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()

    fireEvent.pointerEnter(el)
    expect(screen.getByText("1/4")).toBeInTheDocument()

    // Third-party media rots, and `mediaUrls` also carries assets an <img>
    // can never render. A dead frame must leave the count and the dashes.
    fireEvent.error(extraFrames()[1])

    expect(screen.getByText("1/3")).toBeInTheDocument()
    expect(document.querySelectorAll(".rounded-full > span")).toHaveLength(3)
    expect(
      screen.getByRole("img", { name: "Post — image 1 of 3" })
    ).toBeInTheDocument()
  })

  it("swallows the click that ends a swipe, so a scrub does not open the post", () => {
    render(<HoverGallery images={FRAMES} alt="Post" imageClassName="cover" />)
    const el = band()
    let clicksSeen = 0
    el.parentElement!.addEventListener("click", () => {
      clicksSeen += 1
    })

    // A tap still reaches the card.
    fireEvent.pointerDown(el, { clientX: 100 })
    fireEvent.click(el)
    expect(clicksSeen).toBe(1)

    // A horizontal drag does not.
    fireEvent.pointerDown(el, { clientX: 100 })
    fireEvent.pointerMove(el, { clientX: 260 })
    fireEvent.click(el)
    expect(clicksSeen).toBe(1)
  })

  it("names the cover for assistive tech, and leaves the duplicates decorative", () => {
    render(<HoverGallery images={FRAMES} alt="Beatbot logo" imageClassName="cover" />)

    expect(
      screen.getByRole("img", { name: "Beatbot logo — image 1 of 4" })
    ).toBeInTheDocument()

    fireEvent.pointerEnter(band())
    // Decorative frames must not add four more images to the a11y tree.
    expect(screen.getAllByRole("img")).toHaveLength(1)
  })
})
