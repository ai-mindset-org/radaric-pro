/**
 * Source error formatting utilities.
 *
 * Used by parse routes to create informative, persistent error messages
 * that help the user understand what went wrong without server logs.
 */

/**
 * Format a source parsing error into a human-readable message.
 *
 * @param type - Source type (RSS, TELEGRAM, TWITTER, INTEREST)
 * @param name - Source name as configured by the user
 * @param error - The caught error (may be Error, string, number, or anything)
 * @returns Formatted string like "[RSS] TechCrunch Feed: connection timeout"
 */
export function formatSourceError(
  type: string,
  name: string,
  error: unknown
): string {
  const reason =
    error instanceof Error ? error.message : String(error)
  return `[${type}] ${name}: ${reason}`
}

/**
 * Truncate an error message to a maximum length.
 * Appends "..." if the message was truncated.
 *
 * @param message - The error message to truncate
 * @param limit - Maximum character count (default 500)
 * @returns The original message if within limit, or truncated + "..."
 */
export function truncateErrorMessage(
  message: string,
  limit: number = 500
): string {
  if (message.length <= limit) return message
  return message.slice(0, limit) + "..."
}
