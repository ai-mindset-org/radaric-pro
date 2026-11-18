"use client"

/**
 * Chooses how the peek is presented (RAD-345): the docked desktop panel at
 * `lg`+, the bottom sheet below it. One open state, two skins — a resize across
 * the breakpoint swaps the skin without closing the peek, because the state
 * lives with the caller (`MaterialsList`), not here.
 */

import { useIsDesktop } from "./use-is-desktop"
import { PeekPanel } from "./peek-panel"
import { PeekSheet } from "./peek-sheet"
import type { PeekPresentationProps } from "./peek-props"

export function PeekHost(props: PeekPresentationProps) {
  const isDesktop = useIsDesktop()

  // Nothing until the presentation is resolved: mounting the modal sheet for a
  // frame at a desktop width would take the scroll lock and the focus trap.
  // After that the host stays mounted and `open` drives Radix — returning null
  // on close would tear the content down in the same commit and kill the exit
  // animation the panel/sheet classes ask for.
  if (isDesktop === null) return null

  return isDesktop ? <PeekPanel {...props} /> : <PeekSheet {...props} />
}
