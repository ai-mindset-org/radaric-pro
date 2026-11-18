"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Bookmark } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { SaveToast } from "./save-toast"

interface MaterialSaveButtonProps {
  materialId: string
  /** SSR-known saved state so the bookmark renders filled on load. */
  initialSaved?: boolean
  /** Icon-only (in the card action row) vs labelled (detail view). */
  compact?: boolean
  /** Called after a successful unsave — e.g. the Library refreshes the view. */
  onUnsave?: () => void
}

/**
 * Self-contained Save action — mirrors MaterialFeedbackButtons: optimistic
 * fill + `.animate-icon-pop`, calls the API directly, rolls back on failure.
 * On a fresh save it raises the SaveToast (smart-default collection + Move/Undo).
 * Clicking again toggles the save off (a bookmark is a toggle).
 */
export function MaterialSaveButton({
  materialId,
  initialSaved = false,
  compact = false,
  onUnsave,
}: MaterialSaveButtonProps) {
  const [saved, setSaved] = useState(initialSaved)
  const [isProcessing, setIsProcessing] = useState(false)
  const confirmed = useRef(initialSaved)
  // Re-keys the icon to replay the pop animation on each confirmed save.
  const [popKey, setPopKey] = useState(0)

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (isProcessing) return
    setIsProcessing(true)

    if (!saved) {
      // Optimistic save.
      setSaved(true)
      setPopKey((k) => k + 1)
      try {
        const res = await fetch("/api/saved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ materialId }),
        })
        if (!res.ok) throw new Error("save failed")
        const data = await res.json()
        confirmed.current = true
        toast.custom(
          (t) => (
            <SaveToast
              toastId={t}
              materialId={materialId}
              collection={data.collection}
              onUndo={() => {
                setSaved(false)
                confirmed.current = false
              }}
            />
          ),
          { duration: 5000 }
        )
      } catch {
        setSaved(confirmed.current)
        toast.error("Couldn’t save — try again.")
      } finally {
        setIsProcessing(false)
      }
    } else {
      // Toggle off (unsave).
      setSaved(false)
      try {
        const res = await fetch(`/api/saved/${materialId}`, { method: "DELETE" })
        if (!res.ok) throw new Error("unsave failed")
        confirmed.current = false
        onUnsave?.()
      } catch {
        setSaved(confirmed.current)
        toast.error("Couldn’t update — try again.")
      } finally {
        setIsProcessing(false)
      }
    }
  }

  return (
    <Button
      variant="ghost"
      size={compact ? "icon" : "default"}
      className={cn("h-11 min-w-11", saved && "text-primary")}
      onClick={handleClick}
      disabled={isProcessing}
      aria-label={saved ? "Saved" : "Save"}
      aria-pressed={saved}
    >
      <Bookmark
        key={popKey}
        className={cn("h-[16px] w-[16px]", saved && "fill-current animate-icon-pop")}
      />
      {!compact && <span className="ml-2">{saved ? "Saved" : "Save"}</span>}
    </Button>
  )
}
