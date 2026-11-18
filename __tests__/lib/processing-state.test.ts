/**
 * RAD-318 Phase 2 — the processing reducer.
 *
 * The acceptance matrix's load-bearing row lives here: "against a fixed
 * interleaved event script, the summary text matches
 * /^\d+ of 5 sources processed · \d+ active$/ after every event, the processed
 * number never decreases, and it reaches 5 of 5 exactly once."
 */

import { describe, it, expect } from "vitest"
import {
  processingReducer,
  initialProcessingState,
  summaryText,
  processedCount,
  activeCount,
  collectedCount,
  approvedCount,
  logTruncated,
  LOG_LIMIT,
  type ProcessingState,
  type ProcessingAction,
  type ParseEvent,
} from "@/lib/materials/processing-state"

const SCOPE = { sourceId: null, view: "INBOX" }

function start(state = initialProcessingState): ProcessingState {
  return processingReducer(state, { type: "START", kind: "parse", scope: SCOPE, at: 0 })
}

function feed(state: ProcessingState, events: ParseEvent[]): ProcessingState {
  return events.reduce(
    (s, event) => processingReducer(s, { type: "PARSE_EVENT", generation: s.generation, event, at: 0 }),
    state
  )
}

const manifest = (n: number): ParseEvent => ({
  type: "parse_start",
  sourceCount: n,
  sources: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: `Source ${i + 1}` })),
})

describe("run lifecycle", () => {
  it("reserves the run synchronously, before any network work", () => {
    const s = start()
    expect(s.phase).toBe("preparing")
    expect(s.generation).toBe(1)
    expect(s.outcome).toBeNull()
    expect(summaryText(s)).toBe("Preparing…")
  })

  it("takes its denominator from the manifest, not from arriving events", () => {
    const s = feed(start(), [manifest(5)])
    expect(s.manifestKnown).toBe(true)
    expect(s.sources).toHaveLength(5)
    expect(summaryText(s)).toBe("0 of 5 sources processed · 0 active")
  })

  it("terminates a zero-source run with an explanation rather than hanging", () => {
    const s = feed(start(), [manifest(0), { type: "parse_complete", results: { errors: [] } }])
    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("success")
    expect(summaryText(s)).toBe("No sources to process")
  })
})

describe("five concurrent sources — interleaved events from a real parse run", () => {
  const SCRIPT: ParseEvent[] = [
    manifest(5),
    { type: "source_start", sourceId: "s1", sourceName: "Source 1" },
    { type: "source_start", sourceId: "s2", sourceName: "Source 2" },
    { type: "source_start", sourceId: "s3", sourceName: "Source 3" },
    { type: "items_fetched", sourceId: "s1", count: 4 },
    { type: "material_created", sourceId: "s1", material: { id: "m1" } },
    { type: "source_start", sourceId: "s4", sourceName: "Source 4" },
    { type: "source_complete", sourceId: "s2", sourceName: "Source 2", stats: { approved: 1, filtered: 1 } },
    { type: "material_created", sourceId: "s3", material: { id: "m2" } },
    { type: "source_start", sourceId: "s5", sourceName: "Source 5" },
    { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 2, filtered: 0 } },
    { type: "error", sourceId: "s4", sourceName: "Source 4", message: "RSS fetch failed" },
    { type: "source_complete", sourceId: "s3", sourceName: "Source 3", stats: { approved: 0, filtered: 3 } },
    { type: "source_complete", sourceId: "s5", sourceName: "Source 5", stats: { approved: 1, filtered: 0 } },
  ]

  it("keeps the summary well-formed after every single event", () => {
    let state = feed(start(), [SCRIPT[0]])
    const seen: number[] = [processedCount(state)]

    for (const event of SCRIPT.slice(1)) {
      state = feed(state, [event])
      expect(summaryText(state)).toMatch(/^\d+ of 5 sources processed · \d+ active$/)
      seen.push(processedCount(state))
    }

    // Monotonic: a settled source never un-settles.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    // Reaches the denominator exactly once.
    expect(seen.filter(n => n === 5)).toHaveLength(1)
    expect(seen[seen.length - 1]).toBe(5)
  })

  it("counts a failed source as processed and lets the others finish", () => {
    const state = feed(start(), SCRIPT)
    expect(processedCount(state)).toBe(5)
    expect(activeCount(state)).toBe(0)
    expect(state.sources.find(s => s.id === "s4")).toMatchObject({ state: "failed", error: "RSS fetch failed" })
    expect(state.sources.filter(s => s.state === "done")).toHaveLength(4)
  })

  it("settles each source exactly once — a duplicate terminal event is inert", () => {
    let state = feed(start(), SCRIPT)
    const before = { processed: processedCount(state), approved: state.sources.find(s => s.id === "s1")!.approved }

    state = feed(state, [
      { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 99, filtered: 99 } },
      { type: "error", sourceId: "s4", sourceName: "Source 4", message: "again" },
    ])

    expect(processedCount(state)).toBe(before.processed)
    expect(state.sources.find(s => s.id === "s1")!.approved).toBe(before.approved)
    expect(state.errors.filter(e => e === "again")).toHaveLength(0)
  })

  it("deduplicates materials by id", () => {
    const state = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "dup" } },
      { type: "material_created", sourceId: "s1", material: { id: "dup" } },
      { type: "material_created", sourceId: "s1", material: { id: "other" } },
    ])
    expect(state.createdIds).toEqual(["dup", "other"])
    expect(collectedCount(state)).toBe(2)
  })

  it("counts approved posts live, from the evaluation each material arrives with", () => {
    const state = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
      { type: "material_created", sourceId: "s1", material: { id: "m2", aiEvaluation: "FILTERED" } },
      { type: "material_created", sourceId: "s1", material: { id: "m3", aiEvaluation: "APPROVED" } },
    ])
    expect(collectedCount(state)).toBe(3)
    expect(approvedCount(state)).toBe(2)
  })

  it("does not let a re-announced material count twice as approved", () => {
    const state = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
    ])
    expect(approvedCount(state)).toBe(1)
  })

  it("prefers the server's authoritative totals once parse_complete lands", () => {
    const state = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1" } },
      { type: "parse_complete", results: { approved: 7, filtered: 3, errors: [] } },
    ])
    // Not the 1 streamed id — the server reconciled 10.
    expect(collectedCount(state)).toBe(10)
    expect(approvedCount(state)).toBe(7)
  })

  it("does not treat fetched items as newly collected posts", () => {
    const state = feed(start(), [manifest(1), { type: "items_fetched", sourceId: "s1", count: 40 }])
    // The count survives only in the log — nothing on the source tracks it, so
    // the run cannot report read items as produced posts anywhere.
    expect(state.log.at(-1)?.message).toBe("Fetched 40 items")
    expect(collectedCount(state)).toBe(0)
    expect(approvedCount(state)).toBe(0)
  })

  it("lets the server's total lower the approved count, not only raise it", () => {
    // The interest path used to report created materials as approved, so the
    // live count could exceed the reconciled one. The override has to win in
    // both directions or the card keeps the inflated number.
    let state = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
      { type: "material_created", sourceId: "s1", material: { id: "m2", aiEvaluation: "APPROVED" } },
    ])
    expect(approvedCount(state)).toBe(2)

    state = feed(state, [{ type: "parse_complete", results: { approved: 0, filtered: 2, errors: [] } }])
    expect(approvedCount(state)).toBe(0)
    expect(collectedCount(state)).toBe(2)
  })
})

