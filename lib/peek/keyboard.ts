/**
 * Keyboard intent for peek navigation (RAD-345).
 *
 * `j`/`k` walk the peek's target order — the Gmail/reader convention, chosen
 * over the arrow keys on purpose: arrows are the scroller's to own and would
 * fight a long article, and they move the caret inside a selection. The keys
 * are ignored while the user is typing, and while a text selection is live —
 * `ExcerptSaver` turns a selection into a "Save excerpt" action, and stomping
 * it to jump to the next item would lose the citation the reader was making.
 */

export type NavKeyIntent = "next" | "previous" | null

/** Editable targets swallow every nav key. */
function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : ""
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return el.isContentEditable === true
}

export function navKeyIntent(input: {
  key: string
  /** `KeyboardEvent.target` — typed loosely so tests need no DOM cast. */
  target: unknown
  selectionCollapsed: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): NavKeyIntent {
  const { key, target, selectionCollapsed, altKey, ctrlKey, metaKey } = input
  if (altKey || ctrlKey || metaKey) return null
  if (isEditableTarget(target)) return null
  if (!selectionCollapsed) return null
  switch (key.toLowerCase()) {
    case "j":
      return "next"
    case "k":
      return "previous"
    default:
      return null
  }
}
