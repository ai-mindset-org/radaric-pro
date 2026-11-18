/**
 * The pure state machine behind the posts screen's processing card (RAD-318).
 *
 * Everything here is a pure function of `(state, action)`. No transport, no
 * React, no timers — the controller in `components/materials/use-post-processing.ts`
 * owns those and feeds this reducer. That split is what makes the awkward parts
 * (interleaved sources, a stop landing mid-phase, late events from a run the
 * user already abandoned) testable without a browser.
 *
 * Two invariants carry most of the weight:
 *
 * 1. **Run generation.** Every run has a monotonic id. Any action carrying a
 *    stale generation is dropped. This is how a stopped run stays stopped even
 *    though its transport may still deliver a few more frames, and it replaces
 *    the accidental mechanism the old code relied on — `cancelParsing` closed
 *    the EventSource and left `parseAllFeeds`'s promise permanently pending,
 *    which is the *only* reason the post-await auto-grouping did not fire on a
 *    stopped run. Resolving that promise without a generation guard would have
 *    silently re-enabled grouping after Stop.
 *
 * 2. **Sources settle exactly once.** `source_complete` and a source-level
 *    `error` are both terminal for that source, and a second terminal event for
 *    the same id is ignored rather than double-counted. `processedSources`
 *    therefore never decreases and never exceeds the manifest's denominator.
 */

import { readRefusal, refusalCopy, type StreamRefusal } from "@/lib/stream-refusal"

// ---------------------------------------------------------------- wire events

/** Run-level events describe the whole run and carry no sourceId. */
export type RunLevelEvent =
  /** `runId` names the server's run, so a card that loses the stream follows that run (RAD-407). */
  | { type: "parse_start"; sourceCount: number; sources: { id: string; name: string }[]; runId?: string }
  | { type: "parse_complete"; results: ParseResults }
  /**
   * Two shapes exist in the wild and both mean "the run failed". Source-level
   * failures send `message` (parse-stream/route.ts:509); run-level ones send
   * `error` (:283 Unauthorized, :310 Subscription required). The old client read
   * `message` only, so a Lite user hitting the Twitter gate was shown nothing.
   */
  | { type: "error"; message?: string; error?: string; sourceId?: string; sourceName?: string; code?: string; retryAfter?: number }

/** Source-level events always name their source. */
export type SourceLevelEvent =
  | { type: "source_start"; sourceId?: string; sourceName: string }
  | { type: "items_fetched"; sourceId?: string; sourceName?: string; count: number }
  /**
   * `aiEvaluation` is typed because the card's "AI approved" counter reads it
   * off every frame; the real payload is a full material row whose
   * MATERIAL_SELECT includes it (app/api/parse-stream/route.ts).
   */
  | { type: "material_created"; sourceId?: string; material: { id: string; aiEvaluation?: "APPROVED" | "FILTERED" } & Record<string, unknown>; progress?: { current: number; total: number } }
  /**
   * A stored material whose media/content were reconciled during a re-parse
   * (RAD-359 backfill). Never a new row: the client merges it by id.
   */
  | { type: "material_updated"; sourceId?: string; material: { id: string } & Record<string, unknown> }
  | { type: "source_complete"; sourceId?: string; sourceName: string; stats?: { approved?: number; filtered?: number } }

export type ParseEvent = RunLevelEvent | SourceLevelEvent

export interface ParseResults {
  parsed?: number
  evaluated?: number
  approved?: number
  filtered?: number
  errors?: string[]
}

/**
 * The server's own progress while the card is detached (RAD-346). Reconciled
 * rather than streamed: `processed` counts settled sources against the
 * manifest's `total`, and `collected` is what the run has produced so far.
 */
export interface ServerProgress {
  processed: number
  total: number
  approved: number
  collected: number
}

/** `group-stories` and `refilter` share a start/progress/complete/error shape. */
export type PhaseEvent =
  | { type: "start"; total: number }
  | { type: "progress"; current: number; total: number }
  | { type: "complete"; storiesCreated?: number; storiesUpdated?: number; flippedToApproved?: number; flippedToFiltered?: number; unchanged?: number; errors?: number }
  /**
   * `code` marks an in-band pre-stream refusal: `RATE_LIMITED` + `retryAfter`
   * (RAD-326), `UNAUTHORIZED` or `EMAIL_NOT_VERIFIED` (RAD-406).
   */
  | { type: "error"; message?: string; code?: string; retryAfter?: number }

