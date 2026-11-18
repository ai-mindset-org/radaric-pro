/**
 * Sheet drag maths — the pure half of the mobile bottom sheet's dismiss gesture
 * (RAD-345). The hook in `peek-sheet.tsx` measures; this module decides, so the
 * thresholds are unit-tested without touch events (which jsdom does not have).
 */

/** Past this travel, releasing dismisses — regardless of speed. */
export const DISMISS_DISTANCE_PX = 96
/** A flick faster than this (px/ms) dismisses early — but only past the floor. */
export const DISMISS_VELOCITY_PX_PER_MS = 0.5
/**
 * The floor a flick still has to travel. Without it, the 1px twitch a finger
 * makes while lifting, sampled into a large velocity, would dismiss the sheet
 * out of nowhere.
 */
export const FLICK_FLOOR_PX = 24

export type DismissDecision = "dismiss" | "snap-back"

/**
 * Should releasing the drag close the sheet?
 *
 * `scrollTop > 0` always snaps back: the gesture only exists at the top of the
 * content, where a downward drag has nothing to scroll. Under reduced motion
 * the velocity shortcut is dropped — the sheet would not visibly track the
 * fling (the global guard collapses the animation), so a fast twitch must not
 * dismiss a sheet that barely moved.
 */
export function dismissDecision(input: {
  /** Downward travel since the drag began, in px (negative = upward). */
  deltaY: number
  /** Release velocity in px/ms (positive = downward). */
  velocity: number
  /** The inner scroller's offset when the drag began. */
  scrollTop: number
  reducedMotion: boolean
}): DismissDecision {
  const { deltaY, velocity, scrollTop, reducedMotion } = input
  if (scrollTop > 0) return "snap-back"
  if (deltaY <= 0) return "snap-back"
  if (deltaY >= DISMISS_DISTANCE_PX) return "dismiss"
  if (!reducedMotion && velocity >= DISMISS_VELOCITY_PX_PER_MS && deltaY >= FLICK_FLOOR_PX) {
    return "dismiss"
  }
  return "snap-back"
}

/**
 * iOS rubber-band: travel away from the target is resisted, growing slower
 * than the finger. Used for upward drags (the sheet is already fully open) and
 * for travel beyond the fully-open or fully-closed ends.
 */
export function rubberBand(deltaY: number, dimension: number, constant = 0.55): number {
  if (deltaY >= 0) return deltaY
  const magnitude = Math.abs(deltaY)
  return -(magnitude * dimension * constant) / (dimension + constant * magnitude)
}

/** Travel as a (0..1) dismissal fraction, for backdrop opacity and the like. */
export function dismissProgress(deltaY: number, dimension: number): number {
  if (dimension <= 0) return 0
  return Math.min(1, Math.max(0, deltaY / dimension))
}
