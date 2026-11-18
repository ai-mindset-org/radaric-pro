/**
 * Telegram message entities → React.
 *
 * Entities arrive as GramJS MessageEntity records (stored on
 * Material.contentEntities). Offsets are UTF-16 code units — the same space as
 * JS string indices — so `slice(offset, offset + length)` is correct here as
 * long as nothing counts code points. Unknown entity classes render as plain
 * text; nothing is ever interpreted as HTML.
 *
 * Two variants: "full" (reading surfaces) renders block elements and
 * interactive leaves; "compact" (card excerpts, story snippets) renders inline
 * only — no blockquote/pre inside a line-clamped clickable card, no controls.
 *
 * Nesting rules that keep the output valid HTML:
 *  - a block inside an inline context (e.g. a code block inside a bold run)
 *    downgrades to its inline form rather than nesting <pre> in <strong>;
 *  - a link inside an interactive mask (a spoiler) renders as plain text, so
 *    nothing focusable lives inside an aria-hidden or button subtree.
 */

import React from "react"
import {
  TelegramCollapsedQuote,
  TelegramSpoiler,
} from "@/lib/telegram-rich-text-leaves"

// Only allow safe URL protocols to prevent XSS via javascript: URLs. `tg:` is
// deliberately absent: its client support is inconsistent and allowing it buys
// nothing — a tg:// link renders as its text.
const SAFE_PROTOCOLS = /^(?:https?|mailto|tel):/i

export interface TelegramEntity {
  className?: string
  offset: number
  length: number
  url?: string
  /** MessageEntityBlockquote — Telegram's expandable quote. */
  collapsed?: boolean
}

export type RichTextVariant = "full" | "compact"

/** Outer-first order when several inline entities share the same span. */
const INLINE_RANK: Record<string, number> = {
  MessageEntityBold: 1,
  MessageEntityItalic: 1,
  MessageEntityUnderline: 1,
  MessageEntityStrike: 1,
  MessageEntitySpoiler: 1,
  MessageEntityCode: 2,
  MessageEntityTextUrl: 3,
  MessageEntityUrl: 3,
  MessageEntityMention: 3,
  MessageEntityEmail: 3,
  MessageEntityPhone: 3,
}

const BLOCK_CLASSES = new Set(["MessageEntityBlockquote", "MessageEntityPre"])

function rankOf(entity: TelegramEntity): number {
  const className = entity.className ?? ""
  if (className in INLINE_RANK) return INLINE_RANK[className]
  if (BLOCK_CLASSES.has(className)) return 0
  return 99
}

function isInlineEntity(entity: TelegramEntity): boolean {
  return (entity.className ?? "") in INLINE_RANK
}

/**
 * Adjust entity offsets for truncated text (excerpts)
 * Filters out entities that are outside the excerpt range
 * and adjusts the length of entities that are partially cut off
 */
export function adjustEntitiesForExcerpt(
  entities: TelegramEntity[],
  maxLength: number
): TelegramEntity[] {
  if (!entities || entities.length === 0) return []

  return entities
    .filter((e) => {
      // Only include entities that start within the excerpt
      return e.offset < maxLength
    })
    .map((e) => {
      // Adjust length if entity extends beyond excerpt
      const adjustedLength =
        e.offset + e.length > maxLength ? maxLength - e.offset : e.length

      return {
        ...e,
        length: adjustedLength,
      }
    })
}

/**
 * Shift entity offsets after removing `shift` characters from the FRONT of
 * the content (e.g. a derived-title de-dup cut) — entities that end at or
 * before the cut are dropped, the rest are re-based onto the remainder.
 */
export function shiftContentEntities<T extends { offset: number; length: number }>(
  entities: T[],
  shift: number
): T[] {
  if (shift <= 0) return entities
  return entities
    .filter((e) => e.offset + e.length > shift)
    .map((e) => {
      const newOffset = Math.max(0, e.offset - shift)
      const newEnd = e.offset + e.length - shift
      return { ...e, offset: newOffset, length: newEnd - newOffset }
    })
}

// ---------------------------------------------------------------------------
// Internal rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  variant: RichTextVariant
  /** True inside a spoiler (or another interactive leaf): nested links downgrade. */
  insideInteractive: boolean
  /** True inside an inline wrapper: nested blocks downgrade to inline forms. */
  inlineContext: boolean
}