describe("outcomes", () => {
  it("is success when nothing failed", () => {
    const s = feed(start(), [
      manifest(2),
      { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 1 } },
      { type: "source_complete", sourceId: "s2", sourceName: "Source 2", stats: { approved: 1 } },
      { type: "parse_complete", results: { errors: [] } },
    ])
    expect(s.outcome).toBe("success")
  })

  it("is partial when some sources failed", () => {
    const s = feed(start(), [
      manifest(2),
      { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 1 } },
      { type: "error", sourceId: "s2", sourceName: "Source 2", message: "boom" },
      { type: "parse_complete", results: { errors: ["boom"] } },
    ])
    expect(s.outcome).toBe("partial")
  })

  it("is failed when every source failed", () => {
    const s = feed(start(), [
      manifest(1),
      { type: "error", sourceId: "s1", sourceName: "Source 1", message: "boom" },
      { type: "parse_complete", results: { errors: ["boom"] } },
    ])
    expect(s.outcome).toBe("failed")
  })

  it("surfaces the run-level {error} payload variant, not `undefined`", () => {
    // parse-stream/route.ts:283,:310 send {type:'error', error} for run-level
    // failures. The old client read data.message only, so a Lite user hitting
    // the Twitter gate saw nothing at all.
    const s = feed(start(), [{ type: "error", error: "Subscription required" }])
    expect(s.errors).toContain("Subscription required")
    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("failed")
  })

  it("distinguishes a dropped stream from a completed one", () => {
    let s = feed(start(), [manifest(2), { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: {} }])
    s = processingReducer(s, { type: "STREAM_DROPPED", generation: s.generation, at: 0 })
    expect(s.droppedWithoutCompletion).toBe(true)
    expect(s.outcome).toBe("partial")
    expect(s.errors.join(" ")).toMatch(/connection ended/i)
  })
})

