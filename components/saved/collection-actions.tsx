"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Radar, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DiscoverSourcesDialog } from "@/components/saved/discover-sources-dialog"

const CADENCE_LABEL: Record<string, string> = {
  HOURLY: "hourly",
  DAILY: "daily",
  WEEKLY: "weekly",
}

/**
 * Collection-detail actions: the self-filling indicator (query + cadence) for
 * tracked questions, and a delete control. Deleting a tracked question also
 * tears down its backing monitor (handled server-side).
 */
export function CollectionActions({
  collectionId,
  name,
  query,
  cadence,
  isSystem,
}: {
  collectionId: string
  name: string
  query: string | null
  cadence: string | null
  isSystem: boolean
}) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const isSelfFilling = query != null

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const res = await fetch(`/api/collections/${collectionId}/refresh`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "refresh failed")

      const status = data.synthesisStatus as string | null | undefined
      if (data.created > 0 || status === "ok") {
        const bits: string[] = []
        if (data.created > 0) bits.push(`Found ${data.created} new ${data.created === 1 ? "source" : "sources"}`)
        if (status === "ok") bits.push("answer updated")
        toast.success(bits.length ? `${bits.join(" — ")}.` : "Updated.")
        router.refresh()
      } else if (status === "empty") {
        toast.info("No sources to build an answer from yet — add a source or check back soon.")
      } else if (status && status !== "ok") {
        // synthesis was attempted but didn't land (e.g. its own short cooldown)
        toast.info("Couldn’t update the answer just now — try again shortly.")
      } else {
        toast.info("No new sources yet — we’ll keep watching.")
      }
    } catch (e) {
      const msg = e instanceof Error && e.message !== "refresh failed" ? e.message : "Couldn’t check for updates — try again."
      toast.error(msg)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDelete() {
    if (deleting) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/collections/${collectionId}`, { method: "DELETE" })
      if (!res.ok) throw new Error("delete failed")
      toast.success(isSelfFilling ? "Tracked question deleted" : "Collection deleted")
      router.push("/saved")
      router.refresh()
    } catch {
      toast.error("Couldn’t delete — try again.")
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      {isSelfFilling ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Radar className="h-[15px] w-[15px] text-primary shrink-0" aria-hidden />
          <span>
            Tracking {CADENCE_LABEL[cadence ?? "DAILY"]} — updates automatically as new sources arrive
          </span>
        </p>
      ) : (
        <span />
      )}

      <div className="flex items-center gap-1">
        {isSelfFilling && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1.5 text-muted-foreground"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-[14px] w-[14px] ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            {refreshing ? "Checking…" : "Check for updates"}
          </Button>
        )}
        {isSelfFilling && <DiscoverSourcesDialog collectionId={collectionId} />}
        {!isSystem && (
          <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-[14px] w-[14px]" aria-hidden />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                {isSelfFilling
                  ? "This stops the monitor and removes the maintained answer along with its collected sources. This can’t be undone."
                  : "This removes the collection and its saved items and excerpts. This can’t be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  handleDelete()
                }}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        )}
      </div>
    </div>
  )
}
