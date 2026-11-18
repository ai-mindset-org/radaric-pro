/**
 * Apple system-font support by user agent (RAD-363 slice 7).
 *
 * `sf` — the SF families ship with every Apple OS. `rounded` — `ui-rounded`
 * resolves only in WebKit proper: every iOS/iPadOS browser, and Safari on macOS.
 * An iPad in desktop mode sends a Macintosh user agent; its touch points give
 * it away (every iPadOS browser is WebKit, so `ui-rounded` resolves there too).
 */
const APPLE_DEVICE = /Macintosh|iPhone|iPad|iPod/
const IOS_DEVICE = /iPhone|iPad|iPod/
const NOT_SAFARI = /Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR/

export function appleFontSupport(userAgent: string, maxTouchPoints = 0): { sf: boolean; rounded: boolean } {
  const sf = APPLE_DEVICE.test(userAgent)
  const iPadDesktop = userAgent.includes("Macintosh") && maxTouchPoints > 1
  const macSafari =
    userAgent.includes("Macintosh") &&
    userAgent.includes("Safari/") &&
    userAgent.includes("Version/") &&
    !NOT_SAFARI.test(userAgent)
  return { sf, rounded: IOS_DEVICE.test(userAgent) || iPadDesktop || macSafari }
}