describe("stop", () => {
  const phases: { name: string; build: () => ProcessingState }[] = [
    { name: "preparing", build: () => start() },
    { name: "parsing", build: () => feed(start(), [manifest(2), { type: "source_start", sourceId: "s1", sourceName: "S1" }]) },
    {
      name: "grouping",
      build: () => {
        const s = feed(start(), [manifest(1), { type: "parse_complete", results: { approved: 2, errors: [] } }])
        return processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "start", total: 2 }, at: 0 })
      },
    },
    {
      name: "refiltering",
      build: () => {
        const s = start()
        return processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "refilter", event: { type: "start", total: 5 }, at: 0 })
      },
    },
  ]

  for (const { name, build } of phases) {
    it(`settles exactly once when stopped during ${name}`, () => {
      const before = build()
      const stopped = processingReducer(before, { type: "STOP", generation: before.generation, at: 0 })

      expect(stopped.phase).toBe("done")
      expect(stopped.outcome).toBe("stopped")

      // A second stop cannot change the RUN — but it must still retire the
      // generation, because the controller bumps its mirror before dispatching
      // and the two have to move together. See "a stop that lands after the run
      // already settled" below for why a refusal here wedges the card.
      const again = processingReducer(stopped, { type: "STOP", generation: stopped.generation, at: 0 })
      expect({ ...again, generation: stopped.generation }).toEqual(stopped)
      expect(again.generation).toBe(stopped.generation + 1)
    })
  }

  it("keeps posts already received", () => {
    const s = feed(start(), [manifest(2), { type: "material_created", sourceId: "s1", material: { id: "kept" } }])
    const stopped = processingReducer(s, { type: "STOP", generation: s.generation, at: 0 })
    expect(stopped.createdIds).toEqual(["kept"])
  })

  it("invalidates late events from the stopped run", () => {
    const s = feed(start(), [manifest(2), { type: "source_start", sourceId: "s1", sourceName: "S1" }])
    const stopped = processingReducer(s, { type: "STOP", generation: s.generation, at: 0 })

    // The transport can still deliver frames tagged with the old generation.
    const late = processingReducer(stopped, {
      type: "PARSE_EVENT",
      generation: s.generation,
      event: { type: "parse_complete", results: { approved: 5, errors: [] } },
      at: 0,
    })

    expect(late).toEqual(stopped)
    expect(late.outcome).toBe("stopped")
    // Critically: no authoritative results, so nothing downstream can read this
    // as "the run finished and approved 5" and schedule auto-grouping.
    expect(late.finalResults).toBeNull()
  })

  it("does not let a stopped run start grouping", () => {
    const s = feed(start(), [manifest(1), { type: "source_complete", sourceId: "s1", sourceName: "S1", stats: { approved: 3 } }])
    const stopped = processingReducer(s, { type: "STOP", generation: s.generation, at: 0 })

    const lateGrouping = processingReducer(stopped, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "start", total: 3 },
      at: 0,
    })
    expect(lateGrouping.phase).toBe("done")
    expect(lateGrouping.outcome).toBe("stopped")
  })
})

describe("grouping and refiltering phases", () => {
  it("transitions the same card through parse then grouping", () => {
    let s = feed(start(), [manifest(1), { type: "source_complete", sourceId: "s1", sourceName: "S1", stats: { approved: 2 } }, { type: "parse_complete", results: { approved: 2, errors: [] } }])
    expect(s.phase).toBe("done")

    s = processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "start", total: 2 }, at: 0 })
    expect(s.phase).toBe("grouping")
    expect(summaryText(s)).toBe("Grouping stories · 0 of 2")

    s = processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "progress", current: 1, total: 2 }, at: 0 })
    expect(summaryText(s)).toBe("Grouping stories · 1 of 2")

    s = processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "complete", storiesCreated: 1, storiesUpdated: 0 }, at: 0 })
    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("success")
    expect(s.phaseResult).toMatchObject({ storiesCreated: 1, storiesUpdated: 0 })
  })

  it("keeps phase counters apart from source progress", () => {
    let s = feed(start(), [manifest(3), { type: "source_complete", sourceId: "s1", sourceName: "S1", stats: {} }])
    s = processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "start", total: 40 }, at: 0 })
    expect(s.phaseProgress).toEqual({ current: 0, total: 40 })
    expect(processedCount(s)).toBe(1)
    expect(s.sources).toHaveLength(3)
  })

  it("treats a grouping failure after a productive parse as partial, not failed", () => {
    let s = feed(start(), [manifest(1), { type: "material_created", sourceId: "s1", material: { id: "m" } }, { type: "source_complete", sourceId: "s1", sourceName: "S1", stats: { approved: 1 } }])
    s = processingReducer(s, { type: "PHASE_EVENT", generation: s.generation, kind: "group", event: { type: "error", message: "Story grouping failed" }, at: 0 })
    expect(s.outcome).toBe("partial")
    expect(s.createdIds).toEqual(["m"])
  })
})

