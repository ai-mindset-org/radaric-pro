/**
 * Shared title-length policy for parsed feed materials.
 *
 * Every parser (RSS, Twitter/X, Telegram, YouTube, Parallel) routes the title
 * it derives from source data through `capTitle`, so the "≤ TITLE_MAX_LENGTH
 * characters, otherwise the full title with a trailing ellipsis" rule lives in
 * exactly one place instead of being re-implemented (and drifting) per source.
 *
 * `derivePostTitle` / `isDerivedTitle` / `splitDerivedBody` are the second
 * half of the policy: a title that opens its own content is a derived lede,
 * and the surfaces that print the title must print the body without it.
 */

import { sanitizeInlineHtml, stripHtml } from "@/lib/sanitize"

/** Maximum stored title length before truncation. */
export const TITLE_MAX_LENGTH = 300

/**
 * Cap a title at `max` characters, appending an ellipsis only when it actually
 * overflows. Titles at or under the limit are returned unchanged (full title).
 */
export function capTitle(text: string, max = TITLE_MAX_LENGTH): string {
  return text.length > max ? trimLoneSurrogate(text.slice(0, max)) + "…" : text
}

/**
 * Maximum length of a derived lede headline (see `derivePostTitle`) — much
 * shorter than TITLE_MAX_LENGTH because a lede is meant to read as a
 * headline, not a capped copy of the whole post.
 */
export const HEADLINE_MAX_LENGTH = 120

/** Any http(s) URL that fills an entire whitespace-delimited token. */
const URL_TOKEN_RE = /^https?:\/\/\S+$/

/** A trailing truncation marker left by `truncateHeadline` / `capTitle`. */
const TRUNCATION_SUFFIX_RE = /(…|\.\.\.)$/

/**
 * Synthetic titles that carry no words from the post itself ("Photo from
 * @user", the legacy "Untitled"). They must never be treated as content
 * signal — see `isPlaceholderTitle`.
 */
const PLACEHOLDER_TITLE_RE =
  /^(?:post|photo|video|link|album|media)\s+from\s+@?[\w.]+$|^(?:untitled|media message)$/i

/**
 * True for a fallback title that was synthesised because the post's own text
 * yielded no headline. Such a title describes the post's shape, not its
 * subject, so similarity scoring must ignore it (dozens of unrelated posts
 * from one account otherwise share an identical "title").
 */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE_RE.test(title.trim())
}

/**
 * Words whose trailing period ends an abbreviation, not a sentence. Single
 * letters ("J. Smith"), dotted forms ("U.S.", "e.g.") and this list are all
 * skipped when looking for the first sentence boundary.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd",
  "co", "corp", "no", "fig", "approx", "al", "cf", "vol", "est", "dept", "univ",
])

/** True when the "." at `dotIndex` closes an abbreviation rather than a sentence. */
function isAbbreviationDot(line: string, dotIndex: number): boolean {
  if (line[dotIndex] !== ".") return false
  let start = dotIndex
  while (start > 0 && !/\s/.test(line[start - 1])) start--
  const token = line.slice(start, dotIndex)
  if (!token) return false
  if (token.includes(".")) return true // U.S. · e.g. · a.m.
  const bare = token.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()
  if (bare.length <= 1) return true // initials
  return ABBREVIATIONS.has(bare)
}

/**
 * First sentence of `line`, or the whole line when no usable sentence
 * boundary is found. Abbreviation periods are skipped, and a boundary that
 * would leave too short a head (a lone short exclamation) is passed over in
 * favour of the next one.
 */
function firstSentenceOrLine(line: string): string {
  const boundary = /[.!?…](?=\s|$)/g
  let match: RegExpExecArray | null
  while ((match = boundary.exec(line)) !== null) {
    if (isAbbreviationDot(line, match.index)) continue
    const head = line.slice(0, match.index + 1)
    if (head.length >= 20) return head
  }
  return line
}

/** Drop a leading "RT @handle: " prefix and any bare-URL token, then collapse whitespace. */
function cleanHeadline(head: string): string {
  const withoutRetweetPrefix = head.replace(/^RT @\w+:\s*/, "")
  const withoutUrls = withoutRetweetPrefix
    .split(/\s+/)
    .filter((token) => token && !URL_TOKEN_RE.test(token))
    .join(" ")
  return withoutUrls.replace(/\s+/g, " ").trim()
}

/** Drop a trailing high surrogate left behind by slicing mid-emoji. */
function trimLoneSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/** Cut `s` at a word boundary at/before HEADLINE_MAX_LENGTH and append an ellipsis. */
function truncateHeadline(s: string): string {
  if (s.length <= HEADLINE_MAX_LENGTH) return s
  let cut = s.slice(0, HEADLINE_MAX_LENGTH)
  const lastSpace = cut.lastIndexOf(" ")
  if (lastSpace > 0) cut = cut.slice(0, lastSpace)
  return trimLoneSurrogate(cut.trimEnd()) + "…"
}

