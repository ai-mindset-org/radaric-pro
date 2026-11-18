"use client"

/**
 * Open mode — where a card click sends a post or a story (RAD-345).
 *
 *   - `"page"`   — the full-page route, exactly as before this feature.
 *   - `"drawer"` — the side peek: panel on `lg+`, bottom sheet below it.
 *
 * Persisted per device in `localStorage` (a display preference, not account
 * data), and hydrated **after mount**: reading storage in the initializer made
 * the client's first render disagree with the server's — the React #418 class
 * of blank-on-iOS-Safari failures this repo hit once already in
 * `materials-list.tsx`. The default is therefore always `"page"` for the first
 * paint, then the stored choice applies.
 */

import { useCallback, useEffect, useState } from "react"
import { safeLocalGet, safeLocalSet } from "@/lib/safe-storage"

export type OpenMode = "page" | "drawer"

export const OPEN_MODE_KEY = "radaric-open-mode"
export const DEFAULT_OPEN_MODE: OpenMode = "page"

/** Pure parse: anything that is not the explicit `"drawer"` reads as the default. */
export function resolveOpenMode(raw: string | null | undefined): OpenMode {
  return raw === "drawer" ? "drawer" : DEFAULT_OPEN_MODE
}

export function useOpenMode(): [OpenMode, (next: OpenMode) => void] {
  const [mode, setMode] = useState<OpenMode>(DEFAULT_OPEN_MODE)

  useEffect(() => {
    // Hydration pass only: the stored choice is applied once, after the first
    // render has matched the server's. See the module comment — reading storage
    // in the initializer is the React #418 class of bug this repo has already
    // paid for once. The lint rule against setState-in-effect is right in
    // general and wrong here: this is the documented post-hydration read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(resolveOpenMode(safeLocalGet(OPEN_MODE_KEY)))
  }, [])

  const setOpenMode = useCallback((next: OpenMode) => {
    setMode(next)
    safeLocalSet(OPEN_MODE_KEY, next)
  }, [])

  return [mode, setOpenMode]
}
