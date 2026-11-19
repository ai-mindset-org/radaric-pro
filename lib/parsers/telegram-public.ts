// ---------------------------------------------------------------------------
// Telegram without an account: the public web preview https://t.me/s/<channel>.
//
// Used by parseTelegramChannel when the worker has no live GramJS session, so a
// public channel added as a Telegram source still produces posts. Same logic as
// scripts/tg-rss-bridge.py: post text (with line breaks and links), date, link,
// photos. Items link to the embed view (?embed=1), which carries the full post
// text for any reader that opens the page.
//
// Limits: public channels with the web preview enabled; about 20 latest posts.
// ---------------------------------------------------------------------------

import { DOMParser } from "linkedom"
import { capTitle, derivePostTitle } from "@/lib/title"
import type { ParsedTelegramItem } from "./telegram"

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RadaricPublicTelegram/1.0"
const BG_URL_RE = /background-image:url\('([^']+)'\)/
const USERNAME_RE = /^[A-Za-z0-9_]{3,64}$/

function textWithBreaks(el: Element): string {
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"))
  return (clone.textContent || "").trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export async function parseTelegramPublic(
  channelUsername: string,
  limit = 20
): Promise<ParsedTelegramItem[]> {
  const channel = channelUsername.trim()
  if (!USERNAME_RE.test(channel)) {
    throw new Error(`Not a public Telegram channel username: ${channelUsername}`)
  }
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  })
  // t.me answers a channel without a public preview with a redirect to t.me/<name>
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Channel @${channel} has no public web preview (t.me/s); connect a Telegram account in Settings`)
  }
  if (!res.ok) throw new Error(`t.me/s/${channel} answered ${res.status}`)
  const html = await res.text()

  // linkedom is DOM-compatible but untyped as Document; same cast as lib/parsers/rss.ts
  const document = new DOMParser().parseFromString(html, "text/html") as unknown as Document
  const nodes = Array.from(document.querySelectorAll("div.tgme_widget_message[data-post]"))
  const items: ParsedTelegramItem[] = []

  for (const node of nodes) {
    const dataPost = node.getAttribute("data-post") || ""
    const messageId = Number(dataPost.split("/").pop())
    if (!Number.isInteger(messageId)) continue

    const textEl = node.querySelector(".tgme_widget_message_text.js-message_text")
    const text = textEl ? textWithBreaks(textEl) : ""

    const mediaUrls: string[] = []
    node
      .querySelectorAll(".tgme_widget_message_photo_wrap, .tgme_widget_message_video_thumb, .link_preview_image")
      .forEach((el) => {
        const m = BG_URL_RE.exec(el.getAttribute("style") || "")
        if (m && !mediaUrls.includes(m[1])) mediaUrls.push(m[1])
      })
    if (!text && mediaUrls.length === 0) continue // service messages, polls, stickers

    const datetime = node.querySelector(".tgme_widget_message_date time")?.getAttribute("datetime")
    const permalink = `https://t.me/${channel}/${messageId}`

    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
      .join("")
    const content = paragraphs + mediaUrls.slice(0, 4).map((u) => `<p><img src="${escapeHtml(u)}" /></p>`).join("")

    items.push({
      title: derivePostTitle(text) || capTitle(text.replace(/\s+/g, " ")) || `@${channel} · ${messageId}`,
      url: `${permalink}?embed=1`,
      externalId: permalink,
      content,
      publishedAt: datetime ? new Date(datetime) : null,
      excerpt: text.slice(0, 200),
      thumbnailUrl: mediaUrls[0],
      mediaUrls,
      messageId,
      channelUsername: channel,
    })
  }

  // The page lists oldest first; callers expect newest first.
  return items.reverse().slice(0, limit)
}
