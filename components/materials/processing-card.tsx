"use client"

/**
 * Processing as the first card in the posts grid (RAD-318 Phase 4).
 *
 * It replaces a banner that pushed the whole grid down while it grew. The card
 * is an ordinary grid cell, so the rules it lives under are the grid's:
 *
 * **Fixed height, both modes, every breakpoint — `min-h-[300px]`.** Measured in
 * Phase 0: a text-only material card is 186px and a row runs 186–462px, so
 * 300px sits inside the existing range and never becomes the outlier that
 * stretches its row (the grid is `align-items: stretch` with no override).
 * Fixed also means a streamed event cannot change the card's height, which
 * matters more than it sounds: `animated-grid.tsx:346` runs its layout effect
 * with no dependency array, measuring every live cell on every commit and
 * animating any delta over 0.5px for up to 200 elements. A card that grew with
 * its log would re-animate the whole viewport on every frame of a parse.
 * `min-height`, never `height`, so 200% text zoom does not clip.
 *
 * **The card surface, same as a material card (RAD-344).** No `--surface-bg`
 * override: `globals.css` paints `var(--surface-bg, var(--card))` on the mask
 * pseudo-element, and a run's status panel sits in the same grid as the
 * content it is producing — a `--muted` tint read as a grey slab in light
 * theme. (Dark needed no fix: there `--card` and `--muted` are three points
 * apart.) `bg-muted` on the host stays forbidden — it would paint square
 * corners behind the mask.
 *
 * **Announcements are restrained.** The summary is `aria-live="polite"` and
 * updates on phase change and on each source settling — never per material. The
 * log is `aria-live="off"` and a plain list: `role="log"` would announce every
 * entry, which is exactly what this is meant to avoid.
 *
 * **The summary's numbers roll, the sentence stays text (RAD-355).** Two numbers
 * on one line are compared with each other, so the roll has to keep its own
 * spacing exact — NumberFlow pins each digit, which torph could not (RAD-353).
 * The visible copy is `aria-hidden` with a plain twin in the live region.
 */

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { AlertCircle, CheckCircle2, CircleSlash, Info, Loader2, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { MorphText } from "@/components/ui/morph-text"
import { MorphNumber } from "@/components/ui/morph-number"
import { SIGN_IN_PATH, UNAUTHORIZED } from "@/lib/stream-refusal"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  approvedCount,
  collectedCount,
  logTruncated,
  processedCount,
  summaryText,
  LOG_LIMIT,
  type ProcessingState,
} from "@/lib/materials/processing-state"
import type { ProcessingStore } from "./use-post-processing"

export interface ProcessingCardProps {
  state: ProcessingState
  onStop: () => void
  onDismiss: () => void
}

const PHASE_TITLE: Record<ProcessingState["phase"], string> = {
  idle: "Processing",
  preparing: "Starting",
  parsing: "Collecting posts",
  grouping: "Grouping stories",
  refiltering: "Re-filtering posts",
  done: "Processing",
}

const OUTCOME_TITLE: Record<NonNullable<ProcessingState["outcome"]>, string> = {
  success: "Done",
  partial: "Finished with problems",
  failed: "Could not finish",
  stopped: "Stopped",
  // RAD-326: refused before it started — the summary says when to retry. The
  // neutral icon, not the destructive one: nothing failed.
  rate_limited: "Not started",
  // RAD-406: refused before it started, for a reason the summary names and the
  // user can fix. Neutral for the same reason as a rate limit.
  signed_out: "Signed out",
  unverified: "Email not verified",
}

function cardTitle(state: ProcessingState): string {
  if (state.phase === "done" && state.outcome) return OUTCOME_TITLE[state.outcome]
  return PHASE_TITLE[state.phase]
}

