"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Bookmark } from "lucide-react"
import { toast } from "sonner"

type Pending = {
  text: string
  start: number
  end: number
  top: number
  left: number
  range: Range
}

/** Char offset of (node, nodeOffset) within container's rendered text. */
function textOffsetWithin(container: HTMLElement, node: Node, nodeOffset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let offset = 0
  let n: Node | null = walker.nextNode()
  while (n) {
    if (n === node) return offset + nodeOffset
    offset += n.textContent?.length ?? 0
    n = walker.nextNode()
  }
  // Selection started on an element boundary — best-effort fallback.
  return offset
}

/**
 * Wraps a material's content block and turns a manual text selection into a
 * "Save excerpt" action (a citation). Works with mouse (desktop) and touch
 * (native selection handles). On save it persists text + offsets and leaves a
 * quiet green wash on the passage for the session — "your annotation, in the
 * text." Offsets are computed against the rendered content, not stored DOM.
 */
export function ExcerptSaver({
  materialId,
  children,
}: {
  materialId: string
  children: React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [saving, setSaving] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const recompute = useCallback(() => {
    const container = containerRef.current
    const selection = window.getSelection()
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPending(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      setPending(null)
      return
    }
    const text = selection.toString().trim()
    if (text.length < 1) {
      setPending(null)
      return
    }
    const start = textOffsetWithin(container, range.startContainer, range.startOffset)
    const rect = range.getBoundingClientRect()
    // Place the pill above the selection, clamped into the viewport; flip below
    // when the selection sits near the top.
    const PILL_W = 132
    const above = rect.top > 64
    const top = above ? rect.top - 48 : rect.bottom + 8
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - PILL_W / 2, 8),
      window.innerWidth - PILL_W - 8
    )
    setPending({ text, start, end: start + selection.toString().length, top, left, range: range.cloneRange() })
  }, [])

  useEffect(() => {
    const onMouseUp = () => window.setTimeout(recompute, 0)
    let touchTimer: ReturnType<typeof setTimeout> | null = null
    const onSelectionChange = () => {
      if (touchTimer) clearTimeout(touchTimer)
      touchTimer = setTimeout(recompute, 250)
    }
    const onScroll = () => setPending(null)
    document.addEventListener("mouseup", onMouseUp)
    document.addEventListener("selectionchange", onSelectionChange)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("mouseup", onMouseUp)
      document.removeEventListener("selectionchange", onSelectionChange)
      window.removeEventListener("scroll", onScroll, true)
      if (touchTimer) clearTimeout(touchTimer)
    }
  }, [recompute])

  async function save() {
    if (!pending) return
    setSaving(true)
    try {
      const res = await fetch("/api/saved/excerpt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          materialId,
          text: pending.text,
          offsetStart: pending.start,
          offsetEnd: pending.end,
        }),
      })
      if (!res.ok) throw new Error("excerpt save failed")
      const data = await res.json()

      // Quiet green wash on the saved passage (best-effort; skipped for
      // selections that cross element boundaries).
      try {
        const mark = document.createElement("mark")
        mark.style.backgroundColor = "var(--primary-subtle)"
        mark.style.color = "inherit"
        mark.style.borderRadius = "2px"
        pending.range.surroundContents(mark)
      } catch {
        /* multi-node selection — leave the text as-is */
      }
      window.getSelection()?.removeAllRanges()
      setPending(null)
      toast.success(`Excerpt saved to “${data.collection.name}”`)
    } catch {
      toast.error("Couldn’t save excerpt — try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={containerRef}>
      {children}
      {mounted &&
        pending &&
        createPortal(
          <button
            type="button"
            // The peek's outside-click-to-close must not swallow this pill: it
            // is portaled to <body> (fixed coordinates) but belongs to the
            // article, so the panel checks for this marker before dismissing.
            data-excerpt-pill=""
            // Don't let the press collapse the selection before we save it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={saving}
            style={{
              position: "fixed",
              top: pending.top,
              left: pending.left,
              zIndex: 60,
              // The pill is a child of <body>, and the peek's modal sheet sets
              // `pointer-events: none` on the body while it is open — inherited,
              // which would make the pill untappable. Re-enable it here rather
              // than moving the portal: the pill's coordinates are viewport-fixed
              // by design and the sheet is a modal layer either way.
              pointerEvents: "auto",
            }}
            className="inline-flex items-center gap-1.5 h-10 rounded-full border border-border bg-popover px-3.5 text-sm font-medium text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 disabled:opacity-60"
          >
            <Bookmark className="h-[16px] w-[16px] text-primary" aria-hidden />
            Save excerpt
          </button>,
          document.body
        )}
    </div>
  )
}
