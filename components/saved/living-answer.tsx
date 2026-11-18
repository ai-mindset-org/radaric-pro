"use client"

import { useState } from "react"
import ReactMarkdown from "react-markdown"
import { format } from "date-fns"
import { Sparkles, CircleDot, Check, RefreshCw, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The collection's living answer — a Karpathy-LLM-wiki-style cited markdown page
 * the LLM maintains from the collection's saves. When no answer exists yet it
 * shows the dormant promise with **Generate answer** (runs the synthesis) and
 * **Track this** (persisted cadence intent).
 */
export function LivingAnswer({
  collectionId,
  initialSynthesis,
  initialDelta,
  initialUpdatedAt,
  trackRequested,
  itemCount,
  excerptCount,
  isSelfFilling = false,
}: {
  collectionId: string
  initialSynthesis: string | null
  initialDelta: string | null
  initialUpdatedAt: string | null
  trackRequested: boolean
  itemCount: number
  excerptCount: number
  isSelfFilling?: boolean
}) {
  const [synthesis, setSynthesis] = useState(initialSynthesis)
  const [delta, setDelta] = useState(initialDelta)
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt)
  const [requested, setRequested] = useState(trackRequested)
  const [busy, setBusy] = useState(false)
  const hasSources = itemCount + excerptCount > 0
  // Parse defensively — date-fns v4 throws on an invalid Date rather than
  // returning "Invalid Date", which would crash the whole page.
  const updatedDate = (() => {
    if (!updatedAt) return null
    const d = new Date(updatedAt)
    return Number.isNaN(d.getTime()) ? null : d
  })()

  async function generate() {
    if (busy) return
    if (!hasSources) {
      toast("Save something into this collection first.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/collections/${collectionId}/synthesis`, { method: "POST" })
      if (res.status === 422) {
        toast("Save something into this collection first.")
        return
      }
      if (res.status === 429) {
        toast("Just a moment — try again in a few seconds.")
        return
      }
      if (!res.ok) throw new Error("synthesis failed")
      const data = await res.json()
      const isFirst = !synthesis
      setSynthesis(data.synthesis)
      setDelta(data.synthesisDelta)
      setUpdatedAt(data.synthesisUpdatedAt)
      setRequested(true)
      toast.success(isFirst ? "Answer generated" : "Answer refreshed")
    } catch {
      toast.error("Couldn’t generate the answer — try again.")
    } finally {
      setBusy(false)
    }
  }

  async function track() {
    if (requested || busy) return
    setBusy(true)
    setRequested(true)
    try {
      const res = await fetch(`/api/collections/${collectionId}/track`, { method: "POST" })
      if (!res.ok) throw new Error("track failed")
      toast("We’ll maintain a sourced answer here as this collection grows.", {
        description: "Noted — you’re on the list for it.",
      })
    } catch {
      setRequested(false)
      toast.error("Couldn’t note that — try again.")
    } finally {
      setBusy(false)
    }
  }

  if (synthesis) {
    return (
      <section aria-label="Maintained answer" className="surface-card rounded-xl p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-[16px] w-[16px] text-primary shrink-0" aria-hidden />
            The answer
          </h2>
          <Button variant="ghost" size="sm" className="h-9 gap-1.5 shrink-0" onClick={generate} disabled={busy}>
            <RefreshCw className={cn("h-[14px] w-[14px]", busy && "animate-spin")} aria-hidden />
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {delta && (
          <div className="mt-3 rounded-md bg-primary-subtle/60 px-3 py-2 text-sm leading-relaxed">
            <span className="font-medium text-primary-subtle-foreground">What changed — </span>
            <span className="text-foreground">{delta}</span>
          </div>
        )}

        <div className="prose prose-sm sm:prose-base max-w-none mt-3 dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight [&_a]:link">
          <ReactMarkdown
            components={{
              a: ({ ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
            }}
          >
            {synthesis}
          </ReactMarkdown>
        </div>

        {updatedDate && (
          <div className="mt-3 text-xs text-muted-foreground">
            Updated <span className="tabular-nums">{format(updatedDate, "d MMM yyyy, HH:mm")}</span> · <span className="type-counter">{itemCount + excerptCount}</span> sources
          </div>
        )}
      </section>
    )
  }

  // Dormant state.
  return (
    <section
      aria-label="Maintained answer"
      className="rounded-xl border border-dashed border-border bg-muted/40 p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-[16px] w-[16px] text-primary shrink-0" aria-hidden />
          A maintained answer will live here
        </h2>
        {isSelfFilling ? (
          <span className="inline-flex items-center gap-1.5 h-9 px-2 text-sm font-medium text-primary shrink-0" aria-live="polite">
            <Check className="h-[14px] w-[14px]" aria-hidden />
            Auto-updating
          </span>
        ) : requested ? (
          <span className="inline-flex items-center gap-1.5 h-9 px-2 text-sm font-medium text-primary shrink-0" aria-live="polite">
            <Check className="h-[14px] w-[14px]" aria-hidden />
            Tracking requested
          </span>
        ) : (
          <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-primary shrink-0" onClick={track} disabled={busy}>
            <CircleDot className="h-[14px] w-[14px]" aria-hidden />
            Track this
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-prose">
        Radaric maintains a sourced answer to what you’re tracking — and tells you what changed,
        with links to the primary sources.{" "}
        <span className="text-foreground font-medium">No saved item, no claim without a receipt.</span>
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" className="h-9 gap-1.5" onClick={generate} disabled={busy || !hasSources}>
          <Wand2 className="h-[14px] w-[14px]" aria-hidden />
          {busy ? "Generating…" : "Generate answer"}
        </Button>
        <span className="text-xs text-muted-foreground">
          <span className="type-counter">{itemCount}</span> {itemCount === 1 ? "item" : "items"} · <span className="type-counter">{excerptCount}</span> {excerptCount === 1 ? "excerpt" : "excerpts"}
        </span>
      </div>
    </section>
  )
}