// ---------------------------------------------------------------------- state

export type OperationKind = "parse" | "group" | "refilter"

export type Phase =
  | "idle"
  /** Reserved synchronously on click, before any network work. */
  | "preparing"
  | "parsing"
  | "grouping"
  | "refiltering"
  | "done"

/**
 * The server refused to start the run — `rate_limited` (RAD-326), `signed_out`
 * or `unverified` (RAD-406). Not a failure — nothing was attempted — and not a
 * drop: the card says why, and what gets the user past it.
 */
export type Outcome = "success" | "partial" | "failed" | "stopped" | "rate_limited" | "signed_out" | "unverified"

export type SourceState = "pending" | "active" | "done" | "failed"

export interface SourceProgress {
  id: string
  name: string
  state: SourceState
  approved: number
  filtered: number
  error?: string
}

export interface LogEntry {
  kind: "info" | "start" | "success" | "error" | "complete"
  message: string
  at: number
}

export interface ProcessingState {
  generation: number
  kind: OperationKind | null
  phase: Phase
  outcome: Outcome | null
  /** True once a manifest arrived; until then the denominator is unknown. */
  manifestKnown: boolean
  sources: SourceProgress[]
  /** Unique material ids seen this run — the honest "newly collected" number. */
  createdIds: string[]
  /**
   * The subset of `createdIds` the filter approved, as each one lands. Counted
   * from the streamed material rather than from `source_complete` stats so the
   * card's "AI approved" number moves while a source is still being evaluated.
   */
  approvedIds: string[]
  /** Authoritative totals from parse_complete, once it lands. */
  finalResults: ParseResults | null
  /**
   * The transport died but the run did not (RAD-346). The card is non-terminal:
   * it keeps polling and only the server's terminal snapshot settles it.
   */
  detached: boolean
  /**
   * The run being watched was never this card's (RAD-347): a mount attach or
   * the server's "already running" refusal. It changes what the card may claim
   * — nothing was lost here, so the detached notice must not say otherwise.
   */
  attachedRun: boolean
  /** The server's progress while detached — the card's only live numbers. */
  serverProgress: ServerProgress | null
  /** Phase-specific counters for grouping/refiltering, kept apart from source progress. */
  phaseProgress: { current: number; total: number } | null
  phaseResult: Record<string, number> | null
  errors: string[]
  log: LogEntry[]
  /** Set when the stream ended without a terminal event — an edge/transport drop. */
  droppedWithoutCompletion: boolean
  /**
   * The server's pre-stream refusal (RAD-326, RAD-406), including a refused
   * automatic grouping after a good parse; null otherwise.
   */
  refusal: StreamRefusal | null
  /** The view and source/folder scope the run was started in; the card belongs to them. */
  scope: { sourceId: string | null; folderId: string | null; view: string } | null
  /**
   * True for a run the server owns and the card only watches — the automatic
   * first parse. There are no per-source frames for it, so the card shows
   * indeterminate activity rather than inventing a numerator.
   */
  observed: boolean
  /** How many sources the observed run covers, when the server said so. */
  expectedSources: number | null
  /** Entries the bounded buffer actually dropped — not "the buffer is full". */
  droppedLogEntries: number
  dismissed: boolean
}

export const LOG_LIMIT = 200

export const initialProcessingState: ProcessingState = {
  generation: 0,
  kind: null,
  phase: "idle",
  outcome: null,
  manifestKnown: false,
  sources: [],
  createdIds: [],
  approvedIds: [],
  finalResults: null,
  detached: false,
  attachedRun: false,
  serverProgress: null,
  phaseProgress: null,
  phaseResult: null,
  errors: [],
  log: [],
  droppedWithoutCompletion: false,
  refusal: null,
  scope: null,
  observed: false,
  expectedSources: null,
  droppedLogEntries: 0,
  dismissed: false,
}

// -------------------------------------------------------------------- actions

