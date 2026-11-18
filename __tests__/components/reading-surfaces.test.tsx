/**
 * @vitest-environment jsdom
 */

/**
 * Reading surfaces — action-rail inventory
 *
 * `/posts/[id]` and `/stories/[id]` were restructured for mobile (frameless
 * canvas below `sm`, icon-only one-row action rail). The rail's controls are
 * now icon-only, so a dropped conditional branch is invisible — a missing
 * button, never an exception. These tests pin the inventory by ACCESSIBLE NAME,
 * which fixes both concerns at once: that every branch still renders, and that
 * every icon-only control still has a name to render it by.
 *
 * Covered branches:
 *   - hasNotionIntegration × userStatus/status === SENT_TO_NOTION (both pages)
 *   - story.notionUrl (open-in-Notion link)
 *   - archived → Restore replaces Archive
 *   - a story with inboxItems and no materials cannot fire the bulk handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

import { MaterialDetailPage } from "@/components/materials/material-detail-page"
import { StoryDetail } from "@/components/stories/story-detail"

const feed = { id: "feed-1", name: "e/acc", type: "TELEGRAM" as const }

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
    aiReasoning: "Because it matches the curator's stated interests.",
    userStatus: "NEW" as const,
    feed,
    feedbacks: [],
    ...overrides,
  }
}

function story(overrides: Record<string, unknown> = {}) {
  return {
    id: "story-1",
    title: "Connectome-based networks",
    languageFlag: null,
    summary: "A summary.",
    body: "First paragraph.\n\nSecond paragraph.",
    keyPoints: ["A takeaway."],
    sourceUrls: ["https://example.com/a"],
    rubrics: ["AI"],
    archiveLinks: null,
    notionPageId: null,
    notionUrl: null,
    status: "DRAFT",
    version: 2,
    createdAt: "2026-09-10T14:52:00Z",
    updatedAt: "2026-09-10T14:52:00Z",
    materials: [{ ...material(), createdAt: "2026-09-09T20:59:00Z" }],
    inboxItems: [],
    ...overrides,
  }
}

/** Accessible name lookup that spans both <button> and <a> controls. */
function control(name: string) {
  return screen.queryByRole("button", { name }) ?? screen.queryByRole("link", { name })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("MaterialDetailPage action rail", () => {
  it("exposes every control when Notion is connected", () => {
    render(<MaterialDetailPage material={material() as never} hasNotionIntegration />)

    for (const name of ["Like", "Not relevant", "Open original", "Archive", "Send to Notion", "Delete"]) {
      expect(control(name), `missing control: ${name}`).toBeTruthy()
    }
  })

  it("hides Send to Notion when the integration is not configured", () => {
    render(<MaterialDetailPage material={material() as never} />)

    expect(control("Send to Notion")).toBeNull()
    expect(control("Open original")).toBeTruthy()
    expect(control("Delete")).toBeTruthy()
  })

  it("hides Send to Notion once the post is already in Notion, and badges it", () => {
    render(
      <MaterialDetailPage material={material({ userStatus: "SENT_TO_NOTION" }) as never} hasNotionIntegration />
    )

    expect(control("Send to Notion")).toBeNull()
    expect(screen.getByText("In Notion")).toBeTruthy()
  })

  it("swaps Archive for Restore on an archived post", () => {
    render(<MaterialDetailPage material={material({ userStatus: "ARCHIVED" }) as never} />)

    expect(control("Archive")).toBeNull()
    expect(control("Restore")).toBeTruthy()
    expect(screen.getByText("Archived")).toBeTruthy()
  })
})

describe("StoryDetail action rail", () => {
  it("exposes every control when Notion is connected and the story is a draft", () => {
    render(
      <StoryDetail
        story={story({ notionUrl: "https://www.notion.so/page" }) as never}
        hasNotionIntegration
      />
    )

    for (const name of ["Like", "Not relevant", "Open in Notion", "Archive", "Send to Notion", "Delete"]) {
      expect(control(name), `missing control: ${name}`).toBeTruthy()
    }
  })

  it("hides both Notion controls when there is no integration and no page", () => {
    render(<StoryDetail story={story() as never} />)

    expect(control("Send to Notion")).toBeNull()
    expect(control("Open in Notion")).toBeNull()
  })

  it("hides Send to Notion once the story is already in Notion", () => {
    render(<StoryDetail story={story({ status: "SENT_TO_NOTION" }) as never} hasNotionIntegration />)

    expect(control("Send to Notion")).toBeNull()
    expect(screen.getByText("In Notion")).toBeTruthy()
  })

  it("disables the bulk actions on a story that has no constituent materials", () => {
    // Telegram-pipeline shape: inbox items, no materials. The bulk handlers map
    // over materialIds, so an empty set would resolve to "0 posts archived".
    render(<StoryDetail story={story({ materials: [] }) as never} />)

    expect(control("Archive")).toBeDisabled()
    expect(control("Delete")).toBeDisabled()
  })

  it("renders every section body", () => {
    render(<StoryDetail story={story() as never} />)

    expect(screen.getByText("A summary.")).toBeTruthy()
    expect(screen.getByText("First paragraph.")).toBeTruthy()
    expect(screen.getByText("A takeaway.")).toBeTruthy()
    // `prettyUrl` (#105) strips the scheme — the source list shows the readable form.
    expect(screen.getByText("example.com/a")).toBeTruthy()
  })
})
