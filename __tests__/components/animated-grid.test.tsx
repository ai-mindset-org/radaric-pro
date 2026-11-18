/**
 * @vitest-environment jsdom
 */

/**
 * RAD-275 — AnimatedGrid.
 *
 * The visual result (do the neighbours start moving on the same frame the card
 * starts fading?) is verified in a real browser — jsdom has no layout engine and
 * no Web Animations API. What's covered here is the wiring around that:
 *
 *   - a departing item is retained, pinned out of flow, and animated
 *   - the reflow is measured from the *layout* delta, so an unrelated re-render
 *     mid-slide can't cancel and restart the animation
 *   - reduced motion drops the transform but keeps the grid working
 *   - no WAAPI (jsdom, old browsers) degrades to instant removal, never a hang
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, act, cleanup } from "@testing-library/react"
import { AnimatedGrid } from "@/components/materials/animated-grid"
import { resetMotionTokens } from "@/lib/motion"

type Item = { key: string; label: string }

const ORIGINAL_RECT = Element.prototype.getBoundingClientRect
const ORIGINAL_ANIMATE = (HTMLElement.prototype as HTMLElement).animate
const ORIGINAL_MATCH_MEDIA = window.matchMedia

/** Positions keyed by data-agkey; anything else (the container) sits at the origin. */
let layout: Record<string, { left: number; top: number }> = {}
/** The container's width — the sidebar opening or closing changes it. */
let containerWidth = 1000

function stubLayout(next: Record<string, { left: number; top: number }>) {
  layout = next
}

function makeRect(left: number, top: number, width = 100, height = 100): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

interface FakeAnimation {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancelled: boolean
  cancel: () => void
  finished: Promise<unknown>
}

let animations: FakeAnimation[] = []
/** Exit animations must not resolve on their own — otherwise the node vanishes mid-assertion. */
let resolveFinished: (() => void) | null = null

function installAnimateStub() {
  HTMLElement.prototype.animate = function (
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ) {
    const animation: FakeAnimation = {
      keyframes,
      options,
      cancelled: false,
      cancel() {
        this.cancelled = true
      },
      finished: new Promise<void>((resolve) => {
        resolveFinished = resolve
      }),
    }
    animations.push(animation)
    return animation as unknown as Animation
  } as unknown as HTMLElement["animate"]
}

function setReducedMotion(matches: boolean) {
  window.matchMedia = (() => ({ matches })) as unknown as typeof window.matchMedia
}

const renderItem = (item: Item) => <span>{item.label}</span>

function renderGrid(items: Item[]) {
  return render(<AnimatedGrid items={items} renderItem={renderItem} className="grid" />)
}

beforeEach(() => {
  animations = []
  resolveFinished = null
  layout = {}
  containerWidth = 1000
  resetMotionTokens()
  setReducedMotion(false)
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = (this as HTMLElement).dataset?.agkey
    if (key && layout[key]) return makeRect(layout[key].left, layout[key].top)
    return makeRect(0, 0, containerWidth, 1000) // the container
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = ORIGINAL_RECT
  HTMLElement.prototype.animate = ORIGINAL_ANIMATE
  window.matchMedia = ORIGINAL_MATCH_MEDIA
  resetMotionTokens()
  vi.restoreAllMocks()
})

describe("AnimatedGrid — rendering", () => {
  it("wraps every item and staggers the enter animation", () => {
    const { container } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])

    const cells = container.querySelectorAll('[data-agstate="live"]')
    expect(cells).toHaveLength(3)
    expect(cells[0].className).toContain("animate-fade-in-scale")
    expect((cells[0] as HTMLElement).style.animationDelay).toBe("0ms")
    expect((cells[1] as HTMLElement).style.animationDelay).toBe("50ms")
    expect((cells[2] as HTMLElement).style.animationDelay).toBe("100ms")
  })

  it("caps the stagger so a long page doesn't trail off", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `${i}` }))
    const { container } = renderGrid(items)
    const cells = container.querySelectorAll<HTMLElement>('[data-agstate="live"]')
    expect(cells[29].style.animationDelay).toBe("500ms")
  })

  it("makes the container a positioning context for the exit layer", () => {
    const { container } = renderGrid([{ key: "a", label: "A" }])
    expect((container.firstElementChild as HTMLElement).className).toContain("relative")
  })
})