export type ProcessingAction =
  | {
      type: "START"
      kind: OperationKind
      scope: { sourceId: string | null; folderId: string | null; view: string }
      /** The run belongs to the server; the card is an observer. */
      observed?: boolean
      expectedSources?: number
      /**
       * RAD-347: this card did not start the run — it attached to one the
       * server is already running. Opens directly in the detached state, with
       * the server's own counters, and with a single log line that names what
       * the card is watching instead of the "Starting…" it never did.
       */
      attachedProgress?: ServerProgress
      at?: number
    }
  | { type: "PARSE_EVENT"; generation: number; event: ParseEvent; at?: number }
  | { type: "PHASE_EVENT"; generation: number; kind: Extract<OperationKind, "group" | "refilter">; event: PhaseEvent; at?: number }
  /**
   * The stream ended without a terminal event. `interrupted` means the browser
   * would have retried but these routes cannot resume a run; `dropped` means the
   * connection is closed for good. Neither is recoverable — the difference is
   * only what the card is entitled to claim.
   */
  | { type: "STREAM_DROPPED"; generation: number; reason?: "dropped" | "interrupted"; at?: number }
  /**
   * The stream is gone but the run is not (RAD-346): the server keeps parsing
   * and the card polls `/api/parse-stream/status` until it can settle. `phase`
   * stays put — only the server's terminal snapshot ends the run.
   */
  | { type: "STREAM_DETACHED"; generation: number; attached?: boolean; at?: number }
  /** The server's live counters, while detached. */
  | { type: "SERVER_PROGRESS"; generation: number; progress: ServerProgress; at?: number }
  /** The server's terminal snapshot — the one thing that settles a detached run. */
  | { type: "SERVER_SETTLED"; generation: number; status: "done" | "stopped"; results: ParseResults; at?: number }
  | { type: "FATAL"; generation: number; message: string; at?: number }
  | { type: "STOP"; generation: number; at?: number }
  | { type: "DISMISS"; generation: number }
  /** The view or source changed: a terminal card no longer belongs here. */
  | { type: "SCOPE_CHANGED"; scope: { sourceId: string | null; folderId: string | null; view: string } }

// ------------------------------------------------------------------- helpers

const now = (at?: number) => at ?? Date.now()

/** Append one entry to the bounded buffer, reporting what it had to drop. */
function pushLog(log: LogEntry[], entry: LogEntry): { log: LogEntry[]; dropped: number } {
  const last = log[log.length - 1]
  // Terminal errors repeat when several sources fail the same way; collapsing
  // them keeps the bounded buffer useful instead of full of one message.
  if (last && last.kind === "error" && entry.kind === "error" && last.message === entry.message) {
    return { log, dropped: 0 }
  }
  const next = [...log, entry]
  if (next.length <= LOG_LIMIT) return { log: next, dropped: 0 }
  const dropped = next.length - LOG_LIMIT
  return { log: next.slice(dropped), dropped }
}

/** The common case: one entry, as the two state fields the card reads. */
function appendLog(state: ProcessingState, entry: LogEntry): Pick<ProcessingState, "log" | "droppedLogEntries"> {
  const { log, dropped } = pushLog(state.log, entry)
  return { log, droppedLogEntries: state.droppedLogEntries + dropped }
}

/**
 * True when the buffer actually dropped entries.
 *
 * Counted, not inferred from `log.length`: a buffer holding exactly `LOG_LIMIT`
 * entries with nothing dropped is full, not truncated, and telling the user
 * older detail was omitted when it was not is a lie the sheet cannot walk back.
 */
export function logTruncated(state: ProcessingState): boolean {
  return state.droppedLogEntries > 0
}

function patchSource(
  state: ProcessingState,
  id: string,
  name: string | undefined,
  patch: Partial<SourceProgress>
): SourceProgress[] {
  const idx = state.sources.findIndex(s => s.id === id)
  if (idx === -1) {
    // A source the manifest did not mention. Track it so its events are not
    // lost — it does join the denominator. `source_start`, `source_complete`
    // and a source-level `error` are the frames that reach this: `items_fetched`
    // no longer patches the source it names (it only logs), so on that frame
    // alone a missing source stays missing.
    return [...state.sources, { id, name: name ?? id, state: "pending", approved: 0, filtered: 0, ...patch }]
  }
  const next = [...state.sources]
  next[idx] = { ...next[idx], ...patch, name: name ?? next[idx].name }
  return next
}

/** Terminal for that source — `source_complete` or a source-level error. */
function isSettled(s: SourceProgress) {
  return s.state === "done" || s.state === "failed"
}

export function processedCount(state: ProcessingState): number {
  return state.sources.filter(isSettled).length
}

export function activeCount(state: ProcessingState): number {
  return state.sources.filter(s => s.state === "active").length
}

/**
 * The summary line's text. Pinned here rather than in JSX so the acceptance
 * matrix can assert the exact shape after every event.
 */
