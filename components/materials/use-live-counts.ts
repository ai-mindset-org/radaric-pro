"use client"

import { useEffect, useRef, useState } from "react"

export type LiveCounts = {
  filter?: Record<string, number>
  sourceType?: Record<string, number>
}

/**
 * The toolbar's counts, kept current (RAD-343).
 *
 * Before this, the heading read only the RSC payload: a mutation updated the
 * grid and the sidebar (via `radaric:stats-changed` → `/api/stats`) but nothing
 * refreshed the counts in the heading, so the number stood still until a full
 * reload — `router.refresh()` is deliberately reserved for the end of a run
 * (it resets loaded pages and the streamed set).
 *
 * Subscribes to the same signal the sidebar uses, plus a 30s poll for changes
 * made in another tab, and returns `null` until the first response so the
 * caller can fall back to its server-rendered counts.
 */
export function useLiveCounts(sourceId: string | null, folderId: string | null = null): LiveCounts | null {
  const [counts, setCounts] = useState<LiveCounts | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // Overlapping loads are real here (a mutation burst landing on top of a
      // 30s poll); only the newest may write, or an older snapshot wins and the
      // heading sits off by the difference until the next poll.
      const generation = ++generationRef.current
      try {
        // Source and folder scopes are mutually exclusive by construction.
        const scope = sourceId
          ? `?sourceId=${encodeURIComponent(sourceId)}`
          : folderId
            ? `?folderId=${encodeURIComponent(folderId)}`
            : ""
        const response = await fetch(`/api/posts/counts${scope}`, { cache: "no-store" })
        if (!response.ok) return
        const data = (await response.json()) as LiveCounts
        if (!cancelled && generation === generationRef.current && (data.filter || data.sourceType)) {
          setCounts(data)
        }
      } catch (error) {
        // Keep the last good counts — a failed refresh must not blank the
        // heading — but say so, or a dead endpoint looks like a frozen number.
        console.error("[live counts] refresh failed", error)
      }
    }

    void load()
    window.addEventListener("radaric:stats-changed", load)
    const interval = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.removeEventListener("radaric:stats-changed", load)
      window.clearInterval(interval)
    }
  }, [sourceId, folderId])

  return counts
}