describe("AnimatedGrid — exit", () => {
  it("retains a departed item, pins it out of flow, and fades it", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { container, rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])

    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })

    const ghost = container.querySelector<HTMLElement>('[data-agstate="exit"]')
    expect(ghost).not.toBeNull()
    expect(ghost!.dataset.agkey).toBe("a")
    // Out of flow — this is what lets the neighbours close the gap immediately
    // instead of waiting out a timer.
    expect(ghost!.style.position).toBe("absolute")
    expect(ghost!.style.left).toBe("0px")
    expect(ghost!.textContent).toBe("A")
    // Inert and invisible to assistive tech on the way out.
    expect(ghost!.className).toContain("pointer-events-none")
    expect(ghost!.getAttribute("aria-hidden")).toBe("true")

    const exit = animations.find((a) => a.keyframes.some((k) => k.opacity === 0))
    expect(exit).toBeDefined()
    expect(exit!.keyframes[1].transform).toBe("scale(0.85)")
    // Short and decisive — --dur-base, read not copied. It has to clear the frame
    // before the siblings settle, so it must be shorter than the reflow.
    expect(exit!.options.duration).toBe(200)
    const reflow = animations.find((a) => a.keyframes.some((k) => typeof k.transform === "string" && k.transform.startsWith("translate")))
    if (reflow) expect(exit!.options.duration).toBeLessThan(Number(reflow.options.duration))
  })

  it("removes the ghost once its animation finishes", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { container, rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])
    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })
    expect(container.querySelector('[data-agstate="exit"]')).not.toBeNull()

    await act(async () => {
      resolveFinished?.()
    })
    expect(container.querySelector('[data-agstate="exit"]')).toBeNull()
  })

  it("drops a departed item instantly where WAAPI is unavailable", async () => {
    // jsdom's default: no Element.animate. Must not leave a stranded ghost.
    // @ts-expect-error — modelling the unsupported case
    HTMLElement.prototype.animate = undefined
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { container, rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])
    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })

    expect(container.querySelector('[data-agstate="exit"]')).toBeNull()
    expect(container.querySelectorAll('[data-agstate="live"]')).toHaveLength(1)
  })

  it("cancels the exit when a key comes back (a failed optimistic delete)", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const both = [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]
    const { container, rerender } = renderGrid(both)

    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })
    expect(container.querySelector('[data-agstate="exit"]')).not.toBeNull()

    await act(async () => {
      rerender(<AnimatedGrid items={both} renderItem={renderItem} className="grid" />)
    })

    // No ghost lingering behind the restored card.
    expect(container.querySelector('[data-agstate="exit"]')).toBeNull()
    expect(container.querySelectorAll('[data-agstate="live"]')).toHaveLength(2)
  })

  it("animates the exit again after a key has left, returned, and left once more", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const both = [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]
    const only = [{ key: "b", label: "B" }]
    const { container, rerender } = renderGrid(both)

    const leave = async () => {
      await act(async () => {
        rerender(<AnimatedGrid items={only} renderItem={renderItem} className="grid" />)
      })
    }
    const comeBack = async () => {
      await act(async () => {
        rerender(<AnimatedGrid items={both} renderItem={renderItem} className="grid" />)
      })
    }

    await leave()
    await comeBack()
    animations = []
    await leave()

    // Guards the bookkeeping cleanup: the adopted/playing sets must both be
    // released when a key returns, or this second departure is silently skipped
    // and the card vanishes with no animation at all.
    expect(animations.some((a) => a.keyframes.some((k) => k.opacity === 0))).toBe(true)
    expect(container.querySelector('[data-agstate="exit"]')).not.toBeNull()
  })
})

