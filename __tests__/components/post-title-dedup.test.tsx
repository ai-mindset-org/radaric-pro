/**
 * @vitest-environment jsdom
 */

/**
 * Lede-title de-duplication at render time.
 * A derived title (see lib/title.ts) is the opening of `content` — printing
 * both the title and the full content would show the same words twice.
 * MaterialCard excerpts only what follows the derived headline, and
 * MaterialDetailPage shows the same headline as the card and cuts the same
 * opening out of the body (plain text, Telegram entities, or HTML).
 * Spec: RAD-321 (card and post page must agree on the title).
 */

import { describe, it, expect, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, within } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

import { MaterialCard } from "@/components/materials/material-card"
import { MaterialDetailPage } from "@/components/materials/material-detail-page"

const feed = { id: "feed-1", name: "e/acc", type: "TWITTER" as const }

function cardMaterial(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "Goodbye per-seat pricing.",
    url: "https://x.com/user/status/123",
    content: "Goodbye per-seat pricing.\n\nPer-user pricing has always rubbed me the wrong way.",
    publishedAt: new Date("2026-09-09T20:59:00Z"),
    thumbnailUrl: null,
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    userStatus: "NEW" as const,
    feed,
    feedbacks: [],
    ...overrides,
  }
}

function detailMaterial(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "Goodbye per-seat pricing.",
    url: "https://x.com/user/status/123",
    content: "Goodbye per-seat pricing.\n\nPer-user pricing has always rubbed me the wrong way.",
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

describe("MaterialCard — derived-title de-duplication", () => {
  it("AC-8: renders only the part of the content that follows the derived headline", () => {
    render(<MaterialCard material={cardMaterial()} />)

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Goodbye per-seat pricing.")
    expect(
      screen.getByText("Per-user pricing has always rubbed me the wrong way.")
    ).toBeInTheDocument()
    // The headline itself must not also open the excerpt paragraph.
    expect(screen.queryByText(/^Goodbye per-seat pricing\.\s*Per-user pricing/)).not.toBeInTheDocument()
  })

  it("AC-8: renders no excerpt paragraph at all when nothing follows the derived headline", () => {
    const { container } = render(
      <MaterialCard
        material={cardMaterial({ title: "Here we go", content: "Here we go" })}
      />
    )

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Here we go")
    expect(container.querySelectorAll("p")).toHaveLength(0)
  })

  it("AC-8 guard: a real (non-derived) title still gets a full excerpt", () => {
    render(
      <MaterialCard
        material={cardMaterial({
          title: "How Basecamp rethought per-seat pricing",
          content: "Per-user pricing has always rubbed us the wrong way. Here is what we changed…",
        })}
      />
    )

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "How Basecamp rethought per-seat pricing"
    )
    expect(
      screen.getByText(/Per-user pricing has always rubbed us the wrong way\./)
    ).toBeInTheDocument()
  })
})

describe("MaterialDetailPage — derived-title de-duplication", () => {
  it("AC-9: renders the derived title as the visible <h1> and cuts it out of the body", () => {
    const { container } = render(<MaterialDetailPage material={detailMaterial()} />)

    // Same headline the card shows — the two surfaces must agree.
    const heading = screen.getByRole("heading", { level: 1 })
    expect(heading).not.toHaveClass("sr-only")
    expect(heading.textContent).toBe("Goodbye per-seat pricing.")

    // The body must not print the headline's words again — it starts after them.
    const prose = container.querySelector(".prose")
    expect(prose?.textContent?.trim()).toBe(
      "Per-user pricing has always rubbed me the wrong way."
    )
  })

  it("AC-9: cuts a derived title out of a shared HTML paragraph, keeping the paragraph", () => {
    const { container } = render(
      <MaterialDetailPage
        material={detailMaterial({
          title: "Goodbye per-seat pricing.",
          content:
            "<p>Goodbye per-seat pricing. Per-user pricing has always rubbed me the wrong way.</p>",
        })}
      />
    )

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Goodbye per-seat pricing.")
    const prose = container.querySelector(".prose")
    expect(prose?.innerHTML).not.toContain("Goodbye per-seat pricing.")
    expect(prose?.querySelectorAll("p:empty")).toHaveLength(0)
    // The remainder is still a paragraph, so prose-p styling and margins hold.
    expect(prose?.querySelector("p")?.textContent?.trim()).toBe(
      "Per-user pricing has always rubbed me the wrong way."
    )
  })

  it("AC-9: renders no body when the derived title is the whole post", () => {
    const { container } = render(
      <MaterialDetailPage
        material={detailMaterial({ title: "Here we go", content: "Here we go" })}
      />
    )

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Here we go")
    expect(container.querySelector(".prose")?.textContent).toBe("")
  })

  it("AC-9: re-bases Telegram entity offsets onto the body left after the cut", () => {
    const url = "https://example.com/model"
    const content = `Хорошая новость: вышла новая модель.\n\nПодробнее: ${url}`
    const { container } = render(
      <MaterialDetailPage
        material={detailMaterial({
          title: "Хорошая новость: вышла новая модель.",
          content,
          contentEntities: [
            { className: "MessageEntityUrl", offset: content.indexOf(url), length: url.length },
          ],
        })}
      />
    )

    const prose = container.querySelector(".prose")
    expect(prose?.textContent?.trim()).toBe(`Подробнее: ${url}`)
    const link = within(prose as HTMLElement).getByRole("link")
    expect(link).toHaveAttribute("href", url)
    expect(link.textContent).toBe(url)
  })

  it("AC-9 guard: a real (non-derived) title still renders as the <h1> headline", () => {
    render(
      <MaterialDetailPage
        material={detailMaterial({
          title: "How Basecamp rethought per-seat pricing",
          content: "Per-user pricing has always rubbed us the wrong way. Here is what we changed…",
        })}
      />
    )

    const heading = screen.getByRole("heading", { level: 1 })
    expect(heading.textContent).toBe("How Basecamp rethought per-seat pricing")
    expect(heading).not.toHaveClass("sr-only")
    expect(
      screen.getByText(/Per-user pricing has always rubbed us the wrong way\./)
    ).toBeInTheDocument()
  })
})