describe("card ownership and the log buffer", () => {
  it("drops a terminal card when the view changes", () => {
    const s = feed(start(), [manifest(1), { type: "parse_complete", results: { errors: [] } }])
    const moved = processingReducer(s, { type: "SCOPE_CHANGED", scope: { sourceId: null, view: "ARCHIVED" } })
    // Retired, not reset — same contract as DISMISS, so the card reads as the
    // run it is retiring while AnimatedGrid fades it out.
    expect(moved.dismissed).toBe(true)
    expect(moved.scope).toEqual({ sourceId: null, view: "ARCHIVED" })
  })

  it("un-retires a scope-retired card when the auto-group re-opens a phase", () => {
    // SCOPE_CHANGED deliberately does NOT bump the generation — a running card
    // has to survive a view switch — so the grouping stream opened by the same
    // run still lands. Switching tabs in the window between `parse_complete`
    // and the grouping stream's first frame must not swallow the result.
    let s = feed(start(), [manifest(1), { type: "parse_complete", results: { approved: 3 } }])
    s = processingReducer(s, { type: "SCOPE_CHANGED", scope: { sourceId: null, view: "ARCHIVED" } })
    expect(s.dismissed).toBe(true)

    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "start", total: 3 },
      at: 0,
    })
    expect(s.dismissed).toBe(false)

    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "complete", storiesCreated: 2, storiesUpdated: 1 },
      at: 0,
    })
    expect(s.phase).toBe("done")
    // Retired stays false, so the card is still in the grid to show its result
    // rather than being yanked at the moment the grouping lands.
    expect(s.dismissed).toBe(false)
    expect(s.phaseResult).toEqual({ storiesCreated: 2, storiesUpdated: 1 })
    expect(s.log.at(-1)?.message).toBe("Grouped into 2 new + 1 updated stories")
  })

  it("keeps a running card when the view changes", () => {
    const s = feed(start(), [manifest(2), { type: "source_start", sourceId: "s1", sourceName: "S1" }])
    const moved = processingReducer(s, { type: "SCOPE_CHANGED", scope: { sourceId: null, view: "FILTERED" } })
    expect(moved.phase).toBe("parsing")
    expect(moved.scope).toEqual({ sourceId: null, view: "FILTERED" })
  })

  it("keeps a terminal card when only the search or type refinement changed", () => {
    const s = feed(start(), [manifest(1), { type: "parse_complete", results: { errors: [] } }])
    const same = processingReducer(s, { type: "SCOPE_CHANGED", scope: SCOPE })
    expect(same).toEqual(s)
  })

  it("bounds the log and reports that older detail was dropped", () => {
    let s = start()
    for (let i = 0; i < LOG_LIMIT + 50; i++) {
      s = feed(s, [{ type: "items_fetched", sourceId: "s1", sourceName: "S1", count: i }])
    }
    expect(s.log).toHaveLength(LOG_LIMIT)
    expect(logTruncated(s)).toBe(true)
  })

  it("collapses repeated terminal errors", () => {
    const s = feed(start(), [
      manifest(2),
      { type: "error", sourceId: "s1", sourceName: "S1", message: "Network unreachable" },
      { type: "error", sourceId: "s2", sourceName: "S2", message: "Network unreachable" },
    ])
    expect(s.log.filter(l => l.message === "Network unreachable")).toHaveLength(1)
    // Both sources still settle, and both errors are still counted.
    expect(processedCount(s)).toBe(2)
    expect(s.errors).toHaveLength(2)
  })

  it("dismiss retires the card but keeps what it was showing", () => {
    const s = feed(start(), [manifest(1), { type: "parse_complete", results: { approved: 3, errors: [] } }])
    const dismissed = processingReducer(s, { type: "DISMISS", generation: s.generation })
    // `dismissed` alone retires it — the consumers read `phase === "done" &&
    // !dismissed`. The finished run stays readable because the card is still
    // mounted in AnimatedGrid's exit layer while it fades.
    expect(dismissed.dismissed).toBe(true)
    expect(dismissed.phase).toBe("done")
    expect(dismissed.finalResults).toEqual(s.finalResults)
    expect(dismissed.generation).toBe(s.generation + 1)
  })

  it("wipes a dismissed run's state on the next start", () => {
    const s = feed(start(), [manifest(1), { type: "parse_complete", results: { approved: 3, errors: [] } }])
    const dismissed = processingReducer(s, { type: "DISMISS", generation: s.generation })
    const restarted = processingReducer(dismissed, {
      type: "START",
      kind: "parse",
      scope: SCOPE,
      at: 0,
    })
    expect(restarted.dismissed).toBe(false)
    expect(restarted.finalResults).toBeNull()
    expect(restarted.sources).toEqual([])
  })
})

describe("generation guard", () => {
  it("ignores every action tagged with a superseded generation", () => {
    const s = start()
    const actions: ProcessingAction[] = [
      { type: "PARSE_EVENT", generation: 99, event: { type: "parse_complete", results: {} }, at: 0 },
      { type: "PHASE_EVENT", generation: 99, kind: "group", event: { type: "start", total: 1 }, at: 0 },
      { type: "STOP", generation: 99, at: 0 },
      { type: "FATAL", generation: 99, message: "nope", at: 0 },
      { type: "STREAM_DROPPED", generation: 99, at: 0 },
    ]
    for (const a of actions) expect(processingReducer(s, a)).toEqual(s)
  })

  it("a second start supersedes the first run's in-flight events", () => {
    const first = feed(start(), [manifest(2), { type: "source_start", sourceId: "s1", sourceName: "S1" }])
    const second = start(first)

    expect(second.generation).toBe(first.generation + 1)
    expect(second.sources).toEqual([])

    const late = processingReducer(second, {
      type: "PARSE_EVENT",
      generation: first.generation,
      event: { type: "source_complete", sourceId: "s1", sourceName: "S1", stats: { approved: 9 } },
      at: 0,
    })
    expect(late).toEqual(second)
  })
})

