/** Safe storage wrappers — graceful no-op in private browsing / disabled storage. */

export function safeSessionGet(key: string): string | null {
  try { return sessionStorage.getItem(key) } catch { return null }
}

export function safeSessionSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value) } catch { /* noop */ }
}

/**
 * `localStorage` pair for device-level preferences (the posts open mode,
 * RAD-345). Separate from the session pair on purpose: a filter is per-tab
 * working state that should reset, a preference is per-device and should not.
 */
export function safeLocalGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function safeLocalSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* noop */ }
}
