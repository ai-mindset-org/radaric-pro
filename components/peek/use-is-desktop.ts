"use client"

/**
 * `lg` and up: the side panel. Below it: the bottom sheet (RAD-345).
 *
 * `lg`, not the shell's `md`: at 768–1023px the app has a 260px sidebar, so a
 * 400px panel would leave the list less than a column wide. Below `lg` a sheet
 * is also the honest mobile/tablet idiom.
 *
 * Returns `null` until mounted so the host can render **nothing** on the first
 * client frame. Otherwise a desktop deep link would mount the modal sheet for
 * one frame — scroll lock, focus trap, `aria-modal`, then a swap — and jsdom
 * (no `matchMedia`) would throw on every render in the existing suites.
 */

import { useEffect, useState } from "react"

export const DESKTOP_PEEK_QUERY = "(min-width: 1024px)"

export function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      // Non-browser or jsdom: the sheet is the safe assumption, but the host
      // only matters after mount anyway.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the value is only knowable after mount; `null` is the SSR-consistent first render.
      setIsDesktop(false)
      return
    }
    const query = window.matchMedia(DESKTOP_PEEK_QUERY)
    setIsDesktop(query.matches)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  return isDesktop
}