function clampEntities(
  textLength: number,
  entities: TelegramEntity[] | null | undefined
): TelegramEntity[] {
  if (!entities) return []
  const clamped: TelegramEntity[] = []
  for (const entity of entities) {
    if (!entity || typeof entity.className !== "string") continue
    if (!Number.isFinite(entity.offset) || !Number.isFinite(entity.length)) continue
    const start = Math.max(0, Math.min(entity.offset, textLength))
    const end = Math.max(start, Math.min(entity.offset + entity.length, textLength))
    if (end <= start) continue
    clamped.push({ ...entity, offset: start, length: end - start })
  }
  return clamped
}

function safeHref(url?: string): string | null {
  if (!url) return null
  const trimmed = url.trim()
  return SAFE_PROTOCOLS.test(trimmed) ? trimmed : null
}

function linkNode(
  href: string,
  children: React.ReactNode,
  key: string,
  variant: RichTextVariant
): React.ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Full links join the app-wide `link` treatment (RAD-366). Compact
      // consumers are muted card chrome (card excerpts, story snippets, a
      // headline), where a rule under every URL would read as noise — they
      // keep the quiet hover underline. The enclosing prose container also
      // routes every anchor through `[&_a]:link`, so a full link inside one
      // arrives at the same declarations twice; identical values, no fight.
      className={
        variant === "full"
          ? "link font-medium"
          : "font-medium text-primary-emphasis hover:underline"
      }
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  )
}

function isQuoteElement(node: React.ReactNode): node is React.ReactElement<{
  children?: React.ReactNode
}> {
  return (
    React.isValidElement(node) &&
    (node.type === "blockquote" || node.type === TelegramCollapsedQuote)
  )
}

/**
 * Telegram emits one blockquote entity per paragraph. Two adjacent quote runs
 * separated only by whitespace are one visual quote, so their elements merge —
 * otherwise a multi-paragraph quote renders as a stack of separate blocks (and,
 * when collapsed, a stack of Show more toggles). The whitespace separator stays
 * inside the merged quote so the paragraph break survives.
 */
function mergeAdjacentQuotes(nodes: React.ReactNode[]): React.ReactNode[] {
  const result: React.ReactNode[] = []
  for (const node of nodes) {
    const last = result[result.length - 1]
    const beforeLast = result[result.length - 2]
    if (
      isQuoteElement(node) &&
      isQuoteElement(beforeLast) &&
      typeof last === "string" &&
      last.trim() === ""
    ) {
      const children = [
        ...React.Children.toArray(beforeLast.props.children),
        last,
        ...React.Children.toArray(node.props.children),
      ]
      result.splice(result.length - 2, 2, React.cloneElement(beforeLast, {}, children))
      continue
    }
    result.push(node)
  }
  return result
}

function wrapEntity(
  entity: TelegramEntity,
  children: React.ReactNode,
  text: string,
  context: RenderContext,
  key: string
): React.ReactNode {
  const raw = text.slice(entity.offset, entity.offset + entity.length)
  // A block inside an inline wrapper (bold, link, spoiler, another block's
  // inline span) must not nest flow content in phrasing content.
  const inline = context.variant === "compact" || context.inlineContext

  switch (entity.className) {
    case "MessageEntityBold":
      return <strong key={key}>{children}</strong>
    case "MessageEntityItalic":
      return <em key={key}>{children}</em>
    case "MessageEntityUnderline":
      return <u key={key}>{children}</u>
    case "MessageEntityStrike":
      return <s key={key}>{children}</s>
    case "MessageEntitySpoiler":
      if (context.insideInteractive) {
        return <React.Fragment key={key}>{children}</React.Fragment>
      }
      return inline ? (
        <span
          key={key}
          aria-hidden="true"
          className="select-none rounded-xs bg-muted text-transparent"
        >
          {children}
        </span>
      ) : (
        <TelegramSpoiler key={key}>{children}</TelegramSpoiler>
      )
    case "MessageEntityCode":
      return (
        <code
          key={key}
          className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.9em] [box-decoration-break:clone]"
        >
          {children}
        </code>
      )
    case "MessageEntityPre":
      return inline ? (
        <span
          key={key}
          className="whitespace-pre-wrap rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.9em]"
        >
          {children}
        </span>
      ) : (
        <pre
          key={key}
          className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[0.85em] leading-relaxed whitespace-pre"
        >
          <code>{children}</code>
        </pre>
      )
    case "MessageEntityBlockquote":
      if (inline) {
        return (
          <span key={key} className="italic">
            {children}
          </span>
        )
      }
      return entity.collapsed ? (
        <TelegramCollapsedQuote key={key}>{children}</TelegramCollapsedQuote>
      ) : (
        <blockquote
          key={key}
          className="my-3 rounded-md bg-muted px-3.5 py-2.5 text-[0.95em] leading-relaxed"
        >
          {children}
        </blockquote>
      )
    case "MessageEntityTextUrl": {
      if (context.insideInteractive) {
        return <React.Fragment key={key}>{children}</React.Fragment>
      }
      const href = safeHref(entity.url)
      return href ? linkNode(href, children, key, context.variant) : <React.Fragment key={key}>{children}</React.Fragment>
    }
    case "MessageEntityUrl": {
      if (context.insideInteractive) {
        return <React.Fragment key={key}>{children}</React.Fragment>
      }
      const href = safeHref(raw)
      return href ? linkNode(href, children, key, context.variant) : <React.Fragment key={key}>{children}</React.Fragment>
    }
    case "MessageEntityMention": {
      if (context.insideInteractive) {
        return <React.Fragment key={key}>{children}</React.Fragment>
      }
      const mention = raw.replace(/^@/, "")
      return mention
        ? linkNode(`https://t.me/${encodeURIComponent(mention)}`, children, key, context.variant)
        : children
    }
    case "MessageEntityEmail":
      return context.insideInteractive
        ? <React.Fragment key={key}>{children}</React.Fragment>
        : raw
          ? linkNode(`mailto:${raw}`, children, key, context.variant)
          : children
    case "MessageEntityPhone": {
      if (context.insideInteractive) {
        return <React.Fragment key={key}>{children}</React.Fragment>
      }
      const digits = raw.replace(/[^\d+]/g, "")
      return digits ? linkNode(`tel:${digits}`, children, key, context.variant) : children
    }
    default:
      return <React.Fragment key={key}>{children}</React.Fragment>
  }
}

