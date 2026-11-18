/**
 * How a `/api/posts` request is built for the posts surface (RAD-318).
 *
 * Before this, every read built its own `URLSearchParams` inline in
 * `MaterialsList` — the filter page, load-more and search each assembling the
 * same five parameters a few lines apart. Two of those sites had already lost
 * `sourceId` once (RAD-317), which is how a source page came to show
 * account-wide posts. A forgotten parameter is not a typo you can see in
 * review; it is an omission, and omissions are invisible by construction.
 *
 * So there is one builder, and every caller goes through it. `sourceId` is
 * attached here and only here, which makes "a source page cannot request
 * account-wide posts" a property of this module rather than a habit to keep at
 * each call site.
 *
 * Scope note: this is deliberately *only* the request. The query's lifecycle —
 * which response is still wanted, when to page, what the heading counts — stays
 * in `MaterialsList`, because the screen's real behaviour is a hybrid the
 * component owns: SSR delivers one filter-agnostic page, the client filters it,
 * and a server read happens only when that leaves too few rows to be useful. An
 * earlier draft of this module carried a full query reducer built on the
 * simpler "every query change is a fetch" model; it never matched the screen
 * and was removed rather than left sitting beside the code it did not drive.
 */

export type PostsQuery = {
  /** Status preset — INBOX, FILTERED, SENT_TO_NOTION, ARCHIVED, ALL. */
  filter: string
  /** Empty or ["ALL"] means unrestricted. */
  sourceTypes: string[]
  /** Non-null only on /feeds/[id]. Mutually exclusive with `folderId`. */
  sourceId: string | null
  /** Non-null only on /folders/[id]. Mutually exclusive with `sourceId`. */
  folderId: string | null
  search: string
}

export const PAGE_SIZE = 96

export function emptyQuery(overrides: Partial<PostsQuery> = {}): PostsQuery {
  return { filter: "INBOX", sourceTypes: ["ALL"], sourceId: null, folderId: null, search: "", ...overrides }
}

/** Unrestricted is expressed as ["ALL"] *or* []; normalize both away. */
export function isAllTypes(sourceTypes: string[]): boolean {
  return sourceTypes.length === 0 || sourceTypes.includes("ALL")
}

/**
 * The single place a `/api/posts` URL is built.
 *
 * `offset` is the caller's business, but note what it must never be: a count of
 * mounted grid cells. A story cell holds several posts and the processing card
 * holds none, so cells and rows are different quantities — paging from the
 * cell count skips or repeats posts. Pass a row offset.
 */
export function buildPostsUrl(query: PostsQuery, offset: number, limit: number = PAGE_SIZE): string {
  const params = new URLSearchParams({
    filter: query.filter,
    limit: String(limit),
    offset: String(offset),
  })
  if (!isAllTypes(query.sourceTypes)) params.set("sourceType", query.sourceTypes.join(","))
  if (query.sourceId) params.set("sourceId", query.sourceId)
  // Mutually exclusive by construction: a folder page never carries sourceId.
  else if (query.folderId) params.set("folderId", query.folderId)
  const search = query.search.trim()
  if (search) params.set("search", search)
  return `/api/posts?${params}`
}

/** Two queries are the same request when every dimension matches. */
export function sameQuery(a: PostsQuery, b: PostsQuery): boolean {
  return (
    a.filter === b.filter &&
    a.sourceId === b.sourceId &&
    a.folderId === b.folderId &&
    a.search.trim() === b.search.trim() &&
    isAllTypes(a.sourceTypes) === isAllTypes(b.sourceTypes) &&
    (isAllTypes(a.sourceTypes) || [...a.sourceTypes].sort().join(",") === [...b.sourceTypes].sort().join(","))
  )
}