/**
 * Derive a short lede headline from a post's text — the first sentence of the
 * first line that yields one, cleaned of retweet prefixes and bare links,
 * capped at HEADLINE_MAX_LENGTH. Link-first posts (a bare URL on line one,
 * the text below it) therefore still get a real headline. Returns null when
 * no line leaves anything usable.
 */
export function derivePostTitle(text: string): string | null {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const cleaned = cleanHeadline(firstSentenceOrLine(line))
    if (cleaned) return truncateHeadline(cleaned)
  }
  return null
}

/**
 * True if the content token at `index` is an artifact `cleanHeadline` strips
 * out, so it can be skipped while matching a cleaned title against raw
 * content. The RT prefix is only stripped at the very start, so "RT" and the
 * handle after it are skippable only in positions 0 and 1 — otherwise "The RT
 * team shipped" would match a title that never contained "RT".
 */
function isSkippableToken(token: string, index: number): boolean {
  if (URL_TOKEN_RE.test(token)) return true
  if (index === 0) return token === "RT"
  if (index === 1) return /^@\w+:$/.test(token)
  return false
}

/**
 * One whitespace-delimited word of a content stream, with its position in
 * the source it came from (plain text or raw HTML).
 */
interface TitleToken {
  text: string
  start: number
  end: number
}

/** Words of `content`, in order, with their offsets — the plain-text stream. */
function* plainTokens(content: string): Generator<TitleToken> {
  const n = content.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(content[i])) i++
    if (i >= n) return
    const start = i
    while (i < n && !/\s/.test(content[i])) i++
    yield { text: content.slice(start, i), start, end: i }
  }
}

/**
 * A whitespace entity — `stripHtml` decodes these to a space, so the markup
 * stream must treat them as separators too or the two surfaces disagree on a
 * title they contain ("Good&nbsp;title." must tokenize like "Good title.").
 * Numeric forms are judged by the character they decode to, since JS `\s`
 * covers the whole Unicode space set (`&ensp;`, `&emsp;`, `&#8194;`…).
 */
const WHITESPACE_ENTITY_RE = /^&(?:nbsp|ensp|emsp|thinsp|hairsp|#(\d+)|#x([0-9a-f]+));/i

function isWhitespaceEntity(entity: string): boolean {
  const match = WHITESPACE_ENTITY_RE.exec(entity)
  if (!match) return false
  const [, dec, hex] = match
  if (dec === undefined && hex === undefined) return true // named form
  const codePoint = parseInt(hex ?? dec, hex !== undefined ? 16 : 10)
  return codePoint <= 0x10ffff && /\s/.test(String.fromCodePoint(codePoint))
}

/** Length of the whitespace entity at `index` in `html`, or 0 if none starts there. */
function whitespaceEntityLengthAt(html: string, index: number): number {
  // Longest whitespace entity is 8 chars (`&thinsp;`), so a window suffices.
  const match = html.slice(index, index + 8).match(WHITESPACE_ENTITY_RE)
  return match && isWhitespaceEntity(match[0]) ? match[0].length : 0
}

/**
 * Words of `html`, in order, with their offsets — the markup stream. Tags and
 * whitespace produce no token, so a title word wrapped in an inline tag
 * (`<strong>Rust</strong>-based`'s "Rust") or separated by a line break still
 * matches the way it would in the stripped text — but a word the tag *splits*
 * ("Rust" + "-based" vs the stripped run "Rust-based") is two tokens here and
 * never matches, so the caller keeps the plain title and the untouched body. A
 * whitespace entity (`Good&nbsp;title.`) separates words just as `stripHtml`
 * decodes it to a space. Other entities are left encoded: `AT&amp;T` doesn't
 * equal `AT&T`, so the match fails and the caller keeps the body.
 */
function* htmlTokens(html: string): Generator<TitleToken> {
  const n = html.length
  let i = 0
  while (i < n) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i + 1)
      if (close === -1) return
      i = close + 1
      continue
    }
    const entityLength = whitespaceEntityLengthAt(html, i)
    if (entityLength) {
      i += entityLength
      continue
    }
    if (/\s/.test(html[i])) {
      i++
      continue
    }
    const start = i
    while (i < n && !/[\s<]/.test(html[i]) && !whitespaceEntityLengthAt(html, i)) i++
    yield { text: html.slice(start, i), start, end: i }
  }
}

/**
 * One title word matched to the content token it came from.
 */
interface TitleWordMatch {
  /** Offsets of the matched token — clipped for a truncated last word. */
  contentStart: number
  contentEnd: number
  /** Index into the title's own words. */
  wordIndex: number
}