describe("AnimatedGrid — sibling reflow", () => {
  it("plays a survivor's layout change backwards with a translate", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])

    // "a" is deleted, so "b" slides left into its slot.
    stubLayout({ b: { left: 0, top: 0 } })
    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })

    const flip = animations.find((a) => a.keyframes.some((k) => k.transform === "translate(120px, 0px)"))
    expect(flip).toBeDefined()
    expect(flip!.keyframes[1].transform).toBe("none")
    expect(flip!.options.duration).toBe(300)
  })

  it("runs the reflow on the spring where CSS linear() exists", async () => {
    // jsdom has no CSS.supports, so the default path in these tests is the
    // eased fallback. Stub support and the grid should switch to the spring.
    const originalCSS = globalThis.CSS
    globalThis.CSS = { supports: () => true } as unknown as typeof globalThis.CSS
    resetMotionTokens()
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    try {
      const { rerender } = renderGrid([
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ])
      stubLayout({ b: { left: 0, top: 0 } })
      await act(async () => {
        rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
      })

      const flip = animations.find((a) => String(a.options.easing || "").startsWith("linear("))
      expect(flip).toBeDefined()
      // Two keyframes, not a sampled-per-element pile — the curve rides on the easing.
      expect(flip!.keyframes).toHaveLength(2)
      expect(Number(flip!.options.duration)).toBeGreaterThan(300)
    } finally {
      globalThis.CSS = originalCSS
      resetMotionTokens()
    }
  })

  it("falls back to the eased curve where linear() is unsupported", async () => {
    // This is the path jsdom itself takes, so the assertion doubles as a check
    // that the fallback is what these other tests have been exercising.
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])
    stubLayout({ b: { left: 0, top: 0 } })
    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })

    const flip = animations.find((a) => a.keyframes.some((k) => k.transform === "translate(120px, 0px)"))
    expect(flip).toBeDefined()
    expect(String(flip!.options.easing)).toContain("cubic-bezier")
    expect(flip!.options.duration).toBe(300)
  })

  it("leaves a still card alone", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])
    animations = []

    // A re-render that changes nothing about the layout.
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "a", label: "A" },
            { key: "b", label: "B*" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    expect(animations).toHaveLength(0)
  })

  it("does not travel cards when only the container's width changed (sidebar toggle)", async () => {
    // Closing the sidebar widens the grid: every column moves right, and a
    // router refresh re-renders the same items after the width transition.
    // That is not a reorder — sliding each card from its old column made the
    // whole grid jerk and overlap (RAD-408).
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])
    animations = []

    containerWidth = 1300
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 520, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "a", label: "A" },
            { key: "b", label: "B" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    expect(animations).toHaveLength(0)
  })

  it("measures a deletion after a resize from the resized layout", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 }, c: { left: 800, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])

    // The grid widens and re-renders with the same items...
    containerWidth = 1300
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 520, top: 0 }, c: { left: 1040, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "a", label: "A" },
            { key: "b", label: "B" },
            { key: "c", label: "C" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })
    animations = []

    // ...then "a" is deleted: "c" slides from its resized slot, 1040 → 520.
    stubLayout({ b: { left: 0, top: 0 }, c: { left: 520, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "b", label: "B" },
            { key: "c", label: "C" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    expect(animations.some((a) => a.keyframes[0].transform === "translate(520px, 0px)")).toBe(true)
  })

  it("skips the reflow above the survivor cap — a filter switch reads as a clean cut", async () => {
    installAnimateStub()
    const many = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `${i}` }))
    stubLayout(Object.fromEntries(many.map((m, i) => [m.key, { left: i * 100, top: 0 }])))

    const { rerender } = render(
      <AnimatedGrid items={many} renderItem={renderItem} className="grid" maxAnimated={3} />
    )
    animations = []

    stubLayout(Object.fromEntries(many.map((m, i) => [m.key, { left: i * 100 + 40, top: 0 }])))
    await act(async () => {
      rerender(<AnimatedGrid items={many} renderItem={renderItem} className="grid" maxAnimated={3} />)
    })

    expect(animations).toHaveLength(0)
  })

  it("does not travel a card that just entered", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 } })
    const { rerender } = renderGrid([{ key: "a", label: "A" }])
    animations = []

    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "a", label: "A" },
            { key: "b", label: "B" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    // "b" has no previous position — it fades in, it doesn't fly in from nowhere.
    expect(animations).toHaveLength(0)
  })
})

describe("AnimatedGrid — reduced motion", () => {
  it("drops the reflow and keeps the exit to a plain fade", async () => {
    installAnimateStub()
    setReducedMotion(true)
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 120, top: 0 } })

    const { container, rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ])

    stubLayout({ b: { left: 0, top: 0 } })
    await act(async () => {
      rerender(<AnimatedGrid items={[{ key: "b", label: "B" }]} renderItem={renderItem} className="grid" />)
    })

    // Nothing translates.
    expect(animations.some((a) => a.keyframes.some((k) => typeof k.transform === "string"))).toBe(false)

    const exit = animations.find((a) => a.keyframes.some((k) => k.opacity === 0))
    expect(exit).toBeDefined()
    expect(exit!.options.duration).toBe(150) // --dur-fast
    // The grid still works: the survivor is there and the departed card still leaves.
    expect(container.querySelectorAll('[data-agstate="live"]')).toHaveLength(1)
    await act(async () => {
      resolveFinished?.()
    })
    expect(container.querySelector('[data-agstate="exit"]')).toBeNull()
  })
})

