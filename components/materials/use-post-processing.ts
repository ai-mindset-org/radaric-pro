"use client"

/**
 * The one controller behind every processing run on the posts surface (RAD-318).
 *
 * `MaterialsList` used to own three EventSources, eight pieces of progress
 * state, a promise that was deliberately never settled, and the auto-grouping
 * decision — all inline. This hook owns the transports and nothing else: every
 * state transition goes through the pure reducer in
 * `lib/materials/processing-state.ts`, so the awkward cases are decided there
 * and tested without a browser.
 *
 * Three rules the old code did not have:
 *
 * 1. **Every run has a generation, and it is the only stop mechanism.** Stop
 *    bumps it, which makes every frame still in flight inert — including the
 *    auto-grouping that used to be suppressed only by leaving `parseAllFeeds`'s
 *    promise permanently pending (`materials-list.tsx:466`/`:881`). Settling
 *    that promise without this guard would have silently re-enabled grouping
 *    after Stop, which is why the two changes had to land together.
 *
 * 2. **Every stream settles exactly once.** `runStream` resolves on the
 *    terminal event, on `onerror`, on stop, and on unmount — whichever comes
 *    first — so no `await` outlives the run that created it.
 *
 * 3. **The list is refreshed once, at the end.** Streamed materials arrive
 *    through `onMaterial` as they always did; the completion no longer clears
 *    them before the server data lands, which is what produced the flash of an
 *    empty grid between "done" and `router.refresh()`.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import {
  processingReducer,
  initialProcessingState,
  isRefusalOutcome,
  type ProcessingState,
  type ProcessingAction,
  type Phase,
  type ParseEvent,
  type PhaseEvent,
  type OperationKind,
  type ServerProgress,
} from "@/lib/materials/processing-state"
import type { ParseRunSnapshot } from "@/lib/parse-runs"
import { followServerRun, readRunSnapshot, STATUS_POLL_MS } from "@/lib/parse-run-follow"
import { isSignedOutResponse, UNAUTHORIZED } from "@/lib/stream-refusal"

export interface UsePostProcessingOptions {
  /** Non-null on /feeds/[id]: the run and the card are scoped to that source. */
  sourceId?: string | null
  /** Non-null on /folders/[id]: the run and the card are scoped to that folder. */
  folderId?: string | null
  /** The folder's visible member source ids — Run Parsing parses exactly these. */
  folderSourceIds?: string[]
  /** The selected view, so a terminal card does not outlive its context. */
  view: string
  /** A material streamed in mid-run, for optimistic insertion into the grid. */
  onMaterial?: (material: { id: string } & Record<string, unknown>) => void
  /** A stored material reconciled mid-run (RAD-359) — merge by id, never insert. */
  onMaterialUpdated?: (material: { id: string } & Record<string, unknown>) => void
  /** Called once, after a run reaches a terminal state, to re-read the server. */
  onRefresh?: () => void
  /** Auto-group approved posts after a parse. Default true; matches today. */
  autoGroup?: boolean
  /**
   * The automatic first run. The server owns it — the card only watches — so
   * `start` is awaited but never aborted, and unmounting detaches the observer
   * without touching the run. Null on every visit but an eligible first one.
   */
  firstRun?: { sourceCount: number; start: () => Promise<void> } | null
}

/**
 * The run state as a subscribable store rather than a render value (RAD-318).
 *
 * A parse pushes ~130 frames through the reducer. If the resulting state were
 * returned from the hook, each frame would re-render `MaterialsList`, and
 * `AnimatedGrid`'s layout effect — which has no dependency array by design, the
 * FLIP needs a rect snapshot after every commit — would measure every live cell
 * on every one of them. Measured before this change: 126 frames, 130 measure
 * passes, 9,805 `getBoundingClientRect` calls on grid cells. After: 59 and
 * 4,244, i.e. one pass per frame that genuinely inserts a card.
 *
 * So the full state leaves the render path. `ProcessingCell` subscribes to it
 * with `useSyncExternalStore` and is the only thing that re-renders per frame;
 * `MaterialsList` re-renders only when one of the coarse slices below changes,
 * or when a streamed material genuinely adds a card.
 */
