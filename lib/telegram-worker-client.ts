import { NOT_FOUND_MARKER, UNSUPPORTED_MARKER, type TelegramKind } from "@/lib/telegram-kind"

/**
 * HTTP client for the worker's Telegram proxy.
 *
 * Kept apart from lib/parsers/telegram.ts on purpose: that module imports the
 * whole `telegram` package plus the Prisma client at module scope, and probing
 * an entity is one plain fetch to localhost. Routes that only need the probe
 * (POST /api/feeds) shouldn't drag GramJS into their module graph.
 */

const WORKER_URL = `http://localhost:${process.env.WORKER_HEALTH_PORT || "3001"}`

/**
 * Extract a channel username from @username, username, https://t.me/username,
 * t.me/username, or /username.
 *
 * The protocol is optional on purpose: without that, "t.me/durov" parsed to the
 * literal "t.me" and we'd probe a username Telegram has never heard of. The
 * route normalizes before calling this, so that path isn't reachable today —
 * but a helper that quietly returns "t.me" is a trap for the next caller.
 */
export function extractChannelUsername(input: string): string {
  let username = input.trim()
  // [https://]t.me/username → username
  username = username.replace(/^(https?:\/\/)?(www\.)?t\.me\//i, "")
  username = username.replace(/^@/, "")
  username = username.replace(/^\/+|\/+$/g, "")
  // username/123 → username
  username = username.split("/")[0]
  return username.trim()
}

/**
 * What the worker's GramJS session says a username is.
 *
 * `not_found` is Telegram answering definitively; `unavailable` is our own
 * worker being down, reconnecting, or flood-waited. Only the former may
 * reject a feed — see validateTelegramSource.
 */
export type TelegramEntityProbe =
  | { status: "found"; kind: TelegramKind; name: string }
  /** The worker's definitive "not a public channel" (RAD-364) — never "found". */
  | { status: "refused"; kind: TelegramKind }
  | { status: "not_found" }
  | { status: "unavailable" }

/**
 * Resolve a username to its entity kind for validation.
 *
 * Deliberately one short attempt, not fetchWorkerWithRetry: that retries 6
 * times with backoff (~75s of sleeping) and counts 503 as transient — which is
 * exactly what the worker returns while its GramJS client reconnects. A user
 * waiting on "Add feed" gets one try, and an unreachable worker fails open.
 */
export async function probeTelegramEntity(
  channelUsername: string,
  timeoutMs = 5_000
): Promise<TelegramEntityProbe> {
  const cleanUsername = extractChannelUsername(channelUsername)
  if (!cleanUsername) return { status: "unavailable" }

  let response: Response
  try {
    response = await fetch(
      `${WORKER_URL}/telegram/channel-info?username=${encodeURIComponent(cleanUsername)}`,
      { signal: AbortSignal.timeout(timeoutMs) }
    )
  } catch {
    // Worker not running (ECONNREFUSED locally) or timed out.
    return { status: "unavailable" }
  }

  if (response.status === 404) {
    // A bare 404 is NOT Telegram's answer. The worker's own route table ends in
    // `writeHead(404)` for any unrouted path, so a stale container still bound
    // to 3001 mid-rolling-deploy — or a worker built before this endpoint
    // existed — would otherwise make every real channel unaddable ("No Telegram
    // channel called @durov"). The verdict has to be stated, not inferred from
    // a status code we don't exclusively own.
    const marker = await response
      .json()
      .then((d) => (d as { error?: string })?.error)
      .catch(() => undefined)
    return marker === NOT_FOUND_MARKER ? { status: "not_found" } : { status: "unavailable" }
  }
  if (response.status === 422) {
    // The worker refused the username as not a public channel (RAD-364). The
    // refusal names the kind, so a bot or a person still gets its specific
    // rejection; an unmarked 422 is not the worker's verdict.
    const refused = await response
      .json()
      .then((d) => d as { error?: string; kind?: TelegramKind })
      .catch(() => undefined)
    return refused?.error === UNSUPPORTED_MARKER
      ? { status: "refused", kind: refused.kind ?? "unknown" }
      : { status: "unavailable" }
  }
  if (!response.ok) return { status: "unavailable" }

  try {
    const data = await response.json()
    // An older worker answers 200 without `kind`; "unknown" is allowed, so a
    // rolling deploy degrades to allow rather than mis-rejecting.
    return { status: "found", kind: (data.kind ?? "unknown") as TelegramKind, name: data.name }
  } catch {
    return { status: "unavailable" }
  }
}
