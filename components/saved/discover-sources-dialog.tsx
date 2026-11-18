"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Compass, Check, Loader2, Rss, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type DiscoveredSource = { name: string; feedUrl: string; reason: string; alreadyAdded: boolean }

/**
 * "Discover sources" for a tracked question: asks the server to LLM-suggest +
 * validate real RSS feeds for the question's query, lets the user pick, and adds
 * the chosen ones as feeds (canonical POST /api/feeds). Slice-2 routing then
 * pulls their matching content into the question automatically. State resets on
 * close, so reopening runs a fresh discovery (subject to the server cooldown).
 */
export function DiscoverSourcesDialog({ collectionId }: { collectionId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [ran, setRan] = useState(false)
  const [sources, setSources] = useState<DiscoveredSource[]>([])
  const [suggested, setSuggested] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function reset() {
    setLoading(false)
    setRan(false)
    setSources([])
    setSuggested(0)
    setSelected(new Set())
  }

  async function discover() {
    setLoading(true)
    try {
      const res = await fetch(`/api/collections/${collectionId}/discover`, { method: "POST" })
      const data = (await res.json().catch(() => ({}))) as {
        sources?: DiscoveredSource[]
        suggested?: number
        code?: string
      }
      if (!res.ok) {
        if (data.code === "COOLDOWN") toast("Just a moment — try again shortly.")
        else if (data.code === "AI_NOT_CONFIGURED") toast.error("Source discovery needs an AI key — configure it in Settings.")
        else throw new Error("discover failed")
        return
      }
      const found = data.sources ?? []
      setSources(found)
      setSuggested(data.suggested ?? found.length)
      setSelected(new Set(found.filter((s) => !s.alreadyAdded).map((s) => s.feedUrl)))
      setRan(true)
    } catch {
      toast.error("Couldn’t discover sources — try again.")
    } finally {
      setLoading(false)
    }
  }

  function toggle(feedUrl: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(feedUrl)) next.delete(feedUrl)
      else next.add(feedUrl)
      return next
    })
  }

  async function addSelected() {
    const picks = sources.filter((s) => selected.has(s.feedUrl) && !s.alreadyAdded)
    if (picks.length === 0 || adding) return
    setAdding(true)
    try {
      const results = await Promise.all(
        picks.map((s) =>
          fetch("/api/feeds", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "RSS", name: s.name, url: s.feedUrl, isActive: true }),
          })
            .then((r) => r.ok)
            .catch(() => false)
        )
      )
      const added = results.filter(Boolean).length
      const failed = picks.length - added
      if (added > 0) {
        toast.success(
          `Added ${added} source${added === 1 ? "" : "s"}${failed > 0 ? ` (${failed} couldn’t be added)` : ""} — new posts will flow into this answer.`
        )
        setOpen(false)
        reset()
        router.refresh()
      } else {
        toast.error("Couldn’t add those sources — try again.")
      }
    } finally {
      setAdding(false)
    }
  }

  const selectableCount = sources.filter((s) => !s.alreadyAdded).length
  const selectedCount = sources.filter((s) => selected.has(s.feedUrl) && !s.alreadyAdded).length
  const dropped = Math.max(0, suggested - sources.length)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) discover()
        else reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-primary">
          <Compass className="h-[14px] w-[14px]" aria-hidden />
          Discover sources
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Discover sources</DialogTitle>
          <DialogDescription>
            Reputable feeds that regularly cover this question. Pick the ones to follow — their new
            posts will flow into this answer automatically.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Finding and verifying sources…
          </div>
        ) : ran && sources.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {suggested > 0
              ? "Suggestions came back, but none had a usable RSS feed. Try rephrasing the question, or add feeds manually."
              : "No sources found for this question. Try rephrasing it, or add feeds manually."}
          </div>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto scrollbar-stable pr-1">
            {sources.map((s) => {
              const isSelected = selected.has(s.feedUrl) && !s.alreadyAdded
              return (
                <button
                  key={s.feedUrl}
                  type="button"
                  disabled={s.alreadyAdded}
                  onClick={() => toggle(s.feedUrl)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                    s.alreadyAdded
                      ? "border-hairline bg-muted/40 opacity-70"
                      : isSelected
                        ? "border-primary/50 bg-primary-subtle/40"
                        : "border-border hover:bg-muted/40"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border",
                      isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border"
                    )}
                    aria-hidden
                  >
                    {(isSelected || s.alreadyAdded) && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <Rss className="h-[13px] w-[13px] shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      {s.alreadyAdded && (
                        <span className="type-tag shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Added
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{s.reason}</span>
                    <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground/80">
                      <ExternalLink className="h-[10px] w-[10px] shrink-0" aria-hidden />
                      {s.feedUrl.replace(/^https?:\/\//, "")}
                    </span>
                  </span>
                </button>
              )
            })}
            {dropped > 0 && (
              <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                {dropped} suggestion{dropped === 1 ? "" : "s"} had no usable RSS feed and {dropped === 1 ? "was" : "were"} skipped.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={adding}>
            Close
          </Button>
          {ran && selectableCount > 0 && (
            <Button onClick={addSelected} disabled={adding || selectedCount === 0}>
              {adding ? "Adding…" : `Add ${selectedCount} source${selectedCount === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
