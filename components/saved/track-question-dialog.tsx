"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Radar } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TRACK_QUERY_MAX, COLLECTION_NAME_MAX } from "@/lib/validations/saved"

type Cadence = "HOURLY" | "DAILY" | "WEEKLY"

/**
 * "Track a question" — creates a self-filling collection: a NL query + cadence
 * that spins up a backing monitor and maintains a living, cited answer. The
 * user states what they want to follow; Radaric collects and synthesizes it.
 */
export function TrackQuestionDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [query, setQuery] = useState("")
  const [cadence, setCadence] = useState<Cadence>("DAILY")
  const [busy, setBusy] = useState(false)

  function reset() {
    setName("")
    setQuery("")
    setCadence("DAILY")
  }

  async function submit() {
    const trimmedName = name.trim()
    const trimmedQuery = query.trim()
    if (!trimmedName || !trimmedQuery || busy) return
    setBusy(true)
    try {
      const res = await fetch("/api/collections/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, query: trimmedQuery, cadence }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        id?: string
        name?: string
        code?: string
      }

      if (!res.ok) {
        // Branch on the server's `code` — status alone is ambiguous (both the
        // missing-Parallel-key error and a subscription-check failure return 503).
        switch (data.code) {
          case "CAP_REACHED":
            toast.error("You’ve reached the limit of tracked questions. Delete one to add another.")
            return
          case "PARALLEL_NOT_CONFIGURED":
            toast.error("Monitoring isn’t configured yet. Add a Parallel API key in Settings.")
            return
          case "SUBSCRIPTION_REQUIRED":
            toast.error("Your subscription is inactive — renew it to track questions.")
            return
          case "SUBSCRIPTION_CHECK_FAILED":
            toast.error("Couldn’t verify your subscription — try again in a moment.")
            return
        }
        if (res.status === 409) {
          toast.error("You already have a collection with that name.")
          return
        }
        throw new Error("track failed")
      }

      toast.success("Tracking started — your answer fills in as sources arrive.")
      setOpen(false)
      reset()
      if (data.id) {
        router.push(`/saved/${data.id}`)
        router.refresh()
      }
    } catch {
      toast.error("Couldn’t start tracking — try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="h-9 gap-1.5">
          <Radar className="h-[15px] w-[15px]" aria-hidden />
          Track a question
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Track a question</DialogTitle>
          <DialogDescription>
            State what you want to follow. Radaric collects sources on a schedule and
            maintains a cited answer that tells you what changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="track-name">Name</Label>
            <Input
              id="track-name"
              placeholder="e.g. EU AI Act enforcement"
              maxLength={COLLECTION_NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="track-query">What should we track?</Label>
            <Textarea
              id="track-query"
              placeholder="e.g. New enforcement actions, fines, and guidance under the EU AI Act"
              rows={3}
              maxLength={TRACK_QUERY_MAX}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Phrase it like a question or a standing brief — this is what the monitor searches for.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="track-cadence">How often?</Label>
            <Select value={cadence} onValueChange={(v) => setCadence(v as Cadence)}>
              <SelectTrigger id="track-cadence">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HOURLY">Every hour</SelectItem>
                <SelectItem value="DAILY">Once a day</SelectItem>
                <SelectItem value="WEEKLY">Once a week</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !query.trim()}>
            {busy ? "Starting…" : "Start tracking"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
