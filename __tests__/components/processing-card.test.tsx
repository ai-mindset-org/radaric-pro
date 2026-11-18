/** @vitest-environment jsdom */

/**
 * RAD-318 Phase 4 — the processing card.
 *
 * Its height contract and its announcement discipline are the two things that
 * can hurt the rest of the screen, so both are asserted here rather than left
 * to a browser pass: a card that grows re-animates every visible sibling, and a
 * log that announces makes the whole grid unusable with a screen reader.
 */

import { describe, it, expect, vi, beforeAll } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProcessingCard } from "@/components/materials/processing-card"
import {
  initialProcessingState,
  processingReducer,
  LOG_LIMIT,
  type ProcessingState,
  type ProcessingAction,
} from "@/lib/materials/processing-state"

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

const SOURCES = [
  { id: "a", name: "Alpha Journal" },
  { id: "b", name: "Beta Weekly" },
  { id: "c", name: "Gamma Telegram" },
]

/** Build real state by replaying real actions — never by hand-writing a shape. */
function reduce(actions: (state: ProcessingState) => ProcessingAction[]): ProcessingState {
  let state = initialProcessingState
  for (const action of actions(state)) state = processingReducer(state, action)
  return state
}

function running(): ProcessingState {
  return reduce(s => [
    { type: "START", kind: "parse", scope: { sourceId: null, view: "INBOX" }, at: 1000 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "parse_start", sourceCount: 3, sources: SOURCES }, at: 1001 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "source_start", sourceId: "a", sourceName: "Alpha Journal" }, at: 1002 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "items_fetched", sourceId: "a", count: 20 }, at: 1003 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "material_created", sourceId: "a", material: { id: "m1", aiEvaluation: "APPROVED" } }, at: 1004 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "material_created", sourceId: "a", material: { id: "m2", aiEvaluation: "FILTERED" } }, at: 1005 },
    { type: "PARSE_EVENT", generation: s.generation + 1, event: { type: "source_complete", sourceId: "a", sourceName: "Alpha Journal", stats: { approved: 1, filtered: 1 } }, at: 1006 },
  ])
}

function finished(outcome: "success" | "stopped" = "success"): ProcessingState {
  const base = running()
  if (outcome === "stopped") return processingReducer(base, { type: "STOP", generation: base.generation, at: 2000 })
  return processingReducer(base, {
    type: "PARSE_EVENT",
    generation: base.generation,
    event: { type: "parse_complete", results: { approved: 1, filtered: 1, errors: [] } },
    at: 2000,
  })
}

function setup(state: ProcessingState) {
  const onStop = vi.fn()
  const onDismiss = vi.fn()
  const view = render(<ProcessingCard state={state} onStop={onStop} onDismiss={onDismiss} />)
  return { ...view, onStop, onDismiss, user: userEvent.setup() }
}

