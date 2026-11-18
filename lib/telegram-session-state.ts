/**
 * Telegram session state shared by the worker proxy and the settings UI.
 *
 * Dependency-free on purpose: the badge renders in the browser, the parser
 * derives the same union on the server. `unknown` is first-class — the worker
 * being unreachable must never be reported as "authorized" (RAD-328).
 */
export type TelegramSessionState = "active" | "invalid" | "starting" | "unconfigured" | "unknown"

export const TELEGRAM_SESSION_STATES: readonly TelegramSessionState[] = [
  "active",
  "invalid",
  "starting",
  "unconfigured",
  "unknown",
]

export function isTelegramSessionState(value: unknown): value is TelegramSessionState {
  return typeof value === "string" && (TELEGRAM_SESSION_STATES as readonly string[]).includes(value)
}