export function summaryText(state: ProcessingState): string {
  if (state.phase === "preparing") return "Preparing…"
  if (state.phase === "done" && state.refusal && isRefusalOutcome(state.outcome)) {
    return refusalCopy(state.refusal)
  }
  if (state.phase === "grouping") {
    const p = state.phaseProgress
    return p && p.total > 0 ? `Grouping stories · ${p.current} of ${p.total}` : "Grouping stories…"
  }
  if (state.phase === "refiltering") {
    const p = state.phaseProgress
    return p && p.total > 0 ? `Re-filtering · ${p.current} of ${p.total}` : "Re-filtering…"
  }
  if (state.detached && state.phase !== "done") {
    // The streamed counters are frozen at the drop; the server's are live. Say
    // where the work is, and how far it has got, without claiming it is over.
    const p = state.serverProgress
    return p
      ? `Still collecting in the background · ${p.processed} of ${p.total} sources processed`
      : "Still collecting in the background…"
  }
  const total = state.sources.length
  const processed = processedCount(state)
  if (state.observed && state.phase !== "done") {
    // An observed run reports nothing until it ends. Saying "0 of 5 processed"
    // would be a progress claim the card cannot back up.
    return state.expectedSources
      ? `Collecting posts from ${state.expectedSources} ${state.expectedSources === 1 ? "source" : "sources"}…`
      : "Collecting posts…"
  }
  if (state.observed && state.phase === "done") {
    if (state.outcome === "failed") return "Could not start collecting"
    // An observed run has no frames to count, so `collectedCount` is
    // structurally 0 — and "Collected 0 posts" would sit directly above a grid
    // the refresh has just filled, contradicting both it and the totals
    // `reportFirstResults` toasts moments later. Say what is known instead.
    return "Collection finished — your posts are below"
  }
  if (state.phase === "done" && (state.kind === "group" || state.kind === "refilter")) {
    // These runs never populate `sources`, so the source sentence below would
    // report "No sources to process" on a run that did real work. The result
    // the old toasts announced lives in `phaseResult`.
    if (state.outcome === "stopped") return "Stopped"
    const r = state.phaseResult
    if (!r) return state.kind === "group" ? "Grouping finished" : "Re-filtering finished"
    return state.kind === "group"
      ? `Grouped into ${r.storiesCreated ?? 0} new + ${r.storiesUpdated ?? 0} updated stories`
      : `Re-filtered · ${r.flippedToApproved ?? 0} approved, ${r.flippedToFiltered ?? 0} filtered`
  }
  if (state.phase === "done") {
    if (state.outcome === "stopped") return `Stopped · ${processed} of ${total} sources processed`
    if (total === 0) return "No sources to process"
    return `${processed} of ${total} sources processed`
  }
  if (!state.manifestKnown) return "Starting…"
  if (total === 0) return "No sources to process"
  return `${processed} of ${total} sources processed · ${activeCount(state)} active`
}

/** The count the card shows as "newly collected" — never raw fetched items. */
export function collectedCount(state: ProcessingState): number {
  if (state.finalResults) {
    const { approved = 0, filtered = 0 } = state.finalResults
    return approved + filtered
  }
  // While detached the streamed ids stop arriving; the server's count is the
  // live one until its final results land.
  if (state.serverProgress) return state.serverProgress.collected
  return state.createdIds.length
}

/**
 * The count the card shows as "AI approved" — the part of the new haul the
 * filter passed. Live while the run streams (each `material_created` frame
 * carries its evaluation), and the server's reconciled total the moment
 * `parse_complete` lands — the same two-stage contract as `collectedCount`.
 */
export function approvedCount(state: ProcessingState): number {
  if (state.finalResults) return state.finalResults.approved ?? 0
  if (state.serverProgress) return state.serverProgress.approved
  return state.approvedIds.length
}

function settleOutcome(state: ProcessingState): Outcome {
  const failed = state.sources.filter(s => s.state === "failed").length
  if (state.errors.length === 0 && failed === 0) return "success"
  if (failed > 0 && failed < state.sources.length) return "partial"
  if (state.sources.length === 0) return state.errors.length > 0 ? "failed" : "success"
  return failed === state.sources.length ? "failed" : "partial"
}

const REFUSAL_OUTCOME: Record<StreamRefusal["code"], Outcome> = {
  RATE_LIMITED: "rate_limited",
  UNAUTHORIZED: "signed_out",
  EMAIL_NOT_VERIFIED: "unverified",
}