export interface ProcessingStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ProcessingState
  /** SSR has no run in flight; the initial state is a stable module constant. */
  getServerSnapshot: () => ProcessingState
}

export interface PostProcessing {
  /** The full run state, for the one cell that renders it. Never read in render. */
  store: ProcessingStore
  /** A run is occupying the card; every conflicting action is disabled. */
  isRunning: boolean
  /** A terminal card is present and has not been dismissed. */
  isTerminal: boolean
  /** The run's phase, for the toolbar's label. */
  phase: Phase
  startParse: () => void
  startGrouping: () => void
  startRefilter: () => void
  stop: () => void
  dismiss: () => void
}

/**
 * Everything the posts screen needs from a run — whether one is going, whether
 * a finished card is still up, what to call the current phase — is a function
 * of these two fields, so one subscription carries all three.
 *
 * A string rather than an object on purpose: `useSyncExternalStore` skips the
 * re-render only when the snapshot is `Object.is`-equal to the previous one,
 * and an object rebuilt on every call never is — it would re-render the grid
 * on every frame, which is the bug this file exists to fix.
 */
type RunKey = `${Phase}|${"live" | "dismissed"}`

const runKeyOf = (state: ProcessingState): RunKey =>
  `${state.phase}|${state.dismissed ? "dismissed" : "live"}`

const initialRunKey = runKeyOf(initialProcessingState)

type StreamOutcome = "settled" | "dropped" | "interrupted" | "aborted"

/**
 * What the mount check learned (RAD-347). `free` means "nothing to attach and
 * nothing to fear" — the automatic first run may proceed; `failed` is a check
 * that learned nothing at all, which for that decision is the same thing.
 */
type MountCheckAnswer = "running" | "free" | "failed"

const TERMINAL_PARSE_EVENTS = new Set(["parse_complete"])

/** The card's live counters from a running snapshot. */
function serverProgressOf(snapshot: ParseRunSnapshot) {
  return {
    processed: snapshot.processed,
    total: snapshot.total,
    approved: snapshot.approved,
    collected: snapshot.approved + snapshot.filtered,
  }
}

/**
 * Whether a settled run earns the post-run refresh. A run the server refused
 * changed nothing; and for a signed-out user the refresh is a navigation — the
 * proxy bounces it to the sign-in page — that takes the card explaining why
 * with it, even when earlier work in the run (a parse before its refused
 * grouping) did land (RAD-406).
 */
function refreshesAfter(state: ProcessingState): boolean {
  if (state.refusal?.code === UNAUTHORIZED) return false
  return !(state.phase === "done" && isRefusalOutcome(state.outcome))
}

