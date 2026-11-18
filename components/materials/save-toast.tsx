"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Bookmark, Check, ChevronDown, Plus } from "lucide-react"
import { cn } from "@/lib/utils"

type CollectionLite = { id: string; name: string; isSystem: boolean }

/**
 * The post-save toast: confirms where the save landed, and offers a
 * frictionless "Move ▾" (re-file into / create another topic-collection) and
 * "Undo" — the design's resolution of the friction-vs-signal tension. Rendered
 * via `toast.custom`, so it owns its own markup.
 */
export function SaveToast({
  toastId,
  materialId,
  collection,
  onUndo,
  onMoved,
}: {
  toastId: string | number
  materialId: string
  collection: { id: string; name: string }
  onUndo: () => void
  onMoved?: (collection: { id: string; name: string }) => void
}) {
  const [name, setName] = useState(collection.name)
  const [activeId, setActiveId] = useState(collection.id)
  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<CollectionLite[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)

  async function toggleMove() {
    const next = !open
    setOpen(next)
    if (next && collections === null) {
      try {
        const res = await fetch("/api/collections")
        if (res.ok) setCollections((await res.json()).collections)
      } catch {
        /* leave null — list just stays empty */
      }
    }
  }

  async function moveTo(opts: { collectionId?: string; collectionName?: string }) {
    setBusy(true)
    try {
      const res = await fetch(`/api/saved/${materialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setName(data.collection.name)
      setActiveId(data.collection.id)
      setOpen(false)
      setCreating(false)
      setNewName("")
      onMoved?.(data.collection)
    } catch {
      toast.error("Couldn’t move — try again.")
    } finally {
      setBusy(false)
    }
  }

  async function undo() {
    try {
      await fetch(`/api/saved/${materialId}`, { method: "DELETE" })
    } catch {
      /* best-effort */
    }
    onUndo()
    toast.dismiss(toastId)
  }

  return (
    <div className="w-[340px] max-w-[88vw] rounded-xl border border-border bg-popover text-popover-foreground shadow-lg px-4 py-3">
      <div className="flex items-center gap-2">
        <Bookmark className="h-[16px] w-[16px] fill-current text-primary shrink-0" aria-hidden />
        <span className="text-sm flex-1 min-w-0 truncate">
          Saved to <span className="font-medium animate-count-swap" key={name}>{name}</span>
        </span>
        <button
          type="button"
          onClick={toggleMove}
          className="shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors rounded px-1.5 py-1 min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
          aria-expanded={open}
        >
          Move
          <ChevronDown className={cn("h-[14px] w-[14px] transition-transform", open && "rotate-180")} />
        </button>
        <button
          type="button"
          onClick={undo}
          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors rounded px-1.5 py-1 min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
        >
          Undo
        </button>
      </div>

      {open && (
        <div className="mt-2 pt-2 border-t border-hairline">
          <ul className="max-h-44 overflow-y-auto space-y-0.5" role="list">
            {(collections ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy || c.id === activeId}
                  onClick={() => moveTo({ collectionId: c.id })}
                  className="w-full flex items-center gap-2 text-left text-sm rounded-sm px-2 py-1.5 min-h-[36px] hover:bg-accent disabled:opacity-100 transition-colors"
                >
                  <span className="flex-1 truncate">{c.name}</span>
                  {c.id === activeId && <Check className="h-[14px] w-[14px] text-primary shrink-0" />}
                </button>
              </li>
            ))}
          </ul>

          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const trimmed = newName.trim()
                if (trimmed) moveTo({ collectionName: trimmed })
              }}
              className="mt-1 flex items-center gap-1"
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                placeholder="Name a collection"
                aria-label="New collection name"
                className="flex-1 min-w-0 h-9 rounded-sm border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="shrink-0 h-9 rounded-sm bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Create
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-1 w-full flex items-center gap-2 text-left text-sm rounded-sm px-2 py-1.5 min-h-[36px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Plus className="h-[14px] w-[14px] shrink-0" />
              New collection…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
