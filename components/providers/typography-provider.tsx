"use client"

/**
 * TypographyProvider (RAD-363) — holds the user's font choice and renders it as
 * one `<style data-radaric-typography>`, so a change repaints the whole page
 * without a navigation. `setPrefs` applies optimistically, persists via PATCH
 * and, when the latest save fails, reverts to the last confirmed prefs.
 *
 * Saves are serialized: one PATCH in flight, the newest change queued behind
 * it. Aborting in the browser would not stop the server's upsert, so an older
 * value could land after a newer one; a queue keeps the database in click order.
 */
import * as React from "react"
import { toast } from "sonner"
import { buildTypographyCss } from "@/lib/typography/css"
import { DEFAULT_TYPOGRAPHY, parseTypographyPrefs, type TypographyPrefs } from "@/lib/typography/prefs"

type TypographyContextValue = {
  prefs: TypographyPrefs
  setPrefs: (next: TypographyPrefs | null) => void
}

const TypographyContext = React.createContext<TypographyContextValue | null>(null)

export function TypographyProvider({
  initialPrefs,
  children,
}: {
  initialPrefs: TypographyPrefs
  children: React.ReactNode
}) {
  const [prefs, setPrefsState] = React.useState(() => parseTypographyPrefs(initialPrefs))
  const confirmedRef = React.useRef(prefs)
  const inflightRef = React.useRef(false)
  const pendingRef = React.useRef<TypographyPrefs | null | undefined>(undefined)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** Sends queued values one at a time until the queue is empty. */
  const drain = React.useCallback(async () => {
    if (inflightRef.current) return
    inflightRef.current = true
    while (pendingRef.current !== undefined) {
      const job = pendingRef.current
      pendingRef.current = undefined
      try {
        const res = await fetch("/api/user-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ typography: job }),
          keepalive: true,
        })
        if (!res.ok) throw new Error(`typography save failed: ${res.status}`)
        confirmedRef.current = job ?? { ...DEFAULT_TYPOGRAPHY }
      } catch {
        // A newer value is queued behind this one: it supersedes the failure.
        if (pendingRef.current === undefined && mountedRef.current) {
          setPrefsState(confirmedRef.current)
          toast.error("Failed to save font choice")
        }
      }
    }
    inflightRef.current = false
  }, [])

  const setPrefs = React.useCallback(
    (next: TypographyPrefs | null) => {
      const applied = next === null ? null : parseTypographyPrefs(next)
      setPrefsState(applied ?? { ...DEFAULT_TYPOGRAPHY })
      pendingRef.current = applied
      void drain()
    },
    [drain],
  )

  const value = React.useMemo(() => ({ prefs, setPrefs }), [prefs, setPrefs])

  return (
    <TypographyContext.Provider value={value}>
      <style data-radaric-typography="">{buildTypographyCss(prefs)}</style>
      {children}
    </TypographyContext.Provider>
  )
}

export function useTypography(): TypographyContextValue {
  const context = React.useContext(TypographyContext)
  if (!context) throw new Error("useTypography must be used within a TypographyProvider")
  return context
}