/**
 * Render [start, end) with the entities that fit inside it. The entity chosen
 * at each step is the one with the furthest end (outermost), ties broken by
 * rank — so a blockquote contains its pre, and bold contains its link.
 *
 * An entity that begins before `position` but extends past it (partial
 * overlap, e.g. bold [0,5) + italic [3,8)) is re-based onto the remainder
 * rather than dropped, so its tail still renders.
 */
function renderRange(
  text: string,
  start: number,
  end: number,
  entities: TelegramEntity[],
  context: RenderContext,
  path: string
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const inside = entities.filter((e) => e.offset >= start && e.offset + e.length <= end)
  let position = start

  while (position < end) {
    const active = inside.map((e) =>
      e.offset < position && e.offset + e.length > position
        ? { ...e, offset: position, length: e.offset + e.length - position }
        : e
    )
    const starting = active.filter((e) => e.offset === position)
    if (starting.length === 0) {
      const nextStart = active.reduce(
        (min, e) => (e.offset > position && e.offset < min ? e.offset : min),
        end
      )
      nodes.push(text.slice(position, nextStart))
      position = nextStart
      continue
    }

    const outer = [...starting].sort(
      (a, b) => b.offset + b.length - (a.offset + a.length) || rankOf(a) - rankOf(b)
    )[0]
    const outerEnd = outer.offset + outer.length
    const children = renderRange(
      text,
      position,
      outerEnd,
      inside.filter((e) => e !== outer),
      {
        ...context,
        insideInteractive:
          context.insideInteractive || outer.className === "MessageEntitySpoiler",
        inlineContext: context.inlineContext || isInlineEntity(outer),
      },
      `${path}-${outer.offset}`
    )
    nodes.push(
      wrapEntity(outer, children, text, context, `${path}-${outer.offset}-${outer.className}`)
    )
    position = outerEnd
  }

  return mergeAdjacentQuotes(nodes)
}

/**
 * Convert Telegram entities to React elements.
 *
 * The full variant returns a `not-prose` wrapper: the Tailwind Typography
 * plugin adds backticks around `code` and italics to `blockquote`, and the
 * entity markup carries its own styling. The compact variant returns a
 * fragment — its output is inline-only and never sits inside a prose container
 * (card excerpts, story snippets are clamped, so no block child there either).
 * Offsets are assumed UTF-16 (see the module header).
 */
export function convertTelegramEntitiesToReact(
  text: string,
  entities: TelegramEntity[] | null | undefined,
  variant: RichTextVariant = "full"
): React.ReactNode {
  if (!text) return null

  const context: RenderContext = {
    variant,
    insideInteractive: false,
    inlineContext: false,
  }
  const clamped = clampEntities(text.length, entities)
  if (variant === "compact") {
    return clamped.length === 0
      ? text
      : <>{renderRange(text, 0, text.length, clamped, context, "tg")}</>
  }

  if (clamped.length === 0) {
    return <div className="not-prose">{text}</div>
  }

  const nodes = renderRange(text, 0, text.length, clamped, context, "tg")
  return (
    <div className="not-prose [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{nodes}</div>
  )
}
