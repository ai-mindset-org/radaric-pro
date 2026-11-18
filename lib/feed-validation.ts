import { fetchFeedSummary } from "@/lib/parsers/rss"
import { probeTelegramEntity } from "@/lib/telegram-worker-client"
import { isUnreadableKind } from "@/lib/telegram-kind"

/**
 * Source validation policy — is this thing capable of ever producing material?
 *
 * Server-only. Deliberately NOT in lib/validations/feed.ts: that module is
 * imported by the client feed form, and these Node-side deps would follow it
 * into the browser bundle.
 *
 * The governing rule for both source types: only a *definitive* answer may
 * reject. Anything that is our own infrastructure failing (timeout, 5xx, WAF,
 * worker reconnecting) has to fail open — a user must never be blocked from
 * adding a good source because a probe had a bad minute.
 */

/** Per-hop budget for the feed fetch. */
const RSS_FETCH_MS = 8_000

/**
 * The real wall-clock bound on an RSS attempt, ENFORCED rather than asserted:
 * it's handed to safeFetch as a signal, so every hop aborts when it fires.
 *
 * Don't try to derive this from RSS_FETCH_MS. That budget is per redirect hop
 * (safeFetch gives each hop a fresh AbortSignal.timeout, and fetchFeedSummary
 * allows 5 redirects to match the production parser), so "8s" is really "up to
 * 48s". The signal is what makes this number true; withDeadline is only the
 * backstop for a step that never returns at all.
 *
 * 15s clears an ordinary http→https→www chain comfortably while staying inside
 * a request a user is watching. A slow-but-real feed that exceeds it fails OPEN
 * (`ok:"unknown"`), so the cost is a missing caveat, not a rejected source.
 */
const RSS_TOTAL_MS = 15_000

const TELEGRAM_PROBE_MS = 5_000

export type RssRejectCode = "NOT_A_FEED" | "DNS_NOT_FOUND" | "FEED_UNREACHABLE_BY_POLICY"

export type RssValidation =
  /** A real feed. `itemCount: 0` is valid — it earns a caveat, not a rejection. */
  | { ok: true; itemCount: number }
  /** Definitively not usable. */
  | { ok: false; code: RssRejectCode }
  /** Couldn't tell — allow it through with a caveat rather than block a good feed. */
  | { ok: "unknown" }

export type TelegramRejectCode =
  | "TELEGRAM_IS_BOT"
  | "TELEGRAM_IS_USER"
  | "TELEGRAM_NOT_FOUND"
  | "TELEGRAM_INVALID_INPUT"
  | "TELEGRAM_PRIVATE_INVITE"

export type TelegramValidation =
  | { verdict: "ok" }
  | { verdict: "reject"; code: TelegramRejectCode }
  | { verdict: "unknown" }

/**
 * Fallback prose only. The `code` is authoritative — clients map it to their
 * own copy, since a form and a bulk-import dialog need different wording for
 * the same rejection.
 */
export const TELEGRAM_REJECT_MESSAGES: Record<TelegramRejectCode, string> = {
  TELEGRAM_IS_BOT: "That's a bot, not a channel — bots have no post history to read.",
  TELEGRAM_IS_USER: "That's a personal account, not a channel.",
  TELEGRAM_NOT_FOUND: "No Telegram channel with that username.",
  TELEGRAM_INVALID_INPUT: "That isn't a public Telegram channel — paste the channel's t.me/channelname link.",
  TELEGRAM_PRIVATE_INVITE: "Private invite links can't be read — use the channel's public t.me/channelname link.",
}

export const RSS_REJECT_MESSAGES: Record<RssRejectCode, string> = {
  NOT_A_FEED: "That URL isn't an RSS or Atom feed.",
  DNS_NOT_FOUND: "That domain doesn't exist.",
  FEED_UNREACHABLE_BY_POLICY: "Radaric's servers can't reach private or local addresses.",
}

async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function probeRss(inputUrl: string, signal: AbortSignal): Promise<RssValidation> {
  const summary = await fetchFeedSummary(inputUrl, { timeoutMs: RSS_FETCH_MS, signal })
  if (summary.ok) return { ok: true, itemCount: summary.itemCount }

  switch (summary.reason) {
    // Fetched fine, and it isn't a feed. The one thing we actually proved.
    case "not_a_feed":
      return { ok: false, code: "NOT_A_FEED" }
    // A private/link-local address. Definitive (the parser could never fetch it
    // either), but it is NOT evidence the URL isn't a feed — a self-hosted
    // FreshRSS on 192.168.x.x is a real feed we simply cannot reach. Saying
    // "that isn't a feed. try /feed or /rss.xml" would be false AND send the
    // user in a loop, since every retry is refused identically.
    case "blocked":
      return { ok: false, code: "FEED_UNREACHABLE_BY_POLICY" }
    // The hostname doesn't exist. Definitive, and the shape of a typo: a dead
    // domain can never yield a post.
    case "dns_not_found":
      return { ok: false, code: "DNS_NOT_FOUND" }
    // No answer (timeout/network), or an answer that wasn't 2xx. A 403 is
    // usually a WAF and says nothing about whether a feed lives there, so
    // neither of these may reject.
    case "unreachable":
    case "http_error":
      return { ok: "unknown" }
  }
}

/**
 * Validate an RSS/Atom URL.
 *
 * Only rejects what we can prove: a URL that fetched cleanly and parsed as
 * not-a-feed, or a domain that doesn't resolve. A feed with zero items is a
 * success — a brand-new feed is legitimately empty; the caller shows a caveat.
 */
export async function validateRssSource(inputUrl: string): Promise<RssValidation> {
  // The signal is the real bound — it reaches every hop of the fetch.
  // withDeadline is the backstop for the part a signal can't abort (a parse
  // that never returns), and its fallback is fail-open by construction.
  const signal = AbortSignal.timeout(RSS_TOTAL_MS)
  return withDeadline(probeRss(inputUrl, signal), RSS_TOTAL_MS + 1_000, { ok: "unknown" })
}

/**
 * Validate a Telegram source. Rejects the things that can never yield posts —
 * bots and personal accounts have no readable history, so a feed pointed at
 * one parses successfully and returns nothing, forever.
 *
 * The worker answers 200 only for a public channel or supergroup that owns
 * the handle (RAD-364); everything else is a definitive 422 refusal, mapped
 * to the bot/user codes when the worker could say which, and to
 * TELEGRAM_INVALID_INPUT otherwise (a basic group, a private group reached by
 * its display name, a handle the channel no longer owns). Only an infra
 * failure is inconclusive.
 */
export async function validateTelegramSource(url: string): Promise<TelegramValidation> {
  const probe = await probeTelegramEntity(url, TELEGRAM_PROBE_MS)

  if (probe.status === "unavailable") return { verdict: "unknown" }
  if (probe.status === "not_found") return { verdict: "reject", code: "TELEGRAM_NOT_FOUND" }
  // The worker's refusal is definitive: it resolved the handle and it is not a
  // public channel (RAD-364). A group or an unowned handle has no specific copy.
  if (probe.status === "refused") {
    if (isUnreadableKind(probe.kind)) {
      return { verdict: "reject", code: probe.kind === "bot" ? "TELEGRAM_IS_BOT" : "TELEGRAM_IS_USER" }
    }
    return { verdict: "reject", code: "TELEGRAM_INVALID_INPUT" }
  }

  if (isUnreadableKind(probe.kind)) {
    return { verdict: "reject", code: probe.kind === "bot" ? "TELEGRAM_IS_BOT" : "TELEGRAM_IS_USER" }
  }
  return { verdict: "ok" }
}