describe("what a finished run is entitled to claim", () => {
  /**
   * These four summaries are the sentences the card shows above a grid the user
   * can see. Each one was wrong in a way the suite could not catch, because
   * nothing asserted `summaryText` after a terminal event for anything but a
   * parse.
   */
  it("does not tell an observed run it collected zero posts", () => {
    let s = processingReducer(initialProcessingState, {
      type: "START",
      kind: "parse",
      scope: SCOPE,
      observed: true,
      expectedSources: 5,
      at: 0,
    })
    s = processingReducer(s, {
      type: "PARSE_EVENT",
      generation: s.generation,
      event: { type: "parse_complete", results: {} },
      at: 0,
    })

    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("success")
    // An observed run receives no frames, so any count is structurally 0 — and
    // it would sit above a grid the completion refresh has just filled.
    expect(summaryText(s)).not.toMatch(/\b0\b/)
    expect(summaryText(s)).toMatch(/finished/i)
  })

  it("reports what a completed grouping run actually did", () => {
    let s = processingReducer(initialProcessingState, { type: "START", kind: "group", scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "start", total: 3 },
      at: 0,
    })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "complete", storiesCreated: 1, storiesUpdated: 2 },
      at: 0,
    })

    // A group run never populates `sources`, so the source sentence would have
    // read "No sources to process" on a run that created a story.
    expect(summaryText(s)).toBe("Grouped into 1 new + 2 updated stories")
  })

  it("reports what a completed re-filter run actually did", () => {
    let s = processingReducer(initialProcessingState, { type: "START", kind: "refilter", scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "refilter",
      event: { type: "start", total: 4 },
      at: 0,
    })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "refilter",
      event: { type: "complete", flippedToApproved: 2, flippedToFiltered: 1 },
      at: 0,
    })

    expect(summaryText(s)).toBe("Re-filtered · 2 approved, 1 filtered")
  })

  it("does not count sources a phase run never had when it is stopped", () => {
    let s = processingReducer(initialProcessingState, { type: "START", kind: "group", scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "start", total: 3 },
      at: 0,
    })
    s = processingReducer(s, { type: "STOP", generation: s.generation, at: 0 })

    expect(summaryText(s)).toBe("Stopped")
  })
})

describe("a stop that lands after the run already settled", () => {
  /**
   * A backstop, not the live path. The controller now reads `stateRef`
   * synchronously and no-ops a stop that lands on a settled run, so it never
   * bumps its mirror here. The invariant stays the reducer's to hold: it is a
   * pure module with its own callers, and a mirror left one ahead would make
   * every later frame carry a number the reducer does not recognise — the
   * generation guard drops it, and the card can never finish.
   */
  it("still retires the generation, without rewriting the finished run", () => {
    let s = start()
    s = feed(s, [manifest(1), { type: "parse_complete", results: { approved: 2 } }])
    expect(s.phase).toBe("done")

    const after = processingReducer(s, { type: "STOP", generation: s.generation, at: 0 })

    expect(after.generation).toBe(s.generation + 1)
    expect(after.outcome).toBe("success") // not rewritten to "stopped"
    expect(after.phase).toBe("done")
  })

  it("retires the generation on an idle card too", () => {
    const after = processingReducer(initialProcessingState, {
      type: "STOP",
      generation: initialProcessingState.generation,
      at: 0,
    })
    expect(after.generation).toBe(initialProcessingState.generation + 1)
  })
})

describe("late frames on a settled run", () => {
  it("ignores a parse frame that arrives after the run finished", () => {
    let s = feed(start(), [manifest(2), { type: "parse_complete", results: { approved: 1 } }])
    const settled = s
    s = feed(s, [{ type: "source_start", sourceId: "s1", sourceName: "Source 1" }])

    expect(s).toEqual(settled)
  })

  it("ignores a phase progress frame that arrives after an error ended the phase", () => {
    let s = processingReducer(initialProcessingState, { type: "START", kind: "group", scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "start", total: 3 },
      at: 0,
    })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "error", message: "Story grouping failed" },
      at: 0,
    })
    expect(s.phase).toBe("done")

    const late = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "progress", current: 1, total: 3 },
      at: 0,
    })

    // Otherwise: phase back to "grouping", carrying outcome "failed", with no
    // further frames coming — a card that runs forever on a failed run.
    expect(late).toEqual(s)
  })
})

