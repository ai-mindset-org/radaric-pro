/**
 * Peek history plan — which History API operation an open/close performs
 * (RAD-345). Pure: the component applies the plan, this module decides it.
 *
 * The model, deliberately simple:
 *
 *   - Opening a peek PUSHES one entry, so Back returns to the clean list URL
 *     and closes the peek.
 *   - Every later target REPLACES that entry. One peek, one entry — Back always
 *     means "close the peek", never "walk a peek stack".
 *   - Closing REPLACES the entry with the clean list URL rather than calling
 *     `history.back()`. Two reasons, both from review: an outside click closes
 *     the peek *and* may be the first half of a click on another card, and a
 *     pending `back()` racing the `replaceState` of that new target could walk
 *     off the page; and `back()` leaves the pushed entry consumed, so a
 *     close-then-reopen would grow history with no way back to the list. A
 *     replace keeps exactly one entry, always.
 */

import { peekSearch, samePeek, type PeekTarget } from "./peek-state"

export type PeekNavPlan =
  | { type: "push"; url: string }
  | { type: "replace"; url: string }
  | { type: "none" }

function urlFor(pathname: string, search: string, target: PeekTarget | null): string {
  return `${pathname}${peekSearch(search, target)}`
}

/** What opening (or swapping to) `next` should do to history. */
export function planPeekOpen(input: {
  current: PeekTarget | null
  next: PeekTarget
  pathname: string
  search: string
}): PeekNavPlan {
  const { current, next, pathname, search } = input
  if (samePeek(current, next)) return { type: "none" }
  const url = urlFor(pathname, search, next)
  return current ? { type: "replace", url } : { type: "push", url }
}

/** Closing the open peek rewrites this entry back to the list URL. */
export function planPeekClose(input: { pathname: string; search: string }): PeekNavPlan {
  return { type: "replace", url: urlFor(input.pathname, input.search, null) }
}

/**
 * The neighbour of `current` in a walk order — `null` at the ends, and for a
 * target the order does not hold at all (a deep link into another filter).
 * One implementation, so the prev/next buttons and the archive advance can
 * never disagree about where the walk goes.
 */
export function peekNeighbour(
  order: PeekTarget[],
  current: PeekTarget,
  direction: "next" | "previous"
): PeekTarget | null {
  const index = order.findIndex(t => samePeek(t, current))
  if (index < 0) return null
  return order[direction === "next" ? index + 1 : index - 1] ?? null
}
