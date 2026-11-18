/**
 * @vitest-environment jsdom
 */

/**
 * `CardCover` owns two rules the rest of the app reads off it: a cover is never
 * cropped, and the band is clipped by the superellipse mask rather than by a
 * `border-radius` arc. Both are expressed as classes, so both are asserted as
 * classes — a future edit that swaps `object-contain` for `object-cover`, or
 * lets a `rounded-*` reach the masked element, has to break a test to do it.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { CardCover } from "@/components/ui/card-cover"

const COVER = "https://x/cover.jpg"

function band() {
  return document.querySelector(".surface-mask-top") as HTMLElement
}

afterEach(cleanup)

describe("CardCover", () => {
  it("never crops: the image keeps its own ratio inside a capped band", () => {
    render(<CardCover src={COVER} alt="Post" />)

    const img = screen.getByRole("img")
    expect(img).toHaveClass("h-auto", "object-contain", "max-h-[560px]")
    expect(img).not.toHaveClass("object-cover")
  })

  it("clips with the mask, and never with a radius the mask cannot survive", () => {
    render(<CardCover src={COVER} alt="Post" className="mt-2" />)

    expect(band()).toHaveClass("surface-mask-top", "mt-2")
    expect(band().className).not.toMatch(/\brounded-/)
  })

  it("reserves a height until the image reports one, then releases it", () => {
    render(<CardCover src={COVER} alt="Post" />)

    // An <img> with h-auto and no bytes lays out at 0px; the floor is what
    // keeps a cold grid from shoving itself down cover by cover.
    expect(band()).toHaveClass("min-h-48")

    fireEvent.load(screen.getByRole("img"))
    expect(band()).not.toHaveClass("min-h-48")
  })

  it("hides the band when the cover rots, rather than leaving a grey slab", () => {
    render(<CardCover src={COVER} alt="Post" />)

    fireEvent.error(screen.getByRole("img"))
    expect(band()).toBeNull()
  })

  it("stays a still for one frame and becomes a gallery for two", () => {
    render(<CardCover src={COVER} alt="Post" images={[COVER]} />)
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Post")
    cleanup()

    render(<CardCover src={COVER} alt="Post" images={[COVER, "https://x/1.jpg"]} />)
    expect(screen.getByRole("img", { name: /image 1 of 2/i })).toBeInTheDocument()
  })

  it("dedupes the frames it is handed — a repeat would collide on its React key", () => {
    render(
      <CardCover src={COVER} alt="Post" images={[COVER, "https://x/1.jpg", COVER]} />
    )

    expect(screen.getByRole("img", { name: /image 1 of 2/i })).toBeInTheDocument()
  })
})

describe("CardCover — a failed cover frame in a gallery (RAD-399)", () => {
  const BAD = "https://x/bad.jpg"
  const GOOD1 = "https://x/good1.jpg"
  const GOOD2 = "https://x/good2.jpg"

  /** The visible cover — the one frame with a non-empty alt. */
  function coverFrame() {
    return screen.getByRole("img")
  }

  it("ERR-1: a failed first frame is dropped and the next frame becomes the cover", () => {
    render(<CardCover src={BAD} alt="Post" images={[BAD, GOOD1, GOOD2]} />)
    expect(coverFrame()).toHaveAttribute("src", BAD)

    fireEvent.error(coverFrame())

    expect(band()).not.toBeNull()
    expect(coverFrame()).toHaveAttribute("src", GOOD1)
    expect(coverFrame()).toHaveAttribute("alt", "Post — image 1 of 2")
  })

  it("ERR-1: when every frame has failed, the band is hidden exactly as today", () => {
    render(<CardCover src={BAD} alt="Post" images={[BAD, GOOD1, GOOD2]} />)

    fireEvent.error(coverFrame())
    expect(band()).not.toBeNull()
    expect(coverFrame()).toHaveAttribute("src", GOOD1)

    fireEvent.error(coverFrame())
    expect(band()).not.toBeNull()
    expect(coverFrame()).toHaveAttribute("src", GOOD2)

    fireEvent.error(coverFrame())
    expect(band()).toBeNull()
  })

  it("with a badge, every frame failing keeps a reserved band carrying the badge", () => {
    render(<CardCover src={BAD} alt="Post" images={[BAD, GOOD1]} badge={<span />} />)

    fireEvent.error(coverFrame())
    fireEvent.error(coverFrame())

    expect(band()).not.toBeNull()
    expect(band().querySelector("img")).toBeNull()
    expect(band().querySelectorAll("[data-video-badge]")).toHaveLength(1)
    expect(band()).toHaveClass("min-h-48")
  })

  it("keeps the reserved height across a promotion until the promoted frame loads", () => {
    render(<CardCover src={BAD} alt="Post" images={[BAD, GOOD1, GOOD2]} />)

    fireEvent.error(coverFrame())
    expect(band()).toHaveClass("min-h-48")

    fireEvent.load(coverFrame())
    expect(band()).not.toHaveClass("min-h-48")
  })

  it("a new cover after a loaded one reserves height again until it loads", () => {
    const { rerender } = render(<CardCover src={GOOD1} alt="Post" images={[GOOD1, GOOD2]} />)
    fireEvent.load(coverFrame())
    expect(band()).not.toHaveClass("min-h-48")

    rerender(<CardCover src={BAD} alt="Post" images={[BAD, GOOD2]} />)
    expect(coverFrame()).toHaveAttribute("src", BAD)
    expect(band()).toHaveClass("min-h-48")

    fireEvent.error(coverFrame())
    expect(coverFrame()).toHaveAttribute("src", GOOD2)
    expect(band()).toHaveClass("min-h-48")

    fireEvent.load(coverFrame())
    expect(band()).not.toHaveClass("min-h-48")
  })

  it("a loaded cover, then a new set of frames that all fail, still shows the badge", () => {
    const { rerender } = render(
      <CardCover src={GOOD1} alt="Post" images={[GOOD1, GOOD2]} badge={<span />} />
    )
    fireEvent.load(coverFrame())

    rerender(<CardCover src={BAD} alt="Post" images={[BAD, "https://x/bad2.jpg"]} badge={<span />} />)
    fireEvent.error(coverFrame())
    fireEvent.error(coverFrame())

    expect(band()).toHaveClass("min-h-48")
    expect(band().querySelectorAll("[data-video-badge]")).toHaveLength(1)
  })
})