/** A run the server refused to start: it changed nothing server-side. */
export function isRefusalOutcome(outcome: Outcome | null): boolean {
  return outcome === "rate_limited" || outcome === "signed_out" || outcome === "unverified"
}

/**
 * RAD-326, RAD-406: a run the server refused to start. Settles as the
 * refusal's own outcome when the refused stream is the first work this run
 * did; returns null when the frame is not a refusal, or when earlier work in
 * the same run (a parse before its automatic grouping) makes the run partial
 * instead.
 */
function refuseRun(state: ProcessingState, event: unknown, at: number): ProcessingState | null {
  const refusal = readRefusal(event)
  if (!refusal) return null
  if (state.createdIds.length > 0 || processedCount(state) > 0 || state.finalResults) return null
  return {
    ...state,
    phase: "done",
    outcome: REFUSAL_OUTCOME[refusal.code],
    refusal,
    phaseProgress: null,
    ...appendLog(state, { kind: "info", message: refusalCopy(refusal), at }),
  }
}

// ------------------------------------------------------------------- reducer

export function processingReducer(state: ProcessingState, action: ProcessingAction): ProcessingState {
  // Any action from a superseded run is inert. This is the single guard that
  // keeps a stopped run stopped, late frames harmless, and auto-grouping from
  // firing after Stop.
  if ("generation" in action && action.generation !== state.generation) return state

  switch (action.type) {
    case "START": {
      const base = {
        ...initialProcessingState,
        generation: state.generation + 1,
        kind: action.kind,
        scope: action.scope,
        observed: action.observed ?? false,
        expectedSources: action.expectedSources ?? null,
      }
      if (action.attachedProgress) {
        // Attached to a run that is already under way: there is no "Starting…"
        // to log because this card did not start it. `detached` puts the
        // summary on the background branch, which reads the server's counters,
        // and `phase: "parsing"` is what the server's own progress proves.
        return {
          ...base,
          phase: "parsing",
          detached: true,
          attachedRun: true,
          serverProgress: action.attachedProgress,
          log: [
            { kind: "info", message: "Watching a run that is already in progress", at: now(action.at) },
          ],
        }
      }
      return {
        ...base,
        phase: action.observed ? "parsing" : "preparing",
        log: [{ kind: "info", message: "Starting…", at: now(action.at) }],
      }
    }

    case "PARSE_EVENT":
      // Terminal is terminal. A late frame on a settled run would otherwise put
      // the phase back to "parsing" while keeping the finished outcome — a
      // running card with a terminal verdict and no further frames coming.
      if (state.phase === "done") return state
      return reduceParseEvent(state, action.event, now(action.at))

    case "PHASE_EVENT":
      // Only `progress` is guarded here, and the asymmetry with PARSE_EVENT is
      // the point: for a phase run, "done" is not necessarily terminal. A parse
      // settles to "done" and the automatic grouping that follows is the SAME
      // run continuing, so `start`, `complete` and `error` must all still land
      // on a settled state. `progress` never can — it cannot open a phase, so a
      // progress frame arriving after one ended could only put the card back to
      // "grouping" while carrying a finished outcome, with no frames to follow.
      if (state.phase === "done" && action.event.type === "progress") return state
      return reducePhaseEvent(state, action.kind, action.event, now(action.at))

    case "STREAM_DROPPED": {
      if (state.phase === "done") return state
      return {
        ...state,
        phase: "done",
        // A drop the server never confirmed is the end of the detachment too:
        // keeping it would leave a terminal card reading the detached branch of
        // `progressOf` and the last polled counters beside a failed summary.
        detached: false,
        serverProgress: null,
        outcome: state.createdIds.length > 0 || processedCount(state) > 0 ? "partial" : "failed",
        droppedWithoutCompletion: true,
        errors: [
          ...state.errors,
          action.reason === "interrupted"
            ? "The connection was interrupted. Work already started may still finish."
            : "The connection ended before the run reported completion.",
        ],
        ...appendLog(state, { kind: "error", message: "Connection lost before completion", at: now(action.at) }),
      }
    }

    case "STREAM_DETACHED": {
      if (state.phase === "done") return state
      // A dropped transport is not the run's failure, so nothing enters
      // `errors`: the card must not show a failure the server never reported.
      // `attached` marks the other way in — the server refused a second run
      // because one is already going. The run was never lost here, and the
      // route sends that frame before any manifest, so the card is still on its
      // "preparing" reservation and needs the same promotion SERVER_PROGRESS
      // gives an observed run.
      const attached = action.attached ?? state.attachedRun
      return {
        ...state,
        detached: true,
        attachedRun: attached,
        phase: attached && state.phase === "preparing" ? "parsing" : state.phase,
        ...appendLog(state, {
          kind: "info",
          message: attached
            ? "Watching a run that is already in progress"
            : "Connection lost — still collecting on the server",
          at: now(action.at),
        }),
      }
    }

    case "SERVER_PROGRESS": {
      if (state.phase === "done") return state
      // A live progress frame is proof the server is parsing, so a card still
      // on its "preparing" reservation is promoted — otherwise a run observed
      // from the server alone (no streamed manifest to move the phase) would
      // sit on "Preparing…" for its whole duration while the work is visibly
      // under way. Every other phase is left exactly as the stream left it.
      return {
        ...state,
        phase: state.phase === "preparing" ? "parsing" : state.phase,
        serverProgress: action.progress,
      }
    }

    case "SERVER_SETTLED": {
      if (state.phase === "done") return state
      // The same fold as `parse_complete`: the server's errors land in the
      // bounded log exactly as a streamed completion would put them there.
      const folded = (action.results?.errors ?? []).reduce(
        (acc, e) => {
          const { log, dropped } = pushLog(acc.log, { kind: "error", message: e, at: now(action.at) })
          return { log, droppedLogEntries: acc.droppedLogEntries + dropped }
        },
        { log: state.log, droppedLogEntries: state.droppedLogEntries }
      )
      const next: ProcessingState = {
        ...state,
        // The stream froze these rows at the drop; the server settled every
        // source in the manifest. Without this the summary and the bar report
        // "2 of 12" on a run the server finished — a card contradicting itself
        // on the very path (a CDN drop) this feature exists for. A source the
        // server *failed* shows as done here; its message is already in
        // `errors` and the full log.
        sources: state.sources.map(s => (isSettled(s) ? s : { ...s, state: "done" as const })),
        finalResults: action.results ?? {},
        errors: [...state.errors, ...(action.results?.errors ?? [])],
        ...folded,
        detached: false,
        serverProgress: null,
      }
      return {
        ...next,
        phase: "done",
        outcome:
          action.status === "stopped" ? "stopped" : next.errors.length > 0 ? "partial" : "success",
      }
    }

    case "FATAL": {
      if (state.phase === "done") return state
      return {
        ...state,
        phase: "done",
        outcome: processedCount(state) > 0 ? "partial" : "failed",
        errors: [...state.errors, action.message],
        ...appendLog(state, { kind: "error", message: action.message, at: now(action.at) }),
      }
    }

    case "STOP": {
      // A stop that lands on an already-settled run must STILL bump.
      //
      // Whoever bumps the controller's generation mirror must see the reducer
      // bump too, or the mirror sits one ahead forever: every subsequent frame
      // carries a generation the reducer no longer recognises, the guard above
      // drops it, and the card is wedged on "Preparing…" with every control
      // disabled until a reload. The two counters move in lockstep or not at
      // all.
      //
      // Since the controller moved its state out of React (`stateRef` in
      // use-post-processing.ts) it reads the settled phase synchronously and
      // stops dispatching STOP at all in this case, so this branch is now a
      // backstop rather than the live path. It stays: the reducer is a pure
      // module with its own callers and tests, and the invariant is the
      // reducer's to hold, not the controller's to remember.
      if (state.phase === "done" || state.phase === "idle") {
        return { ...state, generation: state.generation + 1 }
      }
      return {
        ...state,
        // Bumping the generation is what invalidates everything still in
        // flight — including the auto-grouping that would otherwise be
        // scheduled once the parse promise settles.
        generation: state.generation + 1,
        phase: "done",
        outcome: "stopped",
        sources: state.sources.map(s => (s.state === "active" ? { ...s, state: "pending" } : s)),
        ...appendLog(state, {
          kind: "info",
          message: "Stopped. Work already in flight may still finish.",
          at: now(action.at),
        }),
      }
    }

    case "DISMISS":
      // Bumps, because the controller bumps its mirror here too — see STOP.
      //
      // The run's own fields are KEPT, and `dismissed` alone retires the card.
      // AnimatedGrid replays a departing card's *element* into its exit layer,
      // where it remounts and re-reads this store (animated-grid.tsx, "Adopt
      // anything that just left") — so resetting here made the fading ghost
      // say "Processing / Starting… / 0" for the length of the exit animation
      // instead of the finished run it was retiring.
      //
      // Nothing that DECIDES whether the card is shown reads these fields —
      // `dismissed` alone does that — and the exit-layer ghost reads them on
      // purpose. Safe here because DISMISS also bumps the generation and the
      // controller closes the transports, so no later frame can re-open a
      // phase underneath the flag. SCOPE_CHANGED cannot bump (a running card
      // must survive one), which is why a phase start clears `dismissed`.
      // The next START resets from `initialProcessingState` anyway.
      return { ...state, generation: state.generation + 1, dismissed: true }

    case "SCOPE_CHANGED": {
      if (!state.scope) return state
      const sameScope =
        state.scope.sourceId === action.scope.sourceId &&
        state.scope.folderId === action.scope.folderId &&
        state.scope.view === action.scope.view
      if (sameScope) return state
      // A running card survives a scope change; a terminal one does not — it
      // describes a run that happened somewhere else.
      if (state.phase !== "done") return { ...state, scope: action.scope }
      // Retired the same way DISMISS retires one, and for the same reason: the
      // card is replayed into AnimatedGrid's exit layer, so it must still read
      // as the run it is retiring while it fades. Taking the new scope keeps a
      // second SCOPE_CHANGED on the same scope a no-op.
      return { ...state, scope: action.scope, dismissed: true }
    }

    default:
      return state
  }
}