describe("AnimatedGrid — resize (RAD-408)", () => {
  /** Callbacks of every ResizeObserver the grid created; fire them to simulate a resize. */
  let observers: ResizeObserverCallback[] = []
  let disconnects: ReturnType<typeof vi.fn>[] = []

  function stubResizeObserver() {
    observers = []
    disconnects = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn()
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback)
          disconnects.push(this.disconnect)
        }
        observe() {}
        unobserve() {}
      }
    )
  }

  async function fireResize() {
    await act(async () => {
      for (const callback of observers) callback([], {} as ResizeObserver)
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("disconnects its observer on unmount", () => {
    stubResizeObserver()
    const { unmount } = renderGrid([{ key: "a", label: "A" }])
    expect(disconnects).toHaveLength(1)
    unmount()
    expect(disconnects[0]).toHaveBeenCalledTimes(1)
  })

  /** Deletes "a" from [a, b, c] so "b" and "c" start sliding; returns the in-flight FLIPs. */
  async function startSlides(rerender: (ui: React.ReactElement) => void) {
    stubLayout({ b: { left: 0, top: 0 }, c: { left: 400, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "b", label: "B" },
            { key: "c", label: "C" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })
    const slides = animations.filter((a) => a.keyframes.some((k) => k.transform?.toString().startsWith("translate")))
    expect(slides).toHaveLength(2)
    return slides
  }

  it("cancels a slide in flight when a commit lands at a new width", async () => {
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 }, c: { left: 800, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])
    const slides = await startSlides(rerender)
    const before = animations.length

    // The sidebar closes mid-slide and the same items re-render at the new width.
    containerWidth = 1300
    stubLayout({ b: { left: 0, top: 0 }, c: { left: 520, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "b", label: "B" },
            { key: "c", label: "C" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    // The old offsets were computed against the old layout — they are dropped,
    // and nothing new starts travelling.
    expect(slides.every((a) => a.cancelled)).toBe(true)
    expect(animations.slice(before).some((a) => a.keyframes.some((k) => k.transform?.toString().startsWith("translate")))).toBe(false)
  })

  it("re-snapshots on a resize between commits, so the next deletion is measured from the resized layout", async () => {
    stubResizeObserver()
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 }, c: { left: 800, top: 0 } })
    const { container, rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])
    expect(observers).toHaveLength(1)

    // The sidebar closes: the grid widens with no React commit at all.
    containerWidth = 1300
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 520, top: 0 }, c: { left: 1040, top: 0 } })
    await fireResize()
    animations = []

    // Then "b" is deleted: "c" slides from its resized slot (1040 → 520), and the
    // ghost is pinned where "b" sat after the resize, not in its old column.
    stubLayout({ a: { left: 0, top: 0 }, c: { left: 520, top: 0 } })
    await act(async () => {
      rerender(
        <AnimatedGrid
          items={[
            { key: "a", label: "A" },
            { key: "c", label: "C" },
          ]}
          renderItem={renderItem}
          className="grid"
        />
      )
    })

    expect(animations.some((a) => a.keyframes[0].transform === "translate(520px, 0px)")).toBe(true)
    const ghost = container.querySelector<HTMLElement>('[data-agstate="exit"]')
    expect(ghost).not.toBeNull()
    expect(ghost!.style.left).toBe("520px")
  })

  it("cancels a slide in flight when the container's width changes between commits", async () => {
    stubResizeObserver()
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 }, c: { left: 800, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])
    const slides = await startSlides(rerender)

    containerWidth = 1300
    stubLayout({ b: { left: 0, top: 0 }, c: { left: 520, top: 0 } })
    await fireResize()

    expect(slides.every((a) => a.cancelled)).toBe(true)
  })

  it("leaves a slide alone when the observer fires without a width change", async () => {
    stubResizeObserver()
    installAnimateStub()
    stubLayout({ a: { left: 0, top: 0 }, b: { left: 400, top: 0 }, c: { left: 800, top: 0 } })
    const { rerender } = renderGrid([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ])
    const slides = await startSlides(rerender)

    // Rows grow as images load: the height changes, the width does not.
    await fireResize()

    expect(slides.some((a) => a.cancelled)).toBe(false)
  })
})
