import type { ReactNode } from "react"

/**
 * What both peek presentations need (RAD-345): the desktop panel and the
 * mobile sheet render the same header and the same children, and differ only in
 * chrome, positioning and gesture.
 */
export interface PeekPresentationProps {
  open: boolean
  onClose: () => void
  /** The item's title — empty while loading (the host then labels the dialog). */
  title: string
  /** Canonical full-page route for the current target. */
  href: string
  onNavigate?: (direction: "next" | "previous") => void
  canPrevious?: boolean
  canNext?: boolean
  /**
   * Where focus goes when the dialog closes. Radix restores focus to the
   * element that was focused before it opened — normally the card. When the
   * card no longer exists (the peek's own Delete removed it), this returns the
   * next best target instead of letting focus fall to `body`.
   */
  restoreFocus?: () => HTMLElement | null
  children: ReactNode
}
