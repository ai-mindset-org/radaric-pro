"use client"

import type { ReactNode } from "react"
import {
  convertTelegramEntitiesToReact,
  type TelegramEntity,
} from "@/lib/telegram-entities-to-react"
import { derivedTitleHtml, remapToDerivedTitle } from "@/lib/title"

interface MaterialTitleProps {
  title: string
  content: string
  contentEntities?: TelegramEntity[] | null
}

/**
 * A link in a headline keeps the heading's weight (the renderer's link
 * `font-medium` is overridden) so the headline still reads as one run of type,
 * while the app-wide `link` treatment supplies its colour and rule (RAD-366).
 * The HTML path matters too: `derivedTitleHtml` output carries no classes and
 * preflight leaves anchors not-a-link (no colour, no underline), so this is
 * what makes both headline paths — entities and markup — style alike. Only an
 * anchor with an href is styled: a sanitized href-less <a> is dead text and
 * opens the card, so it must not look clickable (RAD-367).
 */
const RICH_TITLE_CLASS = "[&_a[href]]:[font-weight:inherit] [&_a[href]]:link"

/**
 * Entity classes that may style a headline: only the ones that render a link.
 * A headline exists to keep a link the body cut — not the sentence's
 * emphasis — so bold, italic, underline, strike and code are dropped and
 * their words render plain (RAD-365). Spoiler is excluded for the old reason:
 * in the compact variant it renders as a non-interactive `text-transparent`
 * mask, which would hide the words permanently. Pre and Blockquote are block
 * shapes, and a headline reads as one run of prose. Mentions and contact
 * entities qualify — they are links too.
 */
const HEADLINE_ENTITY_CLASSES = new Set([
  "MessageEntityTextUrl",
  "MessageEntityUrl",
  "MessageEntityMention",
  "MessageEntityEmail",
  "MessageEntityPhone",
])

/**
 * The post's headline, rendered with the link its own sentence carried.
 *
 * A derived title is a plain-text copy of the post's opening sentence, and the
 * body cuts that sentence out (splitDerivedBody) — so a link embedded in the
 * lede used to disappear from every surface. The stored title stays the
 * displayed text (same words, same trailing ellipsis); only the sentence's
 * link entities or markup are re-applied to it — emphasis is not part of a
 * headline (RAD-365). A link stays clickable even inside a clickable card:
 * the Telegram renderer and the HTML wrapper both stop the click from
 * reaching the card's own handler. RAD-337.
 */
export function MaterialTitle({
  title,
  content,
  contentEntities,
}: MaterialTitleProps): ReactNode {
  if (contentEntities && contentEntities.length > 0) {
    const remapped = remapToDerivedTitle(
      title,
      content,
      contentEntities.filter((entity) => HEADLINE_ENTITY_CLASSES.has(entity.className ?? ""))
    )
    if (remapped.length === 0) return title
    return (
      <span className={RICH_TITLE_CLASS}>
        {convertTelegramEntitiesToReact(title, remapped, "compact")}
      </span>
    )
  }

  const html = derivedTitleHtml(title, content)
  if (!html) return title
  return (
    <span
      className={RICH_TITLE_CLASS}
      onClick={(event) => {
        // Only an anchor that can navigate owns the click: sanitizing can leave
        // an <a> without an href (a footnote name anchor, a stripped scheme),
        // and that dead text must still open the card (RAD-367).
        if ((event.target as HTMLElement).closest("a[href]")) event.stopPropagation()
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
