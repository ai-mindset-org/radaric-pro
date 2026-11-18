/**
 * What a resolved t.me username actually is.
 *
 * Dependency-free on purpose: the worker classifies GramJS entities and the
 * Next.js routes read the result, so both sides import this. It must never
 * pull in `lib/story-aggregator/worker.ts` — that module self-starts
 * (`main()` at module scope), so importing a value from it inside a route
 * would boot a second health server and hit EADDRINUSE on port 3001.
 */
export type TelegramKind =
  | "channel" // broadcast channel — what Radaric is built to read
  | "megagroup" // public supergroup — has readable history, so it works too
  | "group" // basic group (no username, so unreachable via getEntity)
  | "bot"
  | "user"
  | "unknown"

/**
 * Duck-typed so it works on a GramJS entity in the worker and on a plain
 * JSON object elsewhere without dragging the `telegram` package along.
 *
 * Unrecognized classNames (ChannelForbidden, ChatForbidden, gigagroups, …)
 * fall through to "unknown", which callers treat as allow — a real channel we
 * failed to classify must never be rejected.
 */
export function classifyEntity(entity: {
  className?: string
  bot?: boolean
  megagroup?: boolean
}): TelegramKind {
  switch (entity.className) {
    case "User":
      return entity.bot ? "bot" : "user"
    case "Channel":
      return entity.megagroup ? "megagroup" : "channel"
    case "Chat":
      return "group"
    default:
      return "unknown"
  }
}

/**
 * How the worker states "Telegram says this username doesn't exist" — in a
 * 404's JSON body, never by the status code alone.
 *
 * The worker's route table ends in a bare `writeHead(404)` for any unrouted
 * path, so a status-only check can't tell Telegram's verdict apart from "you're
 * talking to the wrong worker" (a stale container mid-rolling-deploy, or one
 * built before this endpoint existed). The former may reject a source; the
 * latter must fail open.
 *
 * Lives here because this module is the one both sides can import: the worker
 * runs under tsx with relative paths, the Next routes under the `@/` alias.
 */
export const NOT_FOUND_MARKER = "USERNAME_NOT_FOUND"

/**
 * How the worker states "this resolves, but not to a channel — refused" (RAD-364):
 * a 422 whose JSON body carries this marker and the `kind` it resolved to.
 * The worker's session is the operator's own account, so a person, a bot, a
 * basic group or the account itself must never be read on a feed's behalf.
 */
export const UNSUPPORTED_MARKER = "UNSUPPORTED_TELEGRAM_SOURCE"

/** Kinds that can never yield material, so adding them is always a mistake. */
export function isUnreadableKind(kind: TelegramKind): kind is "bot" | "user" {
  return kind === "bot" || kind === "user"
}

/**
 * Did TELEGRAM say the username doesn't exist?
 *
 * This is the ONLY resolution failure a caller may reject a source on — it's a
 * fact about the input. FLOOD_WAIT, CHANNEL_PRIVATE, auth and network failures
 * are facts about us and must fail open.
 *
 * The bar every pattern here must clear: it can only be produced AFTER a real
 * ResolveUsername round-trip. That's what makes it Telegram's answer rather
 * than ours.
 *
 * The prose patterns are load-bearing, not belt-and-braces: GramJS catches
 * USERNAME_NOT_OCCUPIED and rethrows a plain `Error` (`client/users.js`:407),
 * stripping `.errorMessage`. Matching only the RPC codes would leave the common
 * dead-handle case unreachable, so every nonexistent channel would fail open.
 *
 * Deliberately NOT matched: `Cannot find any entity corresponding to "x"`
 * (`client/users.js`:414). GramJS throws that locally, with no network call at
 * all, whenever its own `VALID_USERNAME_RE` rejects a username — and that regex
 * is stricter than `normalizeTelegramInput`'s (it requires 5+ chars, while
 * collectible handles can have 4). Treating it as definitive turns OUR
 * parsing gap into a confident "no such channel" for real, addable channels
 * like a 4-char @ab12 — the exact lie this module's contract forbids.
 */
export function isUsernameNotFoundError(err: unknown): boolean {
  const rpcCode = (err as { errorMessage?: string })?.errorMessage
  const msg = err instanceof Error ? err.message : String(err)
  return (
    // RPC codes — only ever set by a real Telegram response.
    /USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(`${rpcCode ?? ""} ${msg}`) ||
    // client/users.js:407 — rethrown from the catch around ResolveUsername, so
    // it too can only exist after Telegram answered.
    /No user has ".*" as username/.test(msg)
  )
}
