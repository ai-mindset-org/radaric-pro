/**
 * @vitest-environment jsdom
 */

/**
 * RAD-345 — the card's open behaviour.
 *
 * The list tests replace `material-card` with a fake, so this is the only file
 * that exercises the real card: which gesture goes to the peek, which one opens
 * the canonical page in a new tab, and that the no-peek path is exactly what it
 * always was. `window.open` is stubbed — jsdom's own is a no-op that would make
 * a "router.push was not called" assertion pass vacuously.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

import { MaterialCard } from "@/components/materials/material-card"

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "Connectome demos",
    url: "https://t.me/example/12345",
    content: "Plain body copy.",
    publishedAt: new Date("2026-09-09T20:59:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "e/acc", type: "TELEGRAM" as const },
    feedbacks: [],
    ...overrides,
  }
}

/** The card itself is the first role="button" in DOM order — its utilities are nested. */
function cardEl() {
  return screen.getAllByRole("button")[0]
}

beforeEach(() => {
  push.mockClear()
  vi.stubGlobal("open", vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("MaterialCard open behaviour", () => {
  it("hands a plain click to the peek when the list provides onOpen", () => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} />)

    fireEvent.click(cardEl())

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toBe("post")
    expect(onOpen.mock.calls[0][1]).toBe("mat-1")
    // The origin element travels with the call so focus can return to it.
    expect(onOpen.mock.calls[0][2]).toBe(cardEl())
    expect(push).not.toHaveBeenCalled()
  })

  it("hands a plain click on a story cell the story id and kind", () => {
    const onOpen = vi.fn()
    const story = {
      id: "story-1",
      title: "A story",
      summary: "s",
      rubrics: [],
      sourceUrls: [],
      status: "DRAFT",
      version: 1,
      createdAt: "2026-09-10T14:52:00Z",
    }
    render(<MaterialCard material={material()} story={story} onOpen={onOpen} />)

    fireEvent.click(cardEl())

    expect(onOpen).toHaveBeenCalledWith("story", "story-1", expect.anything())
  })

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
  ])("opens the canonical page in a new tab on a %s-click, in drawer mode", (_name, modifiers) => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} />)

    fireEvent.click(cardEl(), modifiers)

    expect(window.open).toHaveBeenCalledWith("/posts/mat-1", "_blank", "noopener,noreferrer")
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("opens the canonical page in a new tab on a middle click (auxclick)", () => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} />)

    fireEvent(cardEl(), new MouseEvent("auxclick", { bubbles: true, button: 1 }))

    expect(window.open).toHaveBeenCalledWith("/posts/mat-1", "_blank", "noopener,noreferrer")
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("RAD-360: lets a middle click on the Open original link open the external URL", () => {
    const onOpen = vi.fn()
    const m = material()
    render(<MaterialCard material={m} onOpen={onOpen} />)

    const link = screen.getByRole("link", { name: "Open original" })
    expect(link).toHaveAttribute("href", m.url)

    // `cancelable: true` so `preventDefault()` is observable: without it the
    // handler's call is a no-op and a hijack would pass unnoticed.
    const event = new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true })
    fireEvent(link, event)

    // The card's auxclick handler must exempt events that originated inside a
    // nested link, leaving the browser's own middle-click default (open the
    // anchor's href) intact.
    expect(event.defaultPrevented).toBe(false)
    expect(window.open).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps today's navigation when the list provides no onOpen", () => {
    render(<MaterialCard material={material()} />)

    fireEvent.click(cardEl())

    expect(push).toHaveBeenCalledWith("/posts/mat-1")
  })

  it("keeps today's story navigation when the list provides no onOpen", () => {
    const story = {
      id: "story-1",
      title: "A story",
      summary: "s",
      rubrics: [],
      sourceUrls: [],
      status: "DRAFT",
      version: 1,
      createdAt: "2026-09-10T14:52:00Z",
    }
    render(<MaterialCard material={material()} story={story} />)

    fireEvent.click(cardEl())

    expect(push).toHaveBeenCalledWith("/stories/story-1")
  })

  it("activates the card from the keyboard — Enter and Space", () => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} />)

    fireEvent.keyDown(cardEl(), { key: "Enter" })
    fireEvent.keyDown(cardEl(), { key: " " })

    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it("ignores key events bubbling from a nested utility button", () => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} onArchive={vi.fn()} />)

    const archive = screen.getByRole("button", { name: "Archive" })
    fireEvent.keyDown(archive, { key: "Enter" })

    expect(onOpen).not.toHaveBeenCalled()
  })

  it("does not open the peek from a nested utility button's click", () => {
    const onOpen = vi.fn()
    render(<MaterialCard material={material()} onOpen={onOpen} onArchive={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    expect(onOpen).not.toHaveBeenCalled()
  })
})