function reduceParseEvent(state: ProcessingState, event: ParseEvent, at: number): ProcessingState {
  switch (event.type) {
    case "parse_start": {
      return {
        ...state,
        phase: "parsing",
        manifestKnown: true,
        sources: event.sources.map(s => ({
          id: s.id,
          name: s.name,
          state: "pending" as const,
          approved: 0,
          filtered: 0,
        })),
        ...appendLog(state, {
          kind: "info",
          message: event.sourceCount === 0 ? "No active sources to parse" : `Parsing ${event.sourceCount} sources`,
          at,
        }),
      }
    }

    case "source_start": {
      const id = event.sourceId ?? event.sourceName
      return {
        ...state,
        phase: state.phase === "preparing" ? "parsing" : state.phase,
        sources: patchSource(state, id, event.sourceName, { state: "active" }),
        ...appendLog(state, { kind: "start", message: `Parsing: ${event.sourceName}`, at }),
      }
    }

    case "items_fetched": {
      // The count is not tracked on the source any more — the card shows what
      // a run produced, not what it read, and this line is the log's record.
      return { ...state, ...appendLog(state, { kind: "info", message: `Fetched ${event.count} items`, at }) }
    }

    case "material_created": {
      // Deduplicate by id: a retried source can re-announce a material, and the
      // "newly collected" number must not drift.
      if (state.createdIds.includes(event.material.id)) return state
      return {
        ...state,
        createdIds: [...state.createdIds, event.material.id],
        approvedIds:
          event.material.aiEvaluation === "APPROVED"
            ? [...state.approvedIds, event.material.id]
            : state.approvedIds,
      }
    }

    case "source_complete": {
      const id = event.sourceId ?? event.sourceName
      const existing = state.sources.find(s => s.id === id)
      if (existing && isSettled(existing)) return state // settle exactly once
      return {
        ...state,
        sources: patchSource(state, id, event.sourceName, {
          state: "done",
          approved: event.stats?.approved ?? 0,
          filtered: event.stats?.filtered ?? 0,
        }),
        ...appendLog(state, {
          kind: "success",
          message: `Completed: ${event.sourceName} (${event.stats?.approved ?? 0} approved, ${event.stats?.filtered ?? 0} filtered)`,
          at,
        }),
      }
    }

    case "parse_complete": {
      // N errors at once, so the fold carries the drop count the same way a
      // single append would — the buffer must not lose track of what it shed.
      const folded = (event.results?.errors ?? []).reduce(
        (acc, e) => {
          const { log, dropped } = pushLog(acc.log, { kind: "error", message: e, at })
          return { log, droppedLogEntries: acc.droppedLogEntries + dropped }
        },
        { log: state.log, droppedLogEntries: state.droppedLogEntries }
      )
      const next: ProcessingState = {
        ...state,
        finalResults: event.results ?? {},
        errors: [...state.errors, ...(event.results?.errors ?? [])],
        ...folded,
      }
      return { ...next, phase: "done", outcome: settleOutcome(next) }
    }

    case "error": {
      // Normalize both payload shapes. Reading only `message` is what made the
      // subscription gate render nothing at all.
      const refusal = readRefusal(event)
      const message = event.message ?? event.error ?? (refusal ? refusalCopy(refusal) : "Processing failed")
      const isSourceLevel = Boolean(event.sourceId || event.sourceName)

      if (isSourceLevel) {
        const id = event.sourceId ?? event.sourceName!
        const existing = state.sources.find(s => s.id === id)
        if (existing && isSettled(existing)) return state
        return {
          ...state,
          // A failed source counts as processed — the run is not stuck on it.
          sources: patchSource(state, id, event.sourceName, { state: "failed", error: message }),
          errors: [...state.errors, message],
          ...appendLog(state, { kind: "error", message, at }),
        }
      }

      // Run-level: terminal for the whole run.
      const refused = refuseRun(state, event, at)
      if (refused) return refused
      const next: ProcessingState = {
        ...state,
        errors: [...state.errors, message],
        // A refusal after earlier work (a session that ended while a dropped
        // run was being followed) settles as partial, but the refusal is kept:
        // the card offers its fix, and the post-run refresh is skipped for it.
        refusal: refusal ?? state.refusal,
        detached: false,
        serverProgress: null,
        ...appendLog(state, { kind: "error", message, at }),
      }
      return { ...next, phase: "done", outcome: processedCount(next) > 0 ? "partial" : "failed" }
    }

    default:
      return state
  }
}