describe("the log says truncated only when it dropped something", () => {
  it("a buffer that is exactly full has lost nothing", () => {
    let s = start()
    // The START entry is the first, so LOG_LIMIT - 1 more fill it exactly.
    for (let i = 0; i < LOG_LIMIT - 1; i++) {
      s = feed(s, [{ type: "items_fetched", sourceId: "s1", sourceName: "S1", count: i }])
    }
    expect(s.log).toHaveLength(LOG_LIMIT)
    expect(logTruncated(s)).toBe(false)
  })

  it("one entry past the limit is a real truncation", () => {
    let s = start()
    for (let i = 0; i < LOG_LIMIT; i++) {
      s = feed(s, [{ type: "items_fetched", sourceId: "s1", sourceName: "S1", count: i }])
    }
    expect(s.log).toHaveLength(LOG_LIMIT)
    expect(logTruncated(s)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RAD-346 — the transport died but the run did not
// ---------------------------------------------------------------------------

describe("a detached run (RAD-346)", () => {
  /**
   * The card used to treat a dropped SSE stream as the end of the run. The run
   * now belongs to the server: a dead transport makes the card non-terminal
   * (`detached`), progress comes from `GET /api/parse-stream/status`, and only
   * the server's terminal snapshot settles it.
   */
  function detached(): ProcessingState {
    const s = feed(start(), [
      manifest(2),
      { type: "source_start", sourceId: "s1", sourceName: "Source 1" },
    ])
    return processingReducer(s, { type: "STREAM_DETACHED", generation: s.generation, at: 1 })
  }

  it("AC-6: STREAM_DETACHED keeps the run non-terminal, adds no error and logs one info line", () => {
    const before = feed(start(), [
      manifest(2),
      { type: "source_start", sourceId: "s1", sourceName: "Source 1" },
    ])
    const s = processingReducer(before, { type: "STREAM_DETACHED", generation: before.generation, at: 1 })

    expect(s.phase).toBe("parsing")
    expect(s.outcome).toBeNull()
    expect(s.detached).toBe(true)
    // A dropped transport is not the run's failure; the card must not show one.
    expect(s.errors).toEqual([])
    expect(s.log).toHaveLength(before.log.length + 1)
    expect(s.log.at(-1)?.kind).toBe("info")
  })

  it("AC-7: SERVER_PROGRESS drives the counts and the summary while detached", () => {
    const before = detached()
    const s = processingReducer(before, {
      type: "SERVER_PROGRESS",
      generation: before.generation,
      progress: { processed: 3, total: 5, approved: 2, collected: 4 },
      at: 2,
    })

    expect(s.detached).toBe(true)
    expect(s.phase).toBe("parsing")
    expect(s.serverProgress).toEqual({ processed: 3, total: 5, approved: 2, collected: 4 })
    expect(collectedCount(s)).toBe(4)
    expect(approvedCount(s)).toBe(2)
    expect(summaryText(s)).toContain("3 of 5")
    expect(summaryText(s)).toMatch(/background/i)
  })

  it("AC-8: SERVER_SETTLED 'done' is terminal and clears the detached state", () => {
    const before = detached()
    const serverResults = { approved: 4, filtered: 1, errors: [] }
    const s = processingReducer(before, {
      type: "SERVER_SETTLED",
      generation: before.generation,
      status: "done",
      results: serverResults,
      at: 3,
    })

    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("success")
    expect(s.finalResults).toEqual(serverResults)
    expect(s.detached).toBe(false)
    expect(s.serverProgress).toBeNull()
    // The server's reconciled totals win over anything streamed before the drop.
    expect(collectedCount(s)).toBe(5)
    expect(approvedCount(s)).toBe(4)
  })

  it("AC-8: SERVER_SETTLED with errors is terminal and partial, and surfaces them", () => {
    const before = detached()
    const s = processingReducer(before, {
      type: "SERVER_SETTLED",
      generation: before.generation,
      status: "done",
      results: { approved: 1, filtered: 0, errors: ["Feed timed out"] },
      at: 3,
    })

    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("partial")
    expect(s.errors).toEqual(["Feed timed out"])
    expect(s.log.at(-1)?.kind).toBe("error")
    expect(s.detached).toBe(false)
    expect(s.serverProgress).toBeNull()
  })

  it("AC-8: SERVER_SETTLED 'stopped' settles as stopped with the server's results", () => {
    const before = detached()
    const serverResults = { approved: 0, filtered: 0, errors: [] }
    const s = processingReducer(before, {
      type: "SERVER_SETTLED",
      generation: before.generation,
      status: "stopped",
      results: serverResults,
      at: 3,
    })

    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("stopped")
    expect(s.finalResults).toEqual(serverResults)
    expect(s.detached).toBe(false)
    expect(s.serverProgress).toBeNull()
  })

  it("EC-4: every RAD-346 action drops a stale generation", () => {
    const s = detached()
    const actions: ProcessingAction[] = [
      { type: "STREAM_DETACHED", generation: 99, at: 0 },
      {
        type: "SERVER_PROGRESS",
        generation: 99,
        progress: { processed: 9, total: 9, approved: 9, collected: 9 },
        at: 0,
      },
      { type: "SERVER_SETTLED", generation: 99, status: "done", results: { approved: 9, errors: [] }, at: 0 },
    ]

    for (const action of actions) expect(processingReducer(s, action)).toEqual(s)

    // The run is untouched: still detached, still non-terminal, still counting
    // from the last live frame.
    expect(processingReducer(s, actions[1]).detached).toBe(true)
    expect(processingReducer(s, actions[1]).phase).toBe("parsing")
  })
})

describe("a detached run settles on the server's terms (RAD-346 review)", () => {
  /**
   * The stream froze the per-source rows at the drop while the server kept
   * going. Settling without reconciling them printed "1 of 2 sources processed"
   * beside a "Done" title — a card contradicting itself on the very path a CDN
   * drop produces.
   */
  it("AC-8: SERVER_SETTLED marks the sources the stream never saw as done", () => {
    const started = feed(start(), [
      manifest(2),
      { type: "source_start", sourceId: "s1", sourceName: "Source 1" },
    ])
    const detached = processingReducer(started, {
      type: "STREAM_DETACHED",
      generation: started.generation,
      at: 1,
    })
    const s = processingReducer(detached, {
      type: "SERVER_SETTLED",
      generation: detached.generation,
      status: "done",
      results: { approved: 2, filtered: 0, errors: [] },
      at: 2,
    })

    expect(processedCount(s)).toBe(2)
    expect(summaryText(s)).toBe("2 of 2 sources processed")
  })

  /**
   * A drop the registry never confirmed is terminal, so it must also end the
   * detachment — otherwise the bar keeps rendering the last polled snapshot on
   * a card whose summary already reads as a failure.
   */
  it("STREAM_DROPPED clears the detached state so a dead card stops reading server progress", () => {
    const started = feed(start(), [manifest(1)])
    const detached = processingReducer(started, {
      type: "STREAM_DETACHED",
      generation: started.generation,
      at: 1,
    })
    const withProgress = processingReducer(detached, {
      type: "SERVER_PROGRESS",
      generation: detached.generation,
      progress: { processed: 1, total: 1, approved: 1, collected: 1 },
      at: 2,
    })
    const s = processingReducer(withProgress, {
      type: "STREAM_DROPPED",
      generation: withProgress.generation,
      reason: "dropped",
      at: 3,
    })

    expect(s.phase).toBe("done")
    expect(s.detached).toBe(false)
    expect(s.serverProgress).toBeNull()
    expect(s.droppedWithoutCompletion).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RAD-347 — the card observes a run it did not start
// ---------------------------------------------------------------------------

describe("SERVER_PROGRESS proves a run is under way (RAD-347)", () => {
  /**
   * The attach path opens a card from a server snapshot alone. It dispatches the
   * reservation and the server's progress, but no streamed frame ever arrives to
   * move `preparing` to `parsing` — so the progress itself has to do it, or the
   * card sits on "Preparing…" for the whole run while the server is demonstrably
   * parsing. On any phase a stream already opened, the progress must stay a pure
   * counter patch: "changes only what it knows".
   */
  const SERVER_PROGRESS = { processed: 12, total: 57, approved: 0, collected: 0 }

  it("AC-7: promotes a preparing run to parsing", () => {
    const preparing = start()
    expect(preparing.phase).toBe("preparing")

    const s = processingReducer(preparing, {
      type: "SERVER_PROGRESS",
      generation: preparing.generation,
      progress: SERVER_PROGRESS,
      at: 2,
    })

    expect(s.phase).toBe("parsing")
    expect(s.serverProgress).toEqual(SERVER_PROGRESS)
    // The promotion is the only change: the reservation itself is untouched.
    expect(s.detached).toBe(false)
    expect(s.log).toEqual(preparing.log)
    expect(s.errors).toEqual([])
  })

  it("AC-7: changes nothing else on a run that is already parsing", () => {
    const parsing = feed(start(), [manifest(2)])
    expect(parsing.phase).toBe("parsing")

    const s = processingReducer(parsing, {
      type: "SERVER_PROGRESS",
      generation: parsing.generation,
      progress: SERVER_PROGRESS,
      at: 2,
    })

    expect(s.phase).toBe("parsing")
    expect(s.serverProgress).toEqual(SERVER_PROGRESS)
    // Every other field is byte-for-byte the state it was.
    expect({ ...s, serverProgress: null }).toEqual(parsing)
  })

  it("AC-7: is inert on a done run", () => {
    const done = feed(start(), [manifest(1), { type: "parse_complete", results: { approved: 1 } }])
    expect(done.phase).toBe("done")

    const s = processingReducer(done, {
      type: "SERVER_PROGRESS",
      generation: done.generation,
      progress: SERVER_PROGRESS,
      at: 3,
    })

    expect(s).toEqual(done)
    expect(s.phase).toBe("done")
    expect(s.serverProgress).toBeNull()
  })
})

/**
 * RAD-326 — a rate-limited run is refused before it starts. It is not a
 * failure the card should paint red, and it is not a dropped connection: the
 * card says so, and says when to try again.
 */
describe("a rate-limited run (RAD-326)", () => {
  const limitedParse = { type: "error", code: "RATE_LIMITED", retryAfter: 42, error: "Too many requests — try again in 42s", message: "Too many requests — try again in 42s" } as const

  it("settles a refused parse as rate_limited, with the retry copy as its summary", () => {
    const s = feed(start(), [limitedParse as unknown as ParseEvent])
    expect(s.phase).toBe("done")
    expect(s.outcome).toBe("rate_limited")
    expect(s.refusal).toEqual({ code: "RATE_LIMITED", retryAfter: 42 })
    expect(summaryText(s)).toBe("Too many requests — try again in 42s")
    // Not a failure and not a drop: nothing for the card's red error line.
    expect(s.errors).toEqual([])
    expect(s.droppedWithoutCompletion).toBe(false)
  })

  it.each(["group", "refilter"] as const)("settles a refused %s run the same way", kind => {
    let s = processingReducer(initialProcessingState, { type: "START", kind, scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind,
      event: { type: "error", code: "RATE_LIMITED", retryAfter: 9, message: "Too many requests — try again in 9s" },
      at: 0,
    })
    expect(s.outcome).toBe("rate_limited")
    expect(summaryText(s)).toBe("Too many requests — try again in 9s")
    expect(s.errors).toEqual([])
  })

  it("keeps an attached run's good parse partial when its grouping was refused", () => {
    // A card that attached to another tab's run has no sources and no created
    // ids of its own; only the settled final results say the parse worked.
    let s: ProcessingState = { ...start(), finalResults: { approved: 3, filtered: 1, errors: [] } }
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "error", code: "RATE_LIMITED", retryAfter: 30, message: "Too many requests — try again in 30s" },
      at: 0,
    })
    expect(s.outcome).toBe("partial")
    expect(s.errors).toEqual(["Story grouping skipped. Too many requests — try again in 30s"])
  })

  it("keeps a good parse partial when only the automatic grouping after it was refused", () => {
    let s = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
      { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 1 } },
      { type: "parse_complete", results: { approved: 1, filtered: 0, errors: [] } },
    ])
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "error", code: "RATE_LIMITED", retryAfter: 30, message: "Too many requests — try again in 30s" },
      at: 0,
    })
    expect(s.outcome).toBe("partial")
    expect(s.errors).toEqual(["Story grouping skipped. Too many requests — try again in 30s"])
  })

  it("leaves an ordinary run-level error a failure", () => {
    const s = feed(start(), [{ type: "error", error: "Subscription required" }])
    expect(s.outcome).toBe("failed")
    expect(s.refusal).toBeNull()
  })
})

