/**
 * Server sends a machine-readable `code`; the prose lives client-side, because
 * a form and a bulk-import dialog need different wording for the same
 * rejection. Each string must say what to do INSTEAD — a user who added a bot
 * wanted the channel it publishes to.
 *
 * Only POST /api/feeds validates today, so only the create form reads this. Kept
 * separate from that component because the codes are the server's contract, and
 * the next surface to validate (bulk add, edit) will need its own wording for
 * the same code.
 */

// Display only — the server validates the format, so stay permissive here or
// the copy degrades to "That" exactly when the handle is malformed.
function handleOf(url?: string) {
  const m = url?.match(/(?:t\.me\/|@)([A-Za-z0-9_+]+)/)
  return m ? `@${m[1]}` : "That"
}

/** null when the input won't parse — the copy then drops the host rather than
 * splicing a placeholder into a URL-shaped suggestion ("often that page/feed"). */
function hostOf(url?: string): string | null {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

export function rejectionCopy(code: string | undefined, url?: string): string | undefined {
  switch (code) {
    case "TELEGRAM_IS_BOT":
      return `${handleOf(url)} is a bot, not a channel — bots have no post history to read. If it publishes to a channel, add that channel's link instead.`
    case "TELEGRAM_IS_USER":
      return "That's a personal account, not a channel. Radaric reads channels and public groups."
    case "TELEGRAM_INVALID_INPUT":
      return "That isn't a public Telegram channel. Paste the channel's link — t.me/channelname."
    case "TELEGRAM_PRIVATE_INVITE":
      return "Private invite links can't be read — Radaric reads public channels. Use the channel's public t.me/channelname link."
    case "TELEGRAM_NOT_FOUND":
      return `No Telegram channel called ${handleOf(url)}. Check the spelling, or paste the full link — t.me/channelname.`
    case "NOT_A_FEED": {
      const host = hostOf(url)
      return host
        ? `That isn't an RSS or Atom feed. Paste the direct feed URL — often ${host}/feed or ${host}/rss.xml.`
        : "That isn't an RSS or Atom feed. Paste the direct feed URL — usually the site address followed by /feed or /rss.xml."
    }
    case "FEED_UNREACHABLE_BY_POLICY":
      return "Radaric fetches feeds from its own servers, so it can't reach a private or local address. This feed needs to be reachable from the internet."
    case "DNS_NOT_FOUND": {
      const host = hostOf(url)
      return host
        ? `${host} doesn't exist — check the address for a typo.`
        : "That address doesn't exist — check it for a typo."
    }
    default:
      return undefined
  }
}