function reducePhaseEvent(
  state: ProcessingState,
  kind: "group" | "refilter",
  event: PhaseEvent,
  at: number
): ProcessingState {
  const phase = kind === "group" ? "grouping" : "refiltering"

  switch (event.type) {
    case "start":
      return {
        ...state,
        kind: state.kind ?? kind,
        phase,
        outcome: null,
        // Re-opening a phase un-retires the card. SCOPE_CHANGED retires a
        // terminal one WITHOUT bumping the generation (a running card has to
        // survive a view switch), and a phase start is explicitly allowed to
        // land on a settled run — the auto-group that follows a parse is the
        // same run continuing. Without this, switching tabs in the window
        // between `parse_complete` and the grouping stream's first frame left
        // the run live but permanently retired: the card came back, grouped,
        // and was yanked from the grid at the moment it would have shown its
        // result. DISMISS has no such window — it bumps the generation and
        // closes the transports, so no later frame can re-open a phase under
        // the flag.
        dismissed: false,
        phaseProgress: { current: 0, total: event.total },
        ...appendLog(state, {
          kind: "info",
          message: kind === "group" ? "Grouping approved materials into stories…" : "Re-filtering materials…",
          at,
        }),
      }

    case "progress":
      return { ...state, phase, phaseProgress: { current: event.current, total: event.total } }

    case "complete": {
      const numeric = Object.fromEntries(
        Object.entries(event).filter(([k, v]) => k !== "type" && typeof v === "number")
      ) as Record<string, number>
      return {
        ...state,
        phase: "done",
        outcome: state.errors.length > 0 ? "partial" : "success",
        phaseResult: numeric,
        phaseProgress: null,
        ...appendLog(state, {
          kind: "complete",
          message:
            kind === "group"
              ? `Grouped into ${event.storiesCreated ?? 0} new + ${event.storiesUpdated ?? 0} updated stories`
              : `Re-filtered: ${event.flippedToApproved ?? 0} approved, ${event.flippedToFiltered ?? 0} filtered`,
          at,
        }),
      }
    }

    case "error": {
      const refused = refuseRun(state, event, at)
      if (refused) return refused
      const refusal = readRefusal(event)
      // The parse before an automatic grouping did its work; only the grouping
      // was refused, so the run is partial and the reason says which part.
      const message = refusal
        ? `${kind === "group" ? "Story grouping" : "Re-filtering"} skipped. ${refusalCopy(refusal)}`
        : event.message ?? (kind === "group" ? "Story grouping failed" : "Re-filtering failed")
      return {
        ...state,
        // Kept so the card can still offer the way past it (a sign-in link).
        refusal: refusal ?? state.refusal,
        phase: "done",
        // The parse that preceded it still produced posts; the run is partial,
        // not failed. An attached run knows that only from its final results.
        outcome:
          state.createdIds.length > 0 || processedCount(state) > 0 || state.finalResults
            ? "partial"
            : "failed",
        errors: [...state.errors, message],
        phaseProgress: null,
        ...appendLog(state, { kind: "error", message, at }),
      }
    }

    default:
      return state
  }
}
