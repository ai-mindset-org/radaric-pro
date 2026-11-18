/**
 * Peek URL state — the pure half of "the URL is the state" (RAD-345).
 *
 * A peek is addressed by one search param on the list route: `?post=<id>` for a
 * material, `?story=<id>` for a story. Everything here is pure so the tricky
 * parts (precedence, preserving unrelated params, idempotent comparison) are
 * unit-tested without a DOM; the wiring in `materials-list.tsx` stays thin.
 */

export type PeekKind = "post" | "story"

export type PeekTarget = { kind: PeekKind; id: string }

export const PEEK_PARAMS = { post: "post", story: "story" } as const

/**
 * Read a peek target from a search string (with or without `?`).
 *
 * `post` wins when both params are present: a post is the more specific
 * surface (a story's constituent posts are reachable from the story), and the
 * alternative — two open panels — is not a state this UI can render.
 * An empty or whitespace-only value is "no peek", not a peek with an empty id.
 */
export function parsePeek(search: string | URLSearchParams): PeekTarget | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search

  const post = params.get(PEEK_PARAMS.post)?.trim()
  if (post) return { kind: "post", id: post }

  const story = params.get(PEEK_PARAMS.story)?.trim()
  if (story) return { kind: "story", id: story }

  return null
}

/**
 * Write a target into the search string, preserving every unrelated param
 * (the list keeps none today, but a param added later must not be dropped by
 * opening a peek). Returns `""` or `"?a=b"` — never a bare `"?"`.
 */
export function peekSearch(
  search: string | URLSearchParams,
  target: PeekTarget | null
): string {
  const params = new URLSearchParams(typeof search === "string" ? search : search.toString())
  params.delete(PEEK_PARAMS.post)
  params.delete(PEEK_PARAMS.story)
  if (target) params.set(PEEK_PARAMS[target.kind], target.id)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

/** Idempotence key: "is this the same peek?" (null-safe). */
export function samePeek(a: PeekTarget | null, b: PeekTarget | null): boolean {
  if (!a || !b) return a === b
  return a.kind === b.kind && a.id === b.id
}

/** The canonical full-page route for a target — what "Open full page" points at. */
export function peekHref(target: PeekTarget): string {
  return target.kind === "post" ? `/posts/${target.id}` : `/stories/${target.id}`
}