/** The card's own progress, expressed as sources rather than materials. */
function progressOf(state: ProcessingState): { value: number; max: number } | null {
  if (state.phase === "grouping" || state.phase === "refiltering") {
    const p = state.phaseProgress
    return p && p.total > 0 ? { value: p.current, max: p.total } : null
  }
  // Detached: the streamed counters are frozen where the transport died, so the
  // server's polled numbers are the only live ones (RAD-346).
  if (state.detached) {
    const p = state.serverProgress
    return p && p.total > 0 ? { value: p.processed, max: p.total } : null
  }
  if (!state.manifestKnown || state.sources.length === 0) return null
  return { value: processedCount(state), max: state.sources.length }
}

/**
 * Split the summary into words and digit runs, so only the numbers roll.
 *
 * The whole sentence must NOT become one morph root: NumberFlow's host is
 * `nowrap` (and torph's root was too), and this line wraps at 320–375px
 * ("Collection finished — your posts are below"). Plain words keep the line
 * wrappable; each number is its own single-line token.
 */
function summaryParts(text: string): string[] {
  return text.split(/(\d+)/)
}

function LogLine({ kind, message }: { kind: string; message: string }) {
  const Icon = kind === "error" ? AlertCircle : kind === "success" || kind === "complete" ? CheckCircle2 : Info
  return (
    <li className="flex items-start gap-2 py-1">
      <Icon
        className={`mt-0.5 h-[14px] w-[14px] shrink-0 ${kind === "error" ? "text-destructive" : kind === "success" || kind === "complete" ? "text-primary" : "text-muted-foreground"}`}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{message}</span>
    </li>
  )
}

