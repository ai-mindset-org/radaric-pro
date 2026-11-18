import { sanitizeHtml, SANITIZE_CONFIG } from "./sanitize"

const MAX_CONTENT_LENGTH = 100000 // 100KB limit

/**
 * Check if text contains HTML markup
 * Uses improved heuristic to reduce false positives
 * Checks for specific tags instead of any <...> pattern
 */
export function isHtml(text: string): boolean {
  if (!text || text.length < 7) return false // Minimum: "<p>x</p>"
  // Include b, i tags and handle self-closing br/ pattern
  return /<(p|div|h[1-6]|ul|ol|li|br|a|strong|em|b|i|pre|code|blockquote)[\s>/]/i.test(
    text
  )
}

/**
 * Truncate content to prevent performance issues with very long HTML
 * Uses sanitize-html to auto-close unclosed tags after truncation
 */
export function truncateContent(content: string): string {
  if (content.length > MAX_CONTENT_LENGTH) {
    const truncated = content.slice(0, MAX_CONTENT_LENGTH)
    // sanitize-html will auto-close any unclosed tags
    return sanitizeHtml(truncated) + "..."
  }
  return content
}
