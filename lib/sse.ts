/**
 * Shared server-sent-events plumbing for the three streaming routes
 * (`/api/parse-stream`, `/api/posts/group-stories`, `/api/posts/refilter`).
 *
 * These streams do not reach the browser directly on a hosted instance: a CDN
 * in front of it rewrites response headers, and its edge rule covers `/api/*`
 * exactly as it covers documents. Measured 2026-09-11 on `/api/health`:
 *
 *   direct origin  cache-control: no-store, must-revalidate
 *   via the CDN    cache-control: private, no-cache, no-store, max-age=0, must-revalidate
 *
 * The CDN replaces the header wholesale, which means the `no-transform` these
 * routes have always set is **destroyed before the browser sees it**. Two
 * consequences, both handled here rather than per route:
 *
 * 1. `X-Accel-Buffering: no` is the header proxies actually honour for
 *    streaming. Without it, an intermediary is free to buffer a response that
 *    can legitimately emit nothing for minutes — `SOURCE_TIMEOUT_MS` is 180s,
 *    and a source can be silent between `source_start` and its first
 *    `material_created`.
 * 2. A heartbeat comment frame every 15s keeps the connection demonstrably
 *    alive through any intermediary that times out idle responses, and gives
 *    the client a way to tell "still working" from "the stream died". Comment
 *    frames (`: text`) are part of the EventSource wire format and are ignored
 *    by `onmessage`, so no client needs to know about them.
 */

import {
  EMAIL_NOT_VERIFIED,
  RATE_LIMITED,
  UNAUTHORIZED,
  refusalCopy,
  type StreamRefusal,
} from "@/lib/stream-refusal"

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // Kept for the direct-to-origin case and any future edge that respects it;
  // the CDN rewrites this one.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // The one an intermediary is most likely to honour. Not rewritten by the CDN.
  "X-Accel-Buffering": "no",
}

export const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Emit a comment frame every 15s until the returned function is called.
 * Enqueueing on a closed controller throws; that is treated as "the stream is
 * gone" and stops the timer rather than surfacing as an unhandled rejection.
 */
export function startHeartbeat(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  intervalMs: number = HEARTBEAT_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(": heartbeat\n\n"))
    } catch {
      clearInterval(timer)
    }
  }, intervalMs)

  // Never hold the Node process open for a heartbeat.
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    ;(timer as { unref: () => void }).unref()
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

/** EventSource always sends `Accept: text/event-stream`; nothing else here does. */
export function wantsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream")
}

/**
 * How long a consumer that ignores a non-rate-limit refusal waits before the
 * browser's own reconnect. Waiting does not fix a signed-out session or an
 * unverified email; this only keeps such a consumer out of a tight loop.
 */
const REFUSAL_RETRY_MS = 60_000

/** Which refusal a pre-stream response is, or null for anything else. */
async function refusalOf(refused: Response): Promise<StreamRefusal | null> {
  if (refused.status === 401) return { code: UNAUTHORIZED }
  if (refused.status === 429) {
    return { code: RATE_LIMITED, retryAfter: Math.max(1, Number(refused.headers.get("Retry-After")) || 60) }
  }
  if (refused.status === 403) {
    // A 403 is only this refusal when it says so; `clone` leaves the body for
    // the JSON caller, who gets the original response untouched.
    const body = (await refused.clone().json().catch(() => null)) as { code?: unknown } | null
    if (body?.code === EMAIL_NOT_VERIFIED) return { code: EMAIL_NOT_VERIFIED }
  }
  return null
}

/**
 * A pre-stream refusal an EventSource can read (RAD-326, RAD-406).
 *
 * EventSource fails a non-200 response without exposing its status, headers or
 * body, so a 401, a 403 EMAIL_NOT_VERIFIED or a 429 reached the UI as a dropped
 * connection. A caller that asked for an event stream gets the same refusal as
 * one well-formed SSE `error` frame with a stable `code` — `UNAUTHORIZED`,
 * `EMAIL_NOT_VERIFIED` or `RATE_LIMITED` (+ `retryAfter`) — on the same single
 * request: a rate limit is not counted twice. Every other caller, and any
 * response that is not one of these refusals, keeps the real status and body
 * (RAD-296, RAD-297).
 *
 * The frame carries the copy under both `message` and `error`, the two keys the
 * existing consumers read, and a `retry:` field — the window for a rate limit,
 * `REFUSAL_RETRY_MS` otherwise — so a consumer that does not close on the frame
 * does not reconnect in a tight loop. Our consumers close on it and never retry.
 */
export async function streamableRefusal(request: Request, refused: Response): Promise<Response> {
  if (!wantsEventStream(request)) return refused
  const refusal = await refusalOf(refused)
  if (!refusal) return refused

  const copy = refusalCopy(refusal)
  const frame = { type: "error", ...refusal, message: copy, error: copy }
  const retryMs = refusal.code === RATE_LIMITED ? refusal.retryAfter * 1000 : REFUSAL_RETRY_MS
  const headers: Record<string, string> = {
    ...SSE_HEADERS,
    // Never cache a refusal, at the edge or in the browser.
    "Cache-Control": "no-store",
  }
  if (refusal.code === RATE_LIMITED) headers["Retry-After"] = String(refusal.retryAfter)
  return new Response(`retry: ${retryMs}\ndata: ${JSON.stringify(frame)}\n\n`, { status: 200, headers })
}