export function usePostProcessing(options: UsePostProcessingOptions): PostProcessing {
  const { sourceId = null, folderId = null, folderSourceIds, view, onMaterial, onMaterialUpdated, onRefresh, autoGroup = true, firstRun = null } = options

  // Read at run time, not at callback-creation time: a `router.refresh()` (or a
  // tab-level membership change) must not leave a stale member list to a later
  // Run Parsing press.
  const folderSourceIdsRef = useRef(folderSourceIds)
  useEffect(() => {
    folderSourceIdsRef.current = folderSourceIds
  })

  /**
   * The reducer's state, held outside React so a frame does not re-render the
   * posts grid. Everything that used to read `state` now reads `stateRef`,
   * which is also strictly more correct: a callback created before a run
   * started used to close over a stale `state`.
   */
  const stateRef = useRef<ProcessingState>(initialProcessingState)
  const listenersRef = useRef(new Set<() => void>())

  const store = useMemo<ProcessingStore>(
    () => ({
      subscribe: listener => {
        listenersRef.current.add(listener)
        return () => {
          listenersRef.current.delete(listener)
        }
      },
      getSnapshot: () => stateRef.current,
      getServerSnapshot: () => initialProcessingState,
    }),
    []
  )

  /**
   * Stable for the life of the hook (`[]`), so the dependency arrays that name
   * it below never re-fire — it is listed only because eslint cannot tell this
   * from React's own `useReducer` dispatch, which it special-cases.
   */
  const dispatch = useCallback((action: ProcessingAction) => {
    const next = processingReducer(stateRef.current, action)
    // The reducer returns the same object for an action it drops (a stale
    // generation, a duplicate terminal event). Notifying on those would undo
    // the point of this file.
    if (next === stateRef.current) return
    stateRef.current = next
    // A copy: a listener that unsubscribes while being notified would otherwise
    // mutate the set mid-iteration.
    for (const listener of [...listenersRef.current]) {
      try {
        listener()
      } catch (error) {
        // One bad subscriber must not cost the others their frame — an
        // uncaught throw here would abort the loop, and every listener after
        // it would silently miss this frame and every later one until the
        // next dispatch happened to arrive.
        console.error("processing store listener threw", error)
      }
    }
  }, [])

  const runKey = useSyncExternalStore(
    store.subscribe,
    useCallback(() => runKeyOf(stateRef.current), []),
    useCallback(() => initialRunKey, [])
  )
  // Split rather than sliced, so the separator lives in exactly one place: the
  // `RunKey` template type above. Re-parsing by index would keep compiling if a
  // `Phase` ever contained the separator, and `isRunning` would quietly invert.
  const [phase, liveness] = runKey.split("|") as [Phase, "live" | "dismissed"]
  const isRunning = phase !== "idle" && phase !== "done"
  const isTerminal = phase === "done" && liveness === "live"

  /**
   * The generation as the async world sees it. The reducer owns the same number
   * in state; this mirror exists so an in-flight callback can compare against
   * the current run without going through a render. The two move in lockstep:
   * every place that bumps one bumps the other — START, STOP and DISMISS — and
   * nowhere else. A mirror even one ahead drops every later frame silently.
   *
   * The mirror used to also paper over a stale read: the phase came from the
   * last committed render, so a terminal frame that had not been flushed yet
   * let a Stop click through. `stateRef` below is updated synchronously by
   * `dispatch`, so that particular race is gone — `stop` now sees the settled
   * run and no-ops instead of retiring a card that legitimately says "Done".
   */
  const generationRef = useRef(0)
  const sourcesRef = useRef<EventSource[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // Callbacks are read through refs so that changing one mid-run does not
  // restart anything or leave a stream holding a stale closure.
  const onMaterialRef = useRef(onMaterial)
  const onMaterialUpdatedRef = useRef(onMaterialUpdated)
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onMaterialRef.current = onMaterial
    onMaterialUpdatedRef.current = onMaterialUpdated
    onRefreshRef.current = onRefresh
  })

  const isCurrent = useCallback((generation: number) => {
    return mountedRef.current && generation === generationRef.current
  }, [])

  /**
   * Every open `runStream` promise's resolver. A closed `EventSource` fires no
   * further `message` or `error`, so whoever closes one has to settle the
   * promise waiting on it — otherwise the `await` in `startParse` stays
   * suspended for the life of the page, holding its whole closure, once per
   * stop and once per unmount-mid-run.
   */
  const settlersRef = useRef(new Set<(outcome: StreamOutcome) => void>())

  const closeAll = useCallback(() => {
    for (const es of sourcesRef.current) es.close()
    sourcesRef.current = []
    for (const settle of [...settlersRef.current]) settle("aborted")
    settlersRef.current.clear()
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      // Unmount invalidates every in-flight callback through `isCurrent`, then
      // tears the transports down. The generation is deliberately NOT bumped
      // here: it mirrors the reducer's own number, and StrictMode replays this
      // cleanup on a component that then keeps running — a bump would leave the
      // mirror one ahead and silently drop every dispatch of the next run.
      mountedRef.current = false
      closeAll()
    }
  }, [closeAll])

  // A view or source change retires a terminal card that described a different
  // context. A running card stays — the work is still happening.
  useEffect(() => {
    dispatch({ type: "SCOPE_CHANGED", scope: { sourceId, folderId, view } })
  }, [dispatch, sourceId, folderId, view])

  /**
   * Open one SSE stream and resolve exactly once. `handle` returns true when the
   * frame it just processed was terminal for this stream. `onTransportLoss`, when
   * given, runs SYNCHRONOUSLY as the connection dies — a card that only learns it
   * is detached one microtask later re-renders as a failure in between.
   */
  const runStream = useCallback(
    (
      url: string,
      generation: number,
      handle: (data: Record<string, unknown>) => boolean,
      onTransportLoss?: (reason: "dropped" | "interrupted") => void
    ): Promise<StreamOutcome> => {
      return new Promise<StreamOutcome>(resolve => {
        if (!isCurrent(generation)) {
          resolve("aborted")
          return
        }

        const es = new EventSource(url)
        sourcesRef.current.push(es)

        let done = false
        const settle = (outcome: StreamOutcome) => {
          if (done) return
          done = true
          es.close()
          sourcesRef.current = sourcesRef.current.filter(s => s !== es)
          settlersRef.current.delete(settle)
          resolve(outcome)
        }
        settlersRef.current.add(settle)

        es.onmessage = event => {
          // A frame that arrives after stop, after unmount, or from a
          // superseded run is dropped before it can reach the reducer.
          if (!isCurrent(generation)) {
            settle("aborted")
            return
          }
          let data: Record<string, unknown>
          try {
            data = JSON.parse(event.data)
          } catch {
            return // heartbeat comments never reach onmessage; this is real corruption
          }
          if (handle(data)) settle("settled")
        }

        es.onerror = () => {
          if (!isCurrent(generation)) {
            settle("aborted")
            return
          }
          // `onerror` also fires with readyState CONNECTING for a blip the
          // browser is about to retry — and these streams sit behind a CDN, so
          // that is not hypothetical. None of the three routes can resume a
          // run, so we stop either way; what changes is what the card says.
          const reason = es.readyState === EventSource.CLOSED ? "dropped" : "interrupted"
          onTransportLoss?.(reason)
          settle(reason)
        }
      })
    },
    [isCurrent]
  )

  /**
   * The run outlived its transport, so the server is the only source of truth:
   * poll `GET /api/parse-stream/status` until the run settles. Resolves
   * "settled" once the terminal snapshot has been dispatched, "dropped" when the
   * registry has nothing to say (no record, a malformed body, the failure cap or
   * the detached ceiling), and "aborted" when the run is torn down under it.
   *
   * It registers with `settlersRef`, so `closeAll` — stop, dismiss, unmount, a
   * new run — clears the timer and resolves the wait as aborted. Otherwise the
   * `await` in `startParse` would outlive the card that created it.
   */
  const awaitServerRun = useCallback(
    (
      generation: number,
      reason: "dropped" | "interrupted",
      run: { runId?: string | null; acceptFinishedRun?: boolean } = {}
    ): Promise<"settled" | "dropped" | "refused" | "aborted"> => {
      // The poll loop is shared with the feed card (RAD-407); this wrapper only
      // turns its answers into reducer actions and ties it to `closeAll`.
      const controller = new AbortController()
      const abortPoll = (outcome: StreamOutcome) => {
        if (outcome === "aborted") controller.abort()
      }
      settlersRef.current.add(abortPoll)

      return followServerRun({
        signal: controller.signal,
        isCurrent: () => isCurrent(generation),
        runId: run.runId,
        acceptFinishedRun: run.acceptFinishedRun,
        onProgress: snapshot =>
          dispatch({ type: "SERVER_PROGRESS", generation, progress: serverProgressOf(snapshot) }),
      }).then(result => {
        settlersRef.current.delete(abortPoll)
        if (result.outcome === "settled") {
          const { snapshot } = result
          dispatch({
            type: "SERVER_SETTLED",
            generation,
            status: snapshot.status === "stopped" ? "stopped" : "done",
            results: snapshot.results ?? {},
          })
          return "settled"
        }
        if (result.outcome === "unauthorized") {
          // The session ended mid-follow: the same refusal startParse reads off
          // a bounced sources listing, so the card says how to fix it.
          dispatch({ type: "PARSE_EVENT", generation, event: { type: "error", code: UNAUTHORIZED } })
          return "refused"
        }
        if (result.outcome === "gone") {
          // The registry cannot tell us what happened; the run is a drop, with
          // the reason the transport itself gave.
          dispatch({ type: "STREAM_DROPPED", generation, reason })
          return "dropped"
        }
        return "aborted"
      })
    },
    [dispatch, isCurrent]
  )

  const startRun = useCallback(
    (kind: OperationKind, run: (generation: number) => Promise<void>) => {
      const current = stateRef.current.phase
      if (current !== "idle" && current !== "done") return // double-start guard
      manualStartedRef.current = true
      closeAll()
      const generation = generationRef.current + 1
      generationRef.current = generation
      dispatch({ type: "START", kind, scope: { sourceId, folderId, view } })

      void run(generation)
        .catch(error => {
          if (!isCurrent(generation)) return
          const message = error instanceof Error ? error.message : String(error)
          dispatch({ type: "FATAL", generation, message })
        })
        .finally(() => {
          // One refresh per run, and only for the run that is still current —
          // a stopped run refreshes from its own stop handler instead.
          if (isCurrent(generation) && refreshesAfter(stateRef.current)) onRefreshRef.current?.()
        })
    },
    [closeAll, dispatch, isCurrent, sourceId, folderId, view]
  )

  /** `group-stories` and `refilter` share one start/progress/complete/error shape. */
  const runPhaseStream = useCallback(
    async (kind: "group" | "refilter", generation: number) => {
      const base = kind === "group" ? "/api/posts/group-stories" : "/api/posts/refilter"
      const scope = sourceId
        ? `?feedId=${encodeURIComponent(sourceId)}`
        : folderId
          ? `?folderId=${encodeURIComponent(folderId)}`
          : ""
      const url = `${base}${scope}`

      const outcome = await runStream(url, generation, data => {
        const event = data as unknown as PhaseEvent
        dispatch({ type: "PHASE_EVENT", generation, kind, event })
        return event.type === "complete" || event.type === "error"
      })

      if (outcome === "dropped" || outcome === "interrupted") {
        dispatch({ type: "STREAM_DROPPED", generation, reason: outcome })
      }
    },
    [dispatch, runStream, sourceId, folderId]
  )

  /** The parse stream, plus the grouping phase it triggers when it produced posts. */
  /**
   * The tail shared by every detached settle (RAD-347): the dropped transport
   * and an attached run converge here, so the auto-group gate has one home and
   * cannot drift between them.
   */
  const finishDetachedRun = useCallback(
    async (generation: number) => {
      // A run the server recorded as stopped — another tab's stop landed while
      // this card was polling — must not schedule grouping over it.
      if (stateRef.current.outcome === "stopped") return
      // The server's reconciled approval decides the gate, exactly as the
      // streamed total would have.
      const approved = stateRef.current.finalResults?.approved ?? 0
      if (!autoGroup || approved === 0) return
      if (!isCurrent(generation)) return
      await runPhaseStream("group", generation)
    },
    [autoGroup, isCurrent, runPhaseStream]
  )

  const startParse = useCallback(() => {
    startRun("parse", async generation => {
      let sourceIds: string[]

      if (sourceId) {
        sourceIds = [sourceId]
      } else if (folderId) {
        // Folder scope: parse exactly the folder's member sources. An empty
        // list falls through to the zero-source manifest, never account-wide.
        sourceIds = folderSourceIdsRef.current ?? []
      } else {
        const controller = new AbortController()
        abortRef.current = controller
        const response = await fetch("/api/feeds?active=true", { signal: controller.signal })
        if (!isCurrent(generation)) return
        // RAD-406: the proxy bounces a signed-out JSON caller to the sign-in
        // page, so `fetch` lands on HTML with `ok: true`. That is the same
        // refusal the streams send in-band, and it settles the card the same way.
        if (isSignedOutResponse(response)) {
          dispatch({ type: "PARSE_EVENT", generation, event: { type: "error", code: UNAUTHORIZED } })
          return
        }
        if (!response.ok) throw new Error("Failed to fetch the list of sources")
        const active: Array<{ id: string }> = await response.json()
        if (!isCurrent(generation)) return
        sourceIds = active.map(s => s.id)
      }

      if (sourceIds.length === 0) {
        // The server sends the same manifest for a zero-source run; going
        // through the reducer keeps one code path for "nothing to do".
        dispatch({
          type: "PARSE_EVENT",
          generation,
          event: { type: "parse_start", sourceCount: 0, sources: [] },
        })
        dispatch({ type: "PARSE_EVENT", generation, event: { type: "parse_complete", results: {} } })
        return
      }

      let approved = 0
      // The server's id for this run, from `parse_start`: a drop follows THIS
      // run, never an earlier one the registry still keeps (RAD-407).
      let runId: string | null = null
      // RAD-347: the server refuses a second run with a run-level "already
      // running" error. That is not this card's failure — the run exists and is
      // watchable — so it detaches instead of ending.
      let attachToExisting = false
      const outcome = await runStream(
        `/api/parse-stream?sourceIds=${sourceIds.join(",")}`,
        generation,
        data => {
          const event = data as unknown as ParseEvent
          if (event.type === "material_created" && event.material) {
            onMaterialRef.current?.(event.material)
          }
          if (event.type === "material_updated" && event.material) {
            onMaterialUpdatedRef.current?.(event.material)
          }
          if (event.type === "source_complete") {
            approved += event.stats?.approved ?? 0
          }
          if (event.type === "parse_start" && typeof event.runId === "string") runId = event.runId
          // Both payload keys are real: the route's two error shapes send
          // `error` and `message` respectively.
          const runLevelError = event.type === "error" && !("sourceId" in event && event.sourceId)
          if (runLevelError && /already running/i.test(event.message ?? event.error ?? "")) {
            attachToExisting = true
            // The route claims a run before the manifest, so this frame arrives
            // ALONE: the card is still `preparing`, and the run was never lost —
            // `attached` says so, and the reducer keeps the copy honest.
            dispatch({ type: "STREAM_DETACHED", generation, attached: true })
            return true
          }
          dispatch({ type: "PARSE_EVENT", generation, event })
          return TERMINAL_PARSE_EVENTS.has(event.type) || runLevelError
        },
        // The parse run outlives its transport, so the drop detaches the card
        // right here — synchronously, before the promise below resolves.
        () => dispatch({ type: "STREAM_DETACHED", generation })
      )

      if (outcome === "aborted") return
      if (outcome === "dropped" || outcome === "interrupted" || attachToExisting) {
        // The transport died (or the server refused a second run); either way
        // the run did not. Stay non-terminal and let the server's registry
        // settle it — only then is the outcome knowable.
        const reason = outcome === "dropped" || outcome === "interrupted" ? outcome : "dropped"
        // A refused second run has no id of its own to follow; the refusal is
        // proof the registry holds the running run, so it may be taken finished.
        const detached = await awaitServerRun(generation, reason, { runId, acceptFinishedRun: attachToExisting })
        if (detached !== "settled") return
        await finishDetachedRun(generation)
        return
      }

      if (!autoGroup || approved === 0) return
      if (!isCurrent(generation)) return

      await runPhaseStream("group", generation)
    })
  }, [autoGroup, awaitServerRun, dispatch, finishDetachedRun, isCurrent, runPhaseStream, runStream, sourceId, folderId, startRun])

  /**
   * RAD-347: claim a run this card did not start. The card opens in the
   * detached state — the server owns the run, the card only watches — and then
   * rides the same poll-and-refresh path a dropped transport does.
   */
  const attachRun = useCallback(
    (progress: ServerProgress, expectedGeneration: number, runId: string) => {
      // A run started in this hook while the check was in flight wins: the card
      // is already driving its own run, so there is nothing to attach to.
      if (generationRef.current !== expectedGeneration) return
      if (!mountedRef.current) return
      const generation = generationRef.current + 1
      generationRef.current = generation
      dispatch({
        type: "START",
        kind: "parse",
        scope: { sourceId, folderId, view },
        attachedProgress: progress,
      })

      void (async () => {
        const outcome = await awaitServerRun(generation, "dropped", { runId })
        if (outcome !== "settled") return
        await finishDetachedRun(generation)
      })().finally(() => {
        // One refresh per attached run, exactly as a locally started one.
        if (isCurrent(generation) && refreshesAfter(stateRef.current)) onRefreshRef.current?.()
      })
    },
    [awaitServerRun, dispatch, finishDetachedRun, isCurrent, sourceId, folderId, view]
  )

  const startGrouping = useCallback(() => {
    startRun("group", generation => runPhaseStream("group", generation))
  }, [runPhaseStream, startRun])

  const startRefilter = useCallback(() => {
    startRun("refilter", generation => runPhaseStream("refilter", generation))
  }, [runPhaseStream, startRun])

  const stop = useCallback(() => {
    const generation = generationRef.current
    const { phase: currentPhase, observed } = stateRef.current
    if (currentPhase === "idle" || currentPhase === "done") return
    // An observed run belongs to the server: no transport to close, no
    // AbortSignal attached, and the ingestion continues either way. Marking it
    // "Stopped" would only cost the user the refresh that shows the results.
    if (observed) return
    // The reducer bumps its own generation on STOP; the mirror follows so that
    // in-flight callbacks see a stale number and settle as aborted.
    generationRef.current = generation + 1
    dispatch({ type: "STOP", generation })
    closeAll()
    // The run belongs to the server, so closing the transport is no longer a
    // stop: the server has to be told. Fire-and-forget — the card settles from
    // the stop itself whether or not this call lands.
    void fetch("/api/parse-stream/stop", { method: "POST" }).catch(() => {})
    // Work already dispatched server-side may have landed, so the grid is
    // refreshed here rather than left showing a half-streamed state.
    onRefreshRef.current?.()
  }, [closeAll, dispatch])

  /**
   * RAD-347: one status check per mount, so a run started elsewhere is visible
   * instead of dead-ending on "A parse is already running".
   *
   * Three answers matter. `running` claims the card (attachRun) and tells the
   * automatic first run to stand down. A `done`/`stopped` snapshot means there
   * is nothing to watch. Anything unusable — `{ run: null }`, a malformed body —
   * is not yet a verdict: the route claims the run only after auth, the rate
   * limit and two DB reads, so one unusable answer is confirmed once after a
   * poll interval before the check stands down. A failed request is not
   * confirmed at all: nothing was learned, and the user can still press Parse.
   */
  const mountCheckStartedRef = useRef(false)
  const mountFirstAnswerRef = useRef<Promise<MountCheckAnswer> | null>(null)
  useEffect(() => {
    if (mountCheckStartedRef.current) return
    mountCheckStartedRef.current = true
    let cancelled = false
    const controller = new AbortController()
    const generationAtCheck = generationRef.current
    let settleFirst: ((answer: MountCheckAnswer) => void) | null = null
    mountFirstAnswerRef.current = new Promise(resolve => {
      settleFirst = resolve
    })
    // Always answered, even when the check is torn down: the first run waits on
    // this promise, and a cancelled check must not leave it pending forever.
    const answerFirst = (answer: MountCheckAnswer) => {
      settleFirst?.(answer)
      settleFirst = null
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let wake: (() => void) | null = null
    const sleep = (ms: number) =>
      new Promise<void>(resolve => {
        wake = resolve
        timer = setTimeout(resolve, ms)
      })

    type CheckOutcome = "running" | "settled" | "unusable" | "failed"
    const check = async (): Promise<{ outcome: CheckOutcome; snapshot: ParseRunSnapshot | null }> => {
      try {
        const response = await fetch("/api/parse-stream/status", { signal: controller.signal })
        if (!response.ok) return { outcome: "failed", snapshot: null }
        const snapshot = readRunSnapshot(await response.json())
        if (!snapshot) return { outcome: "unusable", snapshot: null }
        return { outcome: snapshot.status === "running" ? "running" : "settled", snapshot }
      } catch {
        return { outcome: "failed", snapshot: null }
      }
    }

    // Attach only while the card is still this check's to claim: the generation
    // guard covers a run started here meanwhile, `phase === "idle"` covers the
    // automatic first run, which refuses to wait for the confirmation below.
    const claim = (snapshot: ParseRunSnapshot) => {
      if (cancelled || !mountedRef.current) return
      if (generationRef.current !== generationAtCheck) return
      if (stateRef.current.phase !== "idle") return
      // The registry is per user, not per scope: a card on /feeds/[id] or
      // /folders/[id] would otherwise claim a run that may not include this
      // scope and print account-wide counters under a scoped header (RAD-347 EC-4).
      if (sourceId || folderId) return
      attachRun(serverProgressOf(snapshot), generationAtCheck, snapshot.id)
    }

    void (async () => {
      const first = await check()
      answerFirst(
        first.outcome === "running" ? "running" : first.outcome === "failed" ? "failed" : "free"
      )
      if (cancelled) return
      if (first.outcome === "running" && first.snapshot) {
        claim(first.snapshot)
        return
      }
      if (first.outcome !== "unusable") return

      await sleep(STATUS_POLL_MS)
      if (cancelled || !mountedRef.current) return
      if (generationRef.current !== generationAtCheck) return
      if (stateRef.current.phase !== "idle") return

      const second = await check()
      if (cancelled) return
      if (second.outcome === "running" && second.snapshot) claim(second.snapshot)
    })()

    return () => {
      cancelled = true
      controller.abort()
      if (timer) clearTimeout(timer)
      wake?.()
      answerFirst("failed")
      // StrictMode replays setup → cleanup → setup on one instance. The
      // cleanup must invalidate THIS check's closures (above), not the effect
      // for good: the next setup runs one fresh check, and `claim`'s generation
      // and phase guards are what make a double attach impossible — not the
      // latch.
      mountCheckStartedRef.current = false
    }
  }, [attachRun, sourceId, folderId])

  /**
   * The observed first run. It starts once — scheduled in a microtask so that
   * StrictMode's mount/cleanup/mount replay cancels the first attempt before
   * anything is sent, and the live effect starts exactly one — and it never
   * opens a transport of its own.
   */
  const firstRunStartedRef = useRef(false)
  const manualStartedRef = useRef(false)
  useEffect(() => {
    if (!firstRun || firstRunStartedRef.current) return
    let cancelled = false

    queueMicrotask(async () => {
      if (cancelled || firstRunStartedRef.current) return
      // A server run this card can watch wins over the automatic first parse:
      // starting one would be a second run the server refuses anyway. Only the
      // check's FIRST answer is awaited — an unusable one confirms itself in the
      // background and must not hold the onboarding run back.
      const answer = await (mountFirstAnswerRef.current ?? Promise.resolve("free" as const))
      if (cancelled || firstRunStartedRef.current) return
      if (answer === "running") return
      // A manual run already occupying the card wins: the automatic one would
      // otherwise replace a run the user started deliberately. (Read from its
      // own ref, not from the generation — StrictMode's replay cleanup bumps
      // the generation without anything having started.)
      if (manualStartedRef.current) return
      firstRunStartedRef.current = true

      const generation = generationRef.current + 1
      generationRef.current = generation
      dispatch({
        type: "START",
        kind: "parse",
        scope: { sourceId, folderId, view },
        observed: true,
        expectedSources: firstRun.sourceCount,
      })

      firstRun
        .start()
        .then(() => {
          if (!isCurrent(generation)) return
          dispatch({ type: "PARSE_EVENT", generation, event: { type: "parse_complete", results: {} } })
          onRefreshRef.current?.()
        })
        .catch(error => {
          if (!isCurrent(generation)) return
          dispatch({
            type: "FATAL",
            generation,
            message: error instanceof Error ? error.message : String(error),
          })
        })
    })

    return () => {
      cancelled = true
    }
  }, [dispatch, firstRun, isCurrent, sourceId, folderId, view])

  const dismiss = useCallback(() => {
    // Dismiss means "this run is over for me", so it retires the generation and
    // tears the transports down in the same lockstep as STOP. Without that a
    // dismissed run would keep feeding materials into the grid while `isRunning`
    // reads false and the toolbar re-enables every conflicting action.
    const generation = generationRef.current
    generationRef.current = generation + 1
    dispatch({ type: "DISMISS", generation })
    closeAll()
  }, [closeAll, dispatch])

  return useMemo(
    () => ({ store, isRunning, isTerminal, phase, startParse, startGrouping, startRefilter, stop, dismiss }),
    [dismiss, isRunning, isTerminal, phase, startGrouping, startParse, startRefilter, stop, store]
  )
}
