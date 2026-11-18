"use client"

import { useId, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { FolderResult } from "./sidebar-tree-provider"

/**
 * The one inline name editor for folders — creation and rename share it
 * (RAD-393). Enter/blur commits, Esc cancels, an empty or unchanged value
 * cancels silently. A duplicate/invalid result keeps the input open, shows the
 * inline message and returns focus so the message is announced; the parent
 * closes the editor on success.
 */
export function SidebarNameInput({
  defaultValue = "",
  ariaLabel,
  failureMessage,
  onCommit,
  onCancel,
  className,
}: {
  defaultValue?: string
  ariaLabel: string
  /** Shown on transport/validation failure (duplicate has its own fixed copy). */
  failureMessage: string
  onCommit: (name: string) => Promise<FolderResult>
  onCancel: () => void
  className?: string
}) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<"duplicate" | "failed" | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const settledRef = useRef(false)
  const errorId = useId()

  const errorMessage =
    error === "duplicate"
      ? "A folder with this name already exists."
      : error === "failed"
        ? failureMessage
        : null

  async function commit() {
    if (pending || settledRef.current) return
    const name = value.trim()
    if (!name || name === defaultValue.trim()) {
      settledRef.current = true
      onCancel()
      return
    }
    setPending(true)
    const result = await onCommit(name)
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    settledRef.current = true
  }

  return (
    <div className={cn("min-w-0 flex-1", className)}>
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={event => {
          setValue(event.target.value)
          setError(null)
        }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault()
            void commit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            settledRef.current = true
            onCancel()
          }
        }}
        onBlur={() => {
          if (pending) return
          // A visible error is already the answer to this commit; blurring
          // again must not re-refocus forever. Cancel instead.
          if (error) {
            settledRef.current = true
            onCancel()
            return
          }
          void commit()
        }}
        onFocus={event => event.target.select()}
        placeholder="Folder name"
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={pending}
        maxLength={60}
        className={cn(
          "h-9 w-full rounded-md bg-background px-2 text-sm outline-none transition-shadow",
          "ring-1 ring-inset focus-visible:ring-2",
          error
            ? "ring-destructive focus-visible:ring-destructive"
            : "ring-hairline focus-visible:ring-ring/55"
        )}
      />
      {errorMessage && (
        <p id={errorId} className="px-1 pt-0.5 text-[11px] leading-tight text-destructive">
          {errorMessage}
        </p>
      )}
    </div>
  )
}
