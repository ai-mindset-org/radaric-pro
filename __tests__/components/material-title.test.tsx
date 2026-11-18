/** @vitest-environment jsdom */

/**
 * RAD-337 / RAD-365 — a derived headline keeps the link the sentence it came
 * from carried, and nothing else. The body cuts that sentence out
 * (splitDerivedBody), so the headline is the only place a link inside the lede
 * can live; these tests pin that link, the emphasis that must NOT come with
 * it, and the click behavior a clickable card around it depends on.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MaterialTitle } from "@/components/materials/material-title"

afterEach(cleanup)

describe("MaterialTitle", () => {
  it("renders a Telegram entity inside the headline instead of dropping it", () => {
    const title = "Goodbye per-seat pricing."
    const { container } = render(
      <MaterialTitle
        title={title}
        content={`${title}\n\nPer-user pricing follows.`}
        contentEntities={[
          {
            className: "MessageEntityTextUrl",
            offset: 0,
            length: title.length,
            url: "https://example.com/post",
          },
        ]}
      />
    )

    const link = screen.getByRole("link", { name: title })
    expect(link).toHaveAttribute("href", "https://example.com/post")
    expect(link).toHaveAttribute("target", "_blank")
    expect(container.textContent).toBe(title)
  })

  it.each([
    ["MessageEntityBold", "strong"],
    ["MessageEntityItalic", "em"],
    ["MessageEntityUnderline", "u"],
    ["MessageEntityStrike", "s"],
    ["MessageEntityCode", "code"],
  ])("drops a %s entity so the headline reads as plain type", (className, tag) => {
    const title = "Goodbye per-seat pricing."
    const { container } = render(
      <MaterialTitle
        title={title}
        content={`${title}\n\nPer-user pricing follows.`}
        contentEntities={[{ className, offset: 0, length: title.length }]}
      />
    )

    expect(container.querySelector(tag)).toBeNull()
    expect(container.textContent).toBe(title)
  })

  it("keeps the headline's link when the same words are bolded", () => {
    const title = "Goodbye per-seat pricing."
    const { container } = render(
      <MaterialTitle
        title={title}
        content={`${title}\n\nPer-user pricing follows.`}
        contentEntities={[
          { className: "MessageEntityBold", offset: 0, length: title.length },
          {
            className: "MessageEntityTextUrl",
            offset: title.indexOf("per-seat"),
            length: "per-seat".length,
            url: "https://example.com/post",
          },
        ]}
      />
    )

    const link = screen.getByRole("link", { name: "per-seat" })
    expect(link).toHaveAttribute("href", "https://example.com/post")
    expect(container.querySelector("strong")).toBeNull()
    expect(container.textContent).toBe(title)
  })

  it("renders an HTML headline's link with the stored title's own words", () => {
    const html =
      '<p><a href="https://example.com/post">Goodbye per-seat pricing.</a> Per-user pricing follows.</p>'
    const { container } = render(<MaterialTitle title="Goodbye per-seat pricing." content={html} />)

    const link = screen.getByRole("link", { name: "Goodbye per-seat pricing." })
    expect(link).toHaveAttribute("href", "https://example.com/post")
    expect(container.textContent).toBe("Goodbye per-seat pricing.")
  })

  it("keeps a spoiler's words readable in the headline", () => {
    // The compact spoiler renders as a non-interactive text-transparent mask,
    // and the body has this sentence cut — masking it would hide the words for
    // good, so the headline drops the class and shows the plain text.
    const title = "Spoilers ahead: the ship sinks in the end."
    const { container } = render(
      <MaterialTitle
        title={title}
        content={`${title}\n\nMore follows.`}
        contentEntities={[
          {
            className: "MessageEntitySpoiler",
            offset: title.indexOf("the ship sinks"),
            length: "the ship sinks".length,
          },
        ]}
      />
    )

    expect(container.textContent).toBe(title)
    expect(container.querySelector("[aria-hidden='true'], .text-transparent")).toBeNull()
  })

  it("stops a headline link's click from reaching a surrounding card handler", async () => {
    const html =
      '<p><a href="https://example.com/post">Goodbye per-seat pricing.</a> Per-user pricing follows.</p>'
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <MaterialTitle title="Goodbye per-seat pricing." content={html} />
      </div>
    )

    await userEvent.click(screen.getByRole("link", { name: "Goodbye per-seat pricing." }))
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it("lets a click on an anchor without an href reach the card (RAD-367)", async () => {
    // A bare name anchor (a footnote marker in an article lede) survives
    // sanitizing without an href: dead text that must not swallow the card's click.
    const html =
      '<p><a name="fn1">Goodbye per-seat pricing.</a> Per-user pricing follows.</p>'
    const onCardClick = vi.fn()
    const { container } = render(
      <div onClick={onCardClick}>
        <MaterialTitle title="Goodbye per-seat pricing." content={html} />
      </div>
    )

    const anchor = container.querySelector("a:not([href])")
    expect(anchor).not.toBeNull()
    await userEvent.click(anchor as HTMLElement)
    expect(onCardClick).toHaveBeenCalledTimes(1)
    // …and does not wear the link treatment: the styling targets a[href] only.
    const wrapper = anchor!.closest("span") as HTMLElement
    expect(wrapper.className).toContain("[&_a[href]]:link")
    expect(wrapper.className).not.toMatch(/\[&_a\]:/)
  })

  it("leaves a derived headline with no formatting as plain text", () => {
    render(
      <MaterialTitle
        title="Goodbye per-seat pricing."
        content={"Goodbye per-seat pricing.\n\nPer-user pricing follows."}
      />
    )

    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("Goodbye per-seat pricing.")).toBeInTheDocument()
  })

  it("leaves a hand-written headline untouched", () => {
    render(
      <MaterialTitle
        title="A real headline of its own"
        content="Intro text. More."
        contentEntities={[{ className: "MessageEntityBold", offset: 0, length: 5 }]}
      />
    )

    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("A real headline of its own")).toBeInTheDocument()
  })
})
