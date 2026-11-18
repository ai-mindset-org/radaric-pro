/** @vitest-environment jsdom */

/**
 * RAD-399 — the list hands a story card the images of every loaded member.
 *
 * Same method as materials-list-card-actions.test.tsx: `MaterialCard` is a
 * fake, and the test asserts the props the list gave it, not the markup the
 * real card would draw (material-card-story-cover.test.tsx owns that).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for card props and Prisma-shaped fixtures */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

/** Every prop set the list renders a card with, in render order. */
const cardProps: any[] = []

vi.mock("@/components/materials/material-card", () => ({
  MaterialCard: (props: any) => {
    cardProps.push(props)
    return (
      <div data-testid={props.story ? "story-card" : "material-card"}>
        {props.story ? props.story.title : props.material.title}
      </div>
    )
  },
}))

import { MaterialsList } from "@/components/materials/materials-list"

const FEED = { id: "feed-a", name: "Alpha Journal", type: "RSS" }

const img = (name: string) => `https://cdn.example.com/${name}.jpg`

function material(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Post ${id}`,
    url: `https://example.com/${id}`,
    content: "body",
    contentEntities: null,
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED",
    aiConfidence: 0.9,
    aiReasoning: null,
    userStatus: "NEW",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    storyId: null,
    story: null,
    feed: FEED,
    ...over,
  } as any
}

function storyOf(count: number) {
  return {
    id: "story-1",
    title: "Sources converge",
    summary: "…",
    createdAt: new Date("2026-09-02T00:00:00Z"),
    _count: { materials: count, inboxItems: 0 },
  }
}

function storyMaterial(story: ReturnType<typeof storyOf>, id: string, over: Record<string, unknown> = {}) {
  return material(id, {
    storyId: story.id,
    story,
    createdAt: new Date("2026-09-02T00:00:00Z"),
    ...over,
  })
}

function renderList(initialMaterials: any[]) {
  return render(
    <MaterialsList
      initialMaterials={initialMaterials}
      totalCount={initialMaterials.length}
      serverCounts={{
        filter: {
          INBOX: initialMaterials.length,
          APPROVED: initialMaterials.length,
          FILTERED: 0,
          SENT_TO_NOTION: 0,
          ARCHIVED: 0,
          ALL: initialMaterials.length,
        },
      }}
    />
  )
}

/** The props of the most recent story-card render. */
function lastStoryCardProps() {
  const storyRenders = cardProps.filter((p) => p.story)
  return storyRenders[storyRenders.length - 1]
}

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

beforeEach(() => {
  cardProps.length = 0
  sessionStorage.clear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ materials: [], total: 0 }) }))
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("materials-list story cell cover (RAD-399)", () => {
  it("AC-7: passes cover.images = every member's images, primary first (P{p1}, Q{q1} → [p1, q1])", async () => {
    const story = storyOf(2)
    renderList([
      storyMaterial(story, "p", { thumbnailUrl: img("p1") }),
      storyMaterial(story, "q", { thumbnailUrl: img("q1") }),
    ])

    await screen.findByTestId("story-card")
    const props = lastStoryCardProps()

    expect(props.material.id).toBe("p")
    expect(props.cover).toEqual({ images: [img("p1"), img("q1")], hasVideo: false })
  })

  it("AC-7: the primary leads even when it is not the first member, the rest follow in story order", async () => {
    const story = storyOf(3)
    // `x` carries an image only in mediaUrls, so the primary (first member with
    // a thumbnail) is `p` — the cover must start with p's frame, not x's.
    renderList([
      storyMaterial(story, "x", { thumbnailUrl: null, mediaUrls: [img("x1")] }),
      storyMaterial(story, "p", { thumbnailUrl: img("p1") }),
      storyMaterial(story, "q", { thumbnailUrl: img("q1") }),
    ])

    await screen.findByTestId("story-card")
    const props = lastStoryCardProps()

    expect(props.material.id).toBe("p")
    const imageOf: Record<string, string> = { x: img("x1"), p: img("p1"), q: img("q1") }
    const othersInStoryOrder = props.storyMaterials
      .map((m: { id: string }) => m.id)
      .filter((id: string) => id !== "p")
    expect([...othersInStoryOrder].sort()).toEqual(["q", "x"])
    expect(props.cover?.images).toEqual([img("p1"), ...othersInStoryOrder.map((id: string) => imageOf[id])])
  })

  it("AC-7: cover.hasVideo follows the cover owner's media", async () => {
    const story = storyOf(2)
    renderList([
      storyMaterial(story, "p", {
        thumbnailUrl: img("poster"),
        mediaUrls: ["https://cdn.example.com/reel.mp4"],
      }),
      storyMaterial(story, "q", { thumbnailUrl: img("q1") }),
    ])

    await screen.findByTestId("story-card")

    expect(lastStoryCardProps().cover).toEqual({
      images: [img("poster"), img("q1")],
      hasVideo: true,
    })
  })
})