/**
 * RAD-406 — the session expired, or the email is not verified. The server
 * refused the run before it started, exactly like a rate limit: the card must
 * say which refusal it was and how to get past it — never "the connection was
 * interrupted", and never a red failure for work that was never attempted.
 */
describe("a run refused for sign-in or email verification (RAD-406)", () => {
  const frame = (code: string) =>
    ({ type: "error", code, message: `copy for ${code}`, error: `copy for ${code}` }) as unknown as ParseEvent

  it.each([
    ["UNAUTHORIZED", "signed_out", /sign in again/i],
    ["EMAIL_NOT_VERIFIED", "unverified", /verify your email/i],
  ] as const)("settles a parse refused with %s as %s, with the shared copy as its summary", (code, outcome, copy) => {
    const s = feed(start(), [frame(code)])
    expect(s.phase).toBe("done")
    expect(s.outcome).toBe(outcome)
    expect(s.refusal).toEqual({ code })
    expect(summaryText(s)).toMatch(copy)
    // Not a failure and not a drop: nothing for the card's red error line.
    expect(s.errors).toEqual([])
    expect(s.droppedWithoutCompletion).toBe(false)
    expect(s.detached).toBe(false)
  })

  it.each(["group", "refilter"] as const)("settles a %s run refused for sign-in the same way", kind => {
    let s = processingReducer(initialProcessingState, { type: "START", kind, scope: SCOPE, at: 0 })
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind,
      event: { type: "error", code: "UNAUTHORIZED", message: "signed out" },
      at: 0,
    })
    expect(s.outcome).toBe("signed_out")
    expect(summaryText(s)).toMatch(/sign in again/i)
    expect(s.errors).toEqual([])
  })

  it("keeps a good parse partial when the session ended before its automatic grouping", () => {
    let s = feed(start(), [
      manifest(1),
      { type: "material_created", sourceId: "s1", material: { id: "m1", aiEvaluation: "APPROVED" } },
      { type: "source_complete", sourceId: "s1", sourceName: "Source 1", stats: { approved: 1 } },
      { type: "parse_complete", results: { approved: 1, filtered: 0, errors: [] } },
    ])
    s = processingReducer(s, {
      type: "PHASE_EVENT",
      generation: s.generation,
      kind: "group",
      event: { type: "error", code: "UNAUTHORIZED", message: "signed out" },
      at: 0,
    })
    expect(s.outcome).toBe("partial")
    expect(s.refusal).toEqual({ code: "UNAUTHORIZED" })
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0]).toMatch(/^Story grouping skipped\. .*sign in again/i)
  })

  it("ignores an unknown code — that is an ordinary failure", () => {
    const s = feed(start(), [frame("SOMETHING_ELSE")])
    expect(s.outcome).toBe("failed")
    expect(s.refusal).toBeNull()
  })
})