/** The words of `title` and its own truncation suffix ("" when the title is whole). */
function titleWordsOf(title: string): { words: string[]; suffix: string } {
  const trimmed = title.trim()
  const suffix = trimmed.match(TRUNCATION_SUFFIX_RE)?.[0] ?? ""
  const words = trimmed.replace(TRUNCATION_SUFFIX_RE, "").trim().split(/\s+/).filter(Boolean)
  return { words, suffix }
}

/**
 * Offsets of `title`'s words in the stored string itself (not a normalised
 * copy): a hand-written title may carry runs of whitespace, and an entity has
 * to land on the characters the reader sees.
 */
function titleWordOffsets(title: string): Array<{ start: number; end: number }> {
  const core = title.trim().replace(TRUNCATION_SUFFIX_RE, "").trim()
  const lead = title.length - title.trimStart().length
  return Array.from(core.matchAll(/\S+/g), (match) => ({
    start: lead + (match.index ?? 0),
    end: lead + (match.index ?? 0) + match[0].length,
  }))
}

/**
 * Walk `tokens` looking for `title` (minus a trailing "…" or "...") as the
 * opening words, skipping over tokens that `derivePostTitle`'s cleaning step
 * would have removed (RT-prefix tokens, bare URLs). Returns one match per title
 * word — in order, with the content offsets it came from — or null. Shared by
 * the plain-text and markup variants so the two surfaces can't drift on what
 * counts as a derived headline.
 */
function matchTitleTokens(title: string, tokens: Iterable<TitleToken>): TitleWordMatch[] | null {
  const { words, suffix } = titleWordsOf(title)
  const truncated = suffix !== ""
  if (words.length === 0) return null

  const matches: TitleWordMatch[] = []
  let tokenIndex = 0

  for (const token of tokens) {
    if (isSkippableToken(token.text, tokenIndex)) {
      tokenIndex++
      continue
    }
    tokenIndex++

    const word = words[matches.length]
    if (token.text === word) {
      matches.push({ contentStart: token.start, contentEnd: token.end, wordIndex: matches.length })
    } else if (
      truncated &&
      matches.length === words.length - 1 &&
      token.text.length > word.length &&
      token.text.startsWith(word)
    ) {
      // Last title word was cut mid-token by truncation — accept a prefix match.
      matches.push({
        contentStart: token.start,
        contentEnd: token.start + word.length,
        wordIndex: matches.length,
      })
    } else {
      return null
    }
    if (matches.length === words.length) return matches
  }
  return null
}

/** Source index just past a derived title's last word, or -1 when it isn't one. */
function matchTitleIn(title: string, tokens: Iterable<TitleToken>): number {
  const matches = matchTitleTokens(title, tokens)
  return matches ? matches[matches.length - 1].contentEnd : -1
}

/**
 * True when `content` opens with `title` — i.e. `title` is (or came from)
 * a derived headline rather than an independent, hand-written one.
 */
export function isDerivedTitle(title: string, content: string): boolean {
  if (!title.trim()) return false
  return matchTitleIn(title, plainTokens(content)) !== -1
}

/**
 * The part of `content` that follows a derived `title`, with leading
 * whitespace (and any punctuation the headline cut left dangling) trimmed.
 * Returns `content` unchanged when `title` isn't a derived headline of it.
 */
export function splitDerivedBody(title: string, content: string): string {
  const end = matchTitleIn(title, plainTokens(content))
  if (end === -1) return content
  return content.slice(end).replace(/^[\s…]+/, "")
}

/** The HTML void elements — they never carry children, so they must not enter the open-tag stack. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
])

/**
 * The opening tags still unclosed at raw index `index`, outermost first, or
 * null when the markup before it can't be trusted (a closer with no match, or
 * a tag spanning the index). The caller bails on null rather than re-opening
 * a stack it can't vouch for around a cut.
 */
function openTagsBefore(html: string, index: number): Array<{ raw: string; name: string }> | null {
  const stack: Array<{ raw: string; name: string }> = []
  const tagRe = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi
  let lastEnd = 0
  let match: RegExpExecArray | null

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index >= index) break
    lastEnd = match.index + match[0].length
    const name = match[1].toLowerCase()
    if (match[0][1] === "/") {
      if (stack[stack.length - 1]?.name !== name) return null
      stack.pop()
    } else if (!VOID_TAGS.has(name) && !/\/>$/.test(match[0])) {
      stack.push({ raw: match[0], name })
    }
  }
  if (lastEnd > index) return null // the cut lands inside a tag
  return stack
}

/**
 * HTML counterpart of `splitDerivedBody` for bodies that are markup rather
 * than plain text (`isDerivedTitle` matches on stripped text, so the cut
 * can't be taken from it directly). The title's own words are matched against
 * the markup's text — tags are invisible, as they are to the reader — and
 * only a match that opens the document is cut. Elements the title leaves open
 * (the lede and the rest often share one paragraph) stay open around the
 * remainder, so the body keeps its structure: `<p>Lede. Rest</p>` becomes
 * `<p>Rest</p>`, not a bare sentence and a stray closer. Anything that can't
 * be mapped cleanly — entities, unbalanced markup — returns the body
 * untouched rather than risking a cut in the wrong place.
 */
