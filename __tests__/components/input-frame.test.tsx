/**
 * @vitest-environment jsdom
 */

/**
 * The frame `Input` and `Textarea` draw their shape on.
 *
 * WebKit renders no `corner-shape`, so on every iPhone a rounded rectangle is
 * a plain arc unless a mask draws the superellipse — and a mask cannot carry a
 * box-shadow hairline: the ring runs along the square box and the mask cuts its
 * corners off (9 of 31 rays through the corner hit no ring pixel at r = 8,
 * 2026-09-13). The ring that survives is a painted, masked pseudo-element, and
 * a native `<input>` has no pseudo-elements. So the control sits inside a frame
 * that owns the shape.
 *
 * What the 50 call sites rely on is that the frame is invisible to them: the
 * ref, `id` / `htmlFor`, react-hook-form's `register()` spread and `className`
 * all still reach the native element. Only outer sizing moves, and only where a
 * call site asks for it with `wrapperClassName`.
 */

import "@testing-library/jest-dom/vitest"
import { createRef } from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

afterEach(cleanup)

function frameOf(control: HTMLElement) {
  const frame = control.parentElement
  expect(frame, "the control must sit inside a frame").not.toBeNull()
  return frame as HTMLElement
}

describe("Input frame", () => {
  it("wraps the native input in a frame that carries the rung", () => {
    render(<Input aria-label="Search posts" />)
    const frame = frameOf(screen.getByRole("textbox", { name: "Search posts" }))

    expect(frame).toHaveAttribute("data-slot", "field")
    expect(frame).toHaveClass("rounded-sm")
  })

  it("forwards the ref to the native input, not the frame", () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} aria-label="Email" />)

    expect(ref.current).toBeInstanceOf(HTMLInputElement)
    expect(ref.current).toBe(screen.getByRole("textbox", { name: "Email" }))
  })

  it("keeps id, name and aria on the input so a <label htmlFor> still associates", () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" name="email" type="email" aria-describedby="hint" />
      </>
    )
    const input = screen.getByLabelText("Email")

    expect(input.tagName).toBe("INPUT")
    expect(input).toHaveAttribute("name", "email")
    expect(input).toHaveAttribute("aria-describedby", "hint")
  })

  it("routes className to the input and wrapperClassName to the frame", () => {
    render(<Input aria-label="Search" className="pl-9 pr-9" wrapperClassName="flex-1" />)
    const input = screen.getByRole("textbox", { name: "Search" })
    const frame = frameOf(input)

    expect(input).toHaveClass("pl-9", "pr-9")
    expect(input).not.toHaveClass("flex-1")
    expect(frame).toHaveClass("flex-1")
    expect(frame).not.toHaveClass("pl-9")
  })

  it("leaves the paint to the frame, so no box-shadow ring is drawn on the input", () => {
    render(<Input aria-label="Name" />)
    const input = screen.getByRole("textbox", { name: "Name" })

    expect(input.className).not.toMatch(/(^|\s)ring-(1|2|inset)(\s|$)/)
    expect(input.className).not.toMatch(/(^|\s)rounded-(xs|sm|md|lg|xl|2xl)(\s|$)/)
  })

  it("renders a range slider unwrapped — a native track is not a field", () => {
    render(<Input type="range" aria-label="Temperature" />)
    const slider = screen.getByRole("slider", { name: "Temperature" })

    expect(slider.parentElement).not.toHaveAttribute("data-slot", "field")
  })

  it("renders hidden and checkbox inputs unwrapped, with no field paint", () => {
    const { container } = render(
      <>
        <Input type="hidden" name="token" value="t" readOnly />
        <Input type="checkbox" aria-label="Agree" />
      </>
    )

    expect(container.querySelector('[data-slot="field"]')).toBeNull()
    expect(screen.getByRole("checkbox", { name: "Agree" })).not.toHaveClass("bg-secondary")
  })
})

describe("Textarea frame", () => {
  it("wraps the native textarea and forwards ref, id and className", () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(
      <>
        <label htmlFor="note">Note</label>
        <Textarea id="note" ref={ref} className="resize-none" wrapperClassName="mt-2" />
      </>
    )
    const textarea = screen.getByLabelText("Note")
    const frame = frameOf(textarea)

    expect(ref.current).toBe(textarea)
    expect(textarea).toHaveClass("resize-none")
    expect(frame).toHaveAttribute("data-slot", "field")
    expect(frame).toHaveClass("rounded-sm", "mt-2")
    expect(textarea.className).not.toMatch(/(^|\s)ring-(1|2|inset)(\s|$)/)
  })
})
