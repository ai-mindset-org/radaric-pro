import sanitizeHtml from "sanitize-html"

export const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "a",
    "strong",
    "em",
    "b",
    "i",
    "code",
    "pre",
    "blockquote",
    "br",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"], // Blocks javascript:, data:, etc.
}

/**
 * Sanitize HTML content for safe rendering
 * Uses whitelist of allowed tags and blocks dangerous URI schemes
 */
export function sanitizeHtmlContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_CONFIG)
}

// Alias for backward compatibility
export { sanitizeHtmlContent as sanitizeHtml }

/**
 * Inline allowlist for text that renders inside a heading. A headline keeps
 * only links: a derived headline exists so a link carried by the lede's
 * sentence survives the body cut (RAD-337), while emphasis would print that
 * sentence's formatting on the title (RAD-365) — so `strong`/`em`/`b`/`i`/
 * `code`/`br`, and any other tag, are unwrapped with their text kept. Block
 * tags must not survive either: a `<p>` parsed inside an `<h1>` is invalid
 * HTML and the parser hoists it out of the heading entirely.
 */
const INLINE_SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: ["a"],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
}

/**
 * Sanitize an inline fragment for a heading. Unclosed tags are balanced by the
 * parser, so a slice of a larger document (`<a href="…">lede` cut at the end of
 * the sentence) comes back as valid markup.
 */
export function sanitizeInlineHtml(html: string): string {
  return sanitizeHtml(html, INLINE_SANITIZE_CONFIG)
}

/**
 * Extract plain text from HTML (for excerpts and AI)
 */
export function stripHtml(html: string): string {
  const clean = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
  return clean.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}
