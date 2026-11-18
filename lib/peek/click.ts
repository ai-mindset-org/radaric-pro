/**
 * Click intent — "is this click asking for the canonical page in a new tab?",
 * shared by the card and the story's material rows (RAD-345).
 *
 * In drawer mode a plain click opens the side peek, but a modified click must
 * keep doing what it does everywhere else: open the full page in a new tab.
 * Keeping the predicate in one place means the two surfaces cannot disagree
 * about which modifiers count.
 */

/** The subset of a DOM click event this predicate needs. */
export interface ModifierClick {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  button?: number
}

export function isNewTabClick(event: ModifierClick): boolean {
  // Middle click (aux button 1) is a new-tab gesture on every desktop browser.
  if (event.button === 1) return true
  return Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
}

/**
 * `auxclick` — the middle button's own event (a middle press never fires
 * `click`). Modifiers are not consulted: the non-default button is the intent.
 */
export function isAuxNewTab(event: { button?: number }): boolean {
  return event.button === 1
}