describe("the height contract", () => {
  it("is the same fixed budget running, expanded and finished", async () => {
    const { user, rerender } = setup(running())
    const card = screen.getByTestId("processing-card")
    const budget = "min-h-[300px]"

    expect(card.className).toContain(budget)
    // Never a fixed `height`: 200% text zoom has to be able to grow the card.
    expect(card.className).not.toMatch(/(^|\s)h-\[/)

    await user.click(screen.getByRole("button", { name: /show details/i }))
    expect(screen.getByTestId("processing-card").className).toContain(budget)

    rerender(<ProcessingCard state={finished()} onStop={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByTestId("processing-card").className).toContain(budget)
  })

  it("scrolls the log inside its own child, not by growing the card", async () => {
    const { user } = setup(running())
    await user.click(screen.getByRole("button", { name: /show details/i }))

    const log = screen.getByRole("list").parentElement!
    expect(log.className).toContain("overflow-y-auto")
    // The masked Card host must never be overflow-hidden — it would clip the mask.
    expect(screen.getByTestId("processing-card").className).not.toContain("overflow-hidden")
  })

  it("uses the standard card surface, never a paint behind the mask", () => {
    setup(running())
    const card = screen.getByTestId("processing-card")
    expect(card.getAttribute("style") ?? "").not.toContain("--surface-bg")
    expect(card.className).not.toContain("bg-muted")
  })
})

describe("what it says", () => {
  it("summarises the run in one announced, atomic line", () => {
    setup(running())
    const summary = screen.getByTestId("processing-summary")

    expect(summary).toHaveAttribute("aria-live", "polite")
    expect(summary).toHaveAttribute("aria-atomic", "true")
    expect(summary).toHaveTextContent("1 of 3 sources processed")
  })

  it("rolls the numbers under a hidden copy, and announces the sentence once", () => {
    // RAD-355: the visible copy carries the per-digit numbers (NumberFlow
    // exposes the digits individually inside its shadow DOM), so it is
    // aria-hidden and the plain twin is the announced sentence. Where a roll
    // cannot run — jsdom here, reduced motion, an old engine — the same markup
    // renders plain text and the announcement is unchanged.
    setup(running())
    const summary = screen.getByTestId("processing-summary")
    const visible = summary.querySelector("[aria-hidden='true']")
    const announced = summary.querySelector(".sr-only")

    expect(visible).toHaveTextContent("1 of 3 sources processed · 0 active")
    expect(announced).toHaveTextContent("1 of 3 sources processed · 0 active")
    // The numbers are their own elements in the visible copy, never part of the
    // announced one (which must stay text a screen reader reads as a sentence).
    expect(visible!.querySelectorAll("span")).toHaveLength(3)
    expect(announced!.querySelectorAll("span")).toHaveLength(0)
  })

  it("distinguishes posts created from posts the filter approved", () => {
    setup(running())
    const posts = screen.getByText("New posts").parentElement!
    const approved = screen.getByText("AI approved").parentElement!

    // Two materials streamed, one of each evaluation: rendering `collected`
    // in both slots would satisfy a 1-vs-1 fixture, so the second number has
    // to differ from the first for this test to distinguish anything.
    expect(posts).toHaveTextContent("2")
    expect(approved).toHaveTextContent("1")
  })

  it("shows no parse counters on a grouping or re-filter run", () => {
    // A phase run never populates `sources`, so the pair would read
    // "New posts 0 · AI approved 0" directly beneath the result sentence that
    // already carries the numbers ("Re-filtered · 2 approved, 1 filtered").
    let state = reduce(() => [
      { type: "START", kind: "refilter", scope: { sourceId: null, view: "INBOX" }, at: 3000 },
    ])
    state = processingReducer(state, {
      type: "PHASE_EVENT",
      generation: state.generation,
      kind: "refilter",
      event: { type: "complete", flippedToApproved: 2, flippedToFiltered: 1 },
      at: 3001,
    })
    setup(state)

    expect(screen.getByText(/re-filtered · 2 approved, 1 filtered/i)).toBeInTheDocument()
    expect(screen.queryByText("New posts")).toBeNull()
    expect(screen.queryByText("AI approved")).toBeNull()
  })

  it("keeps the parse counters while the auto-grouping phase runs", () => {
    // The auto-group that follows a parse is the SAME run: the reducer keeps
    // `kind: "parse"` across the phase start (`state.kind ?? kind`), and the
    // counters have to survive it — the pair describes the parse that just
    // happened, and grouping only refines it.
    const base = finished()
    const grouping = processingReducer(base, {
      type: "PHASE_EVENT",
      generation: base.generation,
      kind: "group",
      event: { type: "start", total: 2 },
      at: 3000,
    })
    setup(grouping)

    expect(screen.getByText("New posts")).toBeInTheDocument()
    expect(screen.getByText("AI approved")).toBeInTheDocument()
  })

  it("gives progress a textual equivalent, not only a bar", () => {
    setup(running())
    const bar = screen.getByRole("progressbar", { name: /sources processed/i })

    expect(bar).toHaveAttribute("aria-valuetext", "1 of 3")
    expect(bar).toHaveAttribute("aria-valuemax", "3")
    expect(bar).toHaveAttribute("aria-valuemin", "0")
    expect(bar).toHaveAttribute("aria-valuenow", "1")
  })

  it("paints the bar's fill at the run's proportion", () => {
    // RAD-356 replaced the native <progress> with divs (a designed track), so the
    // proportion is now ours to get wrong: value/max is the fill's width, clamped.
    setup(running())
    const fill = screen.getByTestId("processing-progress-fill")

    // The fixture settles 1 of 3 sources.
    expect(fill.style.width).toBe(`${(1 / 3) * 100}%`)
  })

  it("falls back to indeterminate activity before the manifest arrives", () => {
    const state = reduce(s => [
      { type: "START", kind: "parse", scope: { sourceId: null, view: "INBOX" }, at: 1 },
    ])
    setup(state)

    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByText(/preparing/i)).toBeInTheDocument()
  })

  it("names the terminal outcome rather than leaving the running title", () => {
    const { rerender } = setup(finished())
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Done")

    rerender(<ProcessingCard state={finished("stopped")} onStop={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Stopped")
    expect(screen.getByText(/stopped · 1 of 3 sources processed/i)).toBeInTheDocument()
  })

  it("surfaces a run-level error payload instead of showing nothing", () => {
    const base = running()
    const state = processingReducer(base, {
      type: "PARSE_EVENT",
      generation: base.generation,
      // The subscription gate sends `error`, not `message`.
      event: { type: "error", error: "Subscription required" },
      at: 3000,
    })
    setup(state)

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/finished with problems|could not finish/i)
    expect(screen.getByText(/subscription required/i)).toBeInTheDocument()
  })
})

describe("the log", () => {
  it("is not announced — a plain list, never role=log", async () => {
    const { user } = setup(running())
    await user.click(screen.getByRole("button", { name: /show details/i }))

    const log = screen.getByRole("list").parentElement!
    expect(log).toHaveAttribute("aria-live", "off")
    expect(screen.queryByRole("log")).toBeNull()
  })

  it("stays closed until the user asks, so a streamed event cannot open it", () => {
    setup(running())
    expect(screen.queryByRole("list")).toBeNull()
    expect(screen.getByRole("button", { name: /show details/i })).toHaveAttribute("aria-expanded", "false")
  })

  it("discloses that older detail is omitted once the buffer is full", async () => {
    let state = running()
    for (let i = 0; i < LOG_LIMIT + 20; i++) {
      state = processingReducer(state, {
        type: "PARSE_EVENT",
        generation: state.generation,
        event: { type: "items_fetched", sourceId: "b", sourceName: "Beta Weekly", count: i + 1 },
        at: 5000 + i,
      })
    }
    const { user } = setup(state)
    await user.click(screen.getByRole("button", { name: /full log/i }))

    expect(await screen.findByText(new RegExp(`${LOG_LIMIT} most recent entries`, "i"))).toBeInTheDocument()
  })

  it("collapses repeated terminal errors instead of filling the buffer with one message", () => {
    let state = running()
    for (let i = 0; i < 5; i++) {
      state = processingReducer(state, {
        type: "PARSE_EVENT",
        generation: state.generation,
        event: { type: "error", sourceId: `x${i}`, sourceName: `Source ${i}`, message: "Feed timed out" },
        at: 6000 + i,
      })
    }
    expect(state.log.filter(l => l.message === "Feed timed out")).toHaveLength(1)
  })
})

describe("controls", () => {
  it("offers Stop while running and Dismiss once terminal, never both", async () => {
    const { user, onStop, rerender, onDismiss } = setup(running())

    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull()
    await user.click(screen.getByRole("button", { name: /stop processing/i }))
    expect(onStop).toHaveBeenCalled()

    rerender(<ProcessingCard state={finished()} onStop={onStop} onDismiss={onDismiss} />)
    expect(screen.queryByRole("button", { name: /stop processing/i })).toBeNull()
    await user.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it("does not mark a stopped or partial run with the success check", () => {
    // A green check beside "Stopped" reads as "it finished", which is the one
    // thing a stopped run did not do.
    const { container, rerender } = setup(finished("stopped"))
    const stopped = container.querySelector("h2")!.parentElement!.querySelector("svg")!
    expect(stopped.getAttribute("class")).toContain("text-muted-foreground")

    rerender(<ProcessingCard state={finished()} onStop={vi.fn()} onDismiss={vi.fn()} />)
    const done = container.querySelector("h2")!.parentElement!.querySelector("svg")!
    expect(done.getAttribute("class")).toContain("text-primary")
  })

  it("moves focus to the status heading when the user stops, not to a vanished button", async () => {
    const { user, rerender } = setup(running())
    await user.click(screen.getByRole("button", { name: /stop processing/i }))
    rerender(<ProcessingCard state={finished("stopped")} onStop={vi.fn()} onDismiss={vi.fn()} />)

    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }))
  })

  it("leaves focus alone when a run ends on its own", async () => {
    // The automatic first parse settles about a minute after the user lands on
    // /posts. Pulling focus to the card then would take them out of the search
    // field mid-word and send the rest of their typing nowhere — unsolicited
    // focus movement (WCAG 3.2.1), and lost input on top of it.
    const { rerender } = setup(running())
    const outside = document.createElement("input")
    document.body.appendChild(outside)
    outside.focus()

    rerender(<ProcessingCard state={finished("success")} onStop={vi.fn()} onDismiss={vi.fn()} />)

    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it("puts every card control on the 44px floor on mobile", () => {
    setup(running())
    for (const name of [/stop processing/i, /show details/i, /full log/i]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-[44px]")
    }
  })
})

describe("the observed first run", () => {
  /**
   * The server owns this run. The card watches it and receives no per-source
   * frames, which makes every counter structurally zero — so the card must not
   * show counters, and must not offer a control that cannot do what it says.
   */
  function observedRunning(): ProcessingState {
    return processingReducer(initialProcessingState, {
      type: "START",
      kind: "parse",
      scope: { sourceId: null, view: "INBOX" },
      observed: true,
      expectedSources: 5,
      at: 1000,
    })
  }

  function observedDone(): ProcessingState {
    const base = observedRunning()
    return processingReducer(base, {
      type: "PARSE_EVENT",
      generation: base.generation,
      event: { type: "parse_complete", results: {} },
      at: 2000,
    })
  }

  it("offers no Stop, because nothing client-side can stop it", () => {
    setup(observedRunning())

    // `POST /api/parse` carries no AbortSignal and there is no stream to close:
    // the ingestion continues regardless. A Stop here would only mark the card
    // "Stopped" and cost the user the completion refresh.
    expect(screen.queryByRole("button", { name: /stop processing/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull()
  })

  it("shows no counters it cannot back up", () => {
    setup(observedRunning())
    expect(screen.queryByText("New posts")).toBeNull()
    expect(screen.queryByText("AI approved")).toBeNull()
  })

  it("does not claim zero posts on a run that just filled the grid", () => {
    setup(observedDone())
    expect(screen.queryByText(/collected 0 posts/i)).toBeNull()
    expect(screen.queryByText("New posts")).toBeNull()
  })

  it("offers Dismiss once it is over", () => {
    setup(observedDone())
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument()
  })
})

describe("a rate-limited run (RAD-326)", () => {
  it("reads as not started — not a failure, not a lost connection — and says when to retry", () => {
    const state = reduce(s => [
      { type: "START", kind: "parse", scope: { sourceId: null, view: "INBOX" }, at: 1000 },
      {
        type: "PARSE_EVENT",
        generation: s.generation + 1,
        event: { type: "error", code: "RATE_LIMITED", retryAfter: 42, error: "Too many requests — try again in 42s" },
        at: 1001,
      },
    ])
    setup(state)

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Not started")
    expect(screen.getByTestId("processing-summary")).toHaveTextContent("Too many requests — try again in 42s")
    const card = screen.getByTestId("processing-card")
    expect(card).not.toHaveTextContent(/connection|could not finish/i)
    expect(card.querySelector(".text-destructive")).toBeNull()
    // Finished, so the card can be dismissed rather than stopped.
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument()
  })
})

describe("a run refused for sign-in or email verification (RAD-406)", () => {
  const refused = (code: string) =>
    reduce(s => [
      { type: "START", kind: "parse", scope: { sourceId: null, view: "INBOX" }, at: 1000 },
      {
        type: "PARSE_EVENT",
        generation: s.generation + 1,
        event: { type: "error", code, error: `copy for ${code}` },
        at: 1001,
      },
    ])

  it("says the session ended and offers the way back in — not a failure, not a lost connection", () => {
    setup(refused("UNAUTHORIZED"))

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Signed out")
    expect(screen.getByTestId("processing-summary")).toHaveTextContent(/sign in again/i)
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/signup")
    const card = screen.getByTestId("processing-card")
    expect(card).not.toHaveTextContent(/connection|could not finish/i)
    expect(card.querySelector(".text-destructive")).toBeNull()
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument()
  })

  it("says the email needs verifying and points at the resend action", () => {
    setup(refused("EMAIL_NOT_VERIFIED"))

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Email not verified")
    expect(screen.getByTestId("processing-summary")).toHaveTextContent(/verify your email.*resend/i)
    const card = screen.getByTestId("processing-card")
    expect(card).not.toHaveTextContent(/connection|could not finish/i)
    expect(card.querySelector(".text-destructive")).toBeNull()
    // Signing in again would not help; the sign-in link is for the other refusal.
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull()
  })
})