function ProcessingCardImpl({ state, onStop, onDismiss }: ProcessingCardProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [fullLogOpen, setFullLogOpen] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  const running = state.phase !== "idle" && state.phase !== "done"
  const progress = progressOf(state)
  const collected = collectedCount(state)
  const approved = approvedCount(state)
  const wasRunning = useRef(running)
  const stopClicked = useRef(false)
  // Only the user can stop this run; the server owns the observed one.
  const stoppable = running && !state.observed

  // Stop moves focus to the card's status heading, so the user is not left on a
  // control that has just disappeared — and ONLY then. A run finishing on its
  // own must not pull focus out of whatever the user is doing; the automatic
  // first parse settles about a minute after landing on /posts, and stealing
  // focus mid-word out of the search field loses the rest of their typing.
  useEffect(() => {
    if (wasRunning.current && !running && stopClicked.current) headingRef.current?.focus()
    if (!running) stopClicked.current = false
    wasRunning.current = running
  }, [running])

  // Auto-scroll only while the user is already at the bottom; otherwise reading
  // an earlier line would be interrupted by every new one.
  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [state.log])

  return (
    <Card
      className="flex min-h-[300px] flex-col gap-3 p-4"
      data-testid="processing-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Only a completed run gets the success mark. A stopped or partial
              one is not a success, and a green check on "Stopped" reads as if
              the work had finished. */}
          {running ? (
            <Loader2 className="h-[16px] w-[16px] shrink-0 animate-spin text-primary" aria-hidden="true" />
          ) : state.outcome === "failed" ? (
            <AlertCircle className="h-[16px] w-[16px] shrink-0 text-destructive" aria-hidden="true" />
          ) : state.outcome === "success" ? (
            <CheckCircle2 className="h-[16px] w-[16px] shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <CircleSlash className="h-[16px] w-[16px] shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold outline-none">
            <MorphText>{cardTitle(state)}</MorphText>
          </h2>
        </div>

        {/* No Stop for an observed run: there is no transport to close and no
            AbortSignal on the request, so the ingestion continues regardless.
            Offering the control would cost the user the completion refresh and
            tell them the run stopped when it did not. */}
        {stoppable ? (
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              stopClicked.current = true
              onStop()
            }}
            aria-label="Stop processing"
            className="min-h-[44px] min-w-[44px] shrink-0 sm:min-h-0 sm:min-w-0 sm:h-8 sm:w-8"
          >
            <Square className="h-[14px] w-[14px]" aria-hidden="true" />
          </Button>
        ) : running ? null : (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="min-h-[44px] min-w-[44px] shrink-0 sm:min-h-0 sm:min-w-0 sm:h-8 sm:w-8"
          >
            <X className="h-[16px] w-[16px]" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* The one announced region. Atomic, so it reads as a sentence. The
          numbers roll per digit (RAD-355) — NumberFlow pins each digit, so the
          spacing inside a number does not move, which is what torph could not
          promise (RAD-353). Its shadow DOM exposes the digits individually, so
          the visible copy is `aria-hidden` and the plain twin carries the
          sentence: one announcement per update, unchanged from RAD-342. */}
      <p
        aria-live="polite"
        aria-atomic="true"
        data-testid="processing-summary"
        className="text-sm text-muted-foreground"
      >
        {summaryParts(summaryText(state)).length === 1 ? (
          summaryText(state)
        ) : (
          <>
            <span aria-hidden="true">
              {summaryParts(summaryText(state)).map((part, i) =>
                /^\d+$/.test(part) ? (
                  <MorphNumber key={i} value={Number(part)} />
                ) : (
                  part
                )
              )}
            </span>
            <span className="sr-only">{summaryText(state)}</span>
          </>
        )}
      </p>

      {/* The reason, on the card itself. A terminal failure that is only legible
          inside an unopened log is a card that says nothing went wrong. While
          detached there is no failure to report — the run is still going on the
          server — so the neutral notice takes its place, and it says only what
          this card actually experienced: a run it never held was not "lost". */}
      {state.detached && running ? (
        <p className="text-sm text-muted-foreground">
          {state.attachedRun
            ? "Watching a run that is already in progress."
            : "Connection lost — still collecting on the server."}
        </p>
      ) : state.errors.length > 0 ? (
        <p className="line-clamp-2 text-sm text-destructive">{state.errors[state.errors.length - 1]}</p>
      ) : null}

      {/* RAD-406: an ended session is fixed by signing in, so the card offers
          that instead of only describing it. */}
      {!running && state.refusal?.code === UNAUTHORIZED ? (
        <Link href={SIGN_IN_PATH} className="link self-start text-sm font-medium">
          Sign in
        </Link>
      ) : null}

      {progress ? (
        // A designed bar, not the engine's own control (RAD-356): the native
        // <progress> painted a square-ended system-grey track next to a card
        // that is otherwise all hairlines and squircles. Same pattern as the
        // design system's "Progress Bar (Parsing UI)" block — pale rounded
        // track, rounded fill, width transition — and the same role/aria
        // contract the native element carried, so nothing changes for a
        // screen reader. Width only: the card's height contract stays intact.
        <div
          role="progressbar"
          aria-label="Sources processed"
          aria-valuemin={0}
          aria-valuemax={progress.max}
          aria-valuenow={progress.value}
          // Screen readers get the same sentence the summary shows.
          aria-valuetext={`${progress.value} of ${progress.max}`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15"
        >
          <div
            data-testid="processing-progress-fill"
            className="h-full rounded-full bg-green-bright transition-[width] duration-300 ease-out"
            style={{ width: `${progress.max > 0 ? Math.min(100, Math.max(0, (progress.value / progress.max) * 100)) : 0}%` }}
          />
        </div>
      ) : running ? (
        // No denominator yet: indeterminate, and honouring reduced motion.
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-green-bright motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-40" />
        </div>
      ) : null}

      {/* Counters belong to a parse. An observed run receives no frames and a
          group/re-filter run never populates `sources`, so in both cases the
          pair is structurally zero — a "0" the card cannot back up, sitting
          above a grid the refresh has already filled (observed) or directly
          beneath the result sentence that does carry the numbers (phase runs).
          Omit them rather than assert them; the observed run's real totals
          arrive from /api/stats in reportFirstResults. */}
      {state.observed || state.kind !== "parse" ? null : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {/* The two numbers a run is judged by: what it brought in, and how
              much of that survived the filter. Raw fetched items are noise —
              most are duplicates or filtered out. */}
          <div>
            <dt className="text-xs text-muted-foreground">New posts</dt>
            <MorphText as="dd" className="font-semibold" timing="fast" coalesceMs={120}>
              {collected}
            </MorphText>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">AI approved</dt>
            <MorphText as="dd" className="font-semibold" timing="fast" coalesceMs={120}>
              {approved}
            </MorphText>
          </div>
        </dl>
      )}

      {/* Details take the remaining budget and scroll inside it — the card's own
          height never changes, so the grid never re-animates. */}
      <div className="min-h-0 flex-1">
        {showDetails && (
          <div
            ref={logRef}
            aria-live="off"
            onScroll={e => {
              const el = e.currentTarget
              pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
            className="h-[100px] overflow-y-auto scrollbar-stable rounded-sm bg-background/40 px-2 text-xs sm:h-[110px]"
          >
            <ul>
              {state.log.slice(-24).map((entry, i) => (
                <LogLine key={`${entry.at}-${i}`} kind={entry.kind} message={entry.message} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDetails(v => !v)}
          aria-expanded={showDetails}
          className="min-h-[44px] sm:min-h-0 sm:h-8 px-2"
        >
          {showDetails ? "Hide details" : "Show details"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFullLogOpen(true)}
          className="min-h-[44px] sm:min-h-0 sm:h-8 px-2"
        >
          Full log
        </Button>
      </div>

      <Sheet open={fullLogOpen} onOpenChange={setFullLogOpen}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Processing log</SheetTitle>
            <SheetDescription>
              {logTruncated(state)
                ? `Showing the ${LOG_LIMIT} most recent entries; older detail is omitted.`
                : summaryText(state)}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-stable text-xs">
            <ul>
              {state.log.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="flex items-start gap-2 py-1">
                  <time
                    dateTime={new Date(entry.at).toISOString()}
                    className="shrink-0 tabular-nums text-muted-foreground"
                  >
                    {new Date(entry.at).toLocaleTimeString()}
                  </time>
                  <span className="min-w-0 break-words">{entry.message}</span>
                </li>
              ))}
            </ul>
            {state.errors.length > 0 && (
              <div className="mt-4 rounded-sm bg-destructive/10 p-2">
                <h3 className="mb-1 text-xs font-semibold text-destructive">Errors</h3>
                <ul className="space-y-1">
                  {[...new Set(state.errors)].map(error => (
                    <li key={error} className="break-words">
                      {error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  )
}

/**
 * Memoised, and now it buys something real. The run state no longer passes
 * through `MaterialsList`'s render: `ProcessingCell` below subscribes to the
 * store directly, so a parent re-render for an unrelated reason (a delete, a
 * filter change) hands this component the same `state` object and the memo
 * skips it. Per-frame re-rendering of this one card is the intended cost.
 */
export const ProcessingCard = memo(ProcessingCardImpl)

/**
 * The card as a grid cell, and the only subscriber to the run state.
 *
 * This is the whole point of `ProcessingStore`. `useSyncExternalStore` here
 * means a streamed frame re-renders this component and nothing else —
 * `MaterialsList` does not re-render, so `AnimatedGrid` does not re-render, so
 * its dependency-less layout effect does not run and does not measure every
 * live cell. Measured on a 17-source parse replayed over a 45-card grid, same
 * 126 frames both times: 130 measure passes and 9,805 cell `getBoundingClientRect`
 * calls before, 59 and 4,244 after. What is left is one pass per frame that
 * actually inserts a card, which is a layout change the FLIP has to see.
 *
 * `onStop` and `onDismiss` must be stable — an unstable one would defeat the
 * memo on every frame and put the card's own subtree back in the same hole.
 */
export function ProcessingCell({
  store,
  onStop,
  onDismiss,
}: {
  store: ProcessingStore
  onStop: () => void
  onDismiss: () => void
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  return <ProcessingCard state={state} onStop={onStop} onDismiss={onDismiss} />
}