export function splitDerivedBodyHtml(
  title: string,
  html: string,
  /** `stripHtml(html)` when the caller already has it; computed here otherwise. */
  plain = stripHtml(html)
): string {
  if (!isDerivedTitle(title, plain)) return html

  const end = matchTitleIn(title, htmlTokens(html))
  if (end === -1) return html

  const stack = openTagsBefore(html, end)
  if (!stack) return html

  let rest = html.slice(end)
  // Drop the whitespace, any dangling ellipsis the truncated headline cut
  // left (same trim as `splitDerivedBody`), and the closing tags that only
  // close elements the title was inside (popping each off the stack), then
  // re-open whatever is still open around the remainder.
  for (;;) {
    const closer = rest.match(/^\s*<\/([a-z][a-z0-9]*)\s*>/i)
    if (closer) {
      const top = stack[stack.length - 1]
      if (!top || top.name !== closer[1].toLowerCase()) break
      stack.pop()
      rest = rest.slice(closer[0].length)
      continue
    }
    const whitespace = rest.match(/^[\s…]+/)
    if (whitespace) {
      rest = rest.slice(whitespace[0].length)
      continue
    }
    break
  }
  return stack.map((tag) => tag.raw).join("") + rest
}

/** A title word with both its content offsets and its offsets in the title. */
interface TitleWordSpan extends TitleWordMatch {
  titleStart: number
  titleEnd: number
}

/**
 * Move spans' offsets from `content` space onto the derived title's own text.
 * A Telegram entity that sits on the lede the title was cut from (a link inside
 * the first sentence) renders on the headline instead of vanishing together
 * with the sentence the body drops. Spans that only cover text the headline
 * doesn't contain — the body, a stripped RT prefix, a bare URL — are dropped,
 * and a span running past a truncated title's cut is clipped to it.
 */
export function remapToDerivedTitle<T extends { offset: number; length: number }>(
  title: string,
  content: string,
  spans: T[]
): T[] {
  const matches = matchTitleTokens(title, plainTokens(content))
  if (!matches || spans.length === 0) return []

  const offsets = titleWordOffsets(title)
  const wordSpans: TitleWordSpan[] = matches.map((match) => ({
    ...match,
    titleStart: offsets[match.wordIndex].start,
    titleEnd: offsets[match.wordIndex].end,
  }))

  return spans.flatMap((span) => {
    const start = span.offset
    const end = span.offset + span.length
    let first: TitleWordSpan | null = null
    let last: TitleWordSpan | null = null
    for (const word of wordSpans) {
      if (word.contentEnd <= start || word.contentStart >= end) continue
      if (!first) first = word
      last = word
    }
    if (!first || !last) return []

    const mappedStart = first.titleStart + (Math.max(start, first.contentStart) - first.contentStart)
    const mappedEnd = last.titleEnd - (last.contentEnd - Math.min(end, last.contentEnd))
    return mappedEnd > mappedStart
      ? [{ ...span, offset: mappedStart, length: mappedEnd - mappedStart }]
      : []
  })
}

/**
 * The inline HTML of a derived headline, cut out of `html` and sanitized to
 * its links (`sanitizeInlineHtml` unwraps emphasis — a headline keeps a link
 * and nothing else, RAD-365), or null when the markup doesn't read as `title`
 * — a hand-written title, an RT prefix or bare URL the headline cleaning
 * dropped, encoded entities, or a document where the title's words are split
 * by tags. The cut starts at the document head so an inline tag opening before
 * the first word still wraps it, and ends just past the last matched word
 * (mid-token when the title was truncated, with the ellipsis restored).
 */
export function derivedTitleHtml(title: string, html: string): string | null {
  const matches = matchTitleTokens(title, htmlTokens(html))
  if (!matches) return null

  const { words, suffix } = titleWordsOf(title)
  const slice = html.slice(0, matches[matches.length - 1].contentEnd)
  // The rich headline is shown in place of the stored title, so the two must
  // read the same: a cut that kept text the headline dropped is not usable.
  if (stripHtml(slice) !== words.join(" ")) return null

  // The title's own suffix, not a normalised "…" — a title that ended in "..."
  // must still render as the stored string. Whitespace is normalised because
  // sanitize-html decodes entities at ingest (an `&nbsp;` is a literal U+00A0
  // in stored content) while the title the reader sees has a plain space.
  const headline = sanitizeInlineHtml(
    (slice + suffix).replace(/&nbsp;|[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
  )
  return headline.trim()
}
