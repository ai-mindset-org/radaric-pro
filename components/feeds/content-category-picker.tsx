"use client"

import { useState, useRef, useCallback } from "react"
import { LIKED_CATEGORIES, DISLIKED_CATEGORIES } from "@/lib/content-categories"
import { cn } from "@/lib/utils"
import { Plus, Check, X } from "lucide-react"

const LIKED_SET = new Set<string>(LIKED_CATEGORIES)
const DISLIKED_SET = new Set<string>(DISLIKED_CATEGORIES)
const MAX_CUSTOM_LENGTH = 50

interface ContentCategoryPickerProps {
  likedCategories: string[]
  dislikedCategories: string[]
  onLikedChange: (categories: string[]) => void
  onDislikedChange: (categories: string[]) => void
  customPool?: { liked: string[]; disliked: string[] }
  disabled?: boolean
}

function CategoryChip({
  label,
  selected,
  variant,
  onClick,
  onRemove,
  disabled,
}: {
  label: string
  selected: boolean
  variant: "liked" | "disliked"
  onClick: () => void
  onRemove?: () => void
  disabled?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-0">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "type-tag inline-flex items-center px-3 py-2 text-sm font-medium transition-colors min-h-11",
          onRemove ? "rounded-l-md" : "rounded-md",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
          disabled && "opacity-50 cursor-not-allowed",
          !selected && "bg-secondary text-muted-foreground hover:bg-accent",
          selected && variant === "liked" && "bg-primary-subtle text-primary-subtle-foreground",
          selected && variant === "disliked" && "bg-destructive-subtle text-destructive"
        )}
      >
        {label}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          disabled={disabled}
          className={cn(
            "inline-flex items-center justify-center min-w-11 px-2 py-2 text-sm rounded-r-md transition-colors min-h-11",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
            disabled && "opacity-50 cursor-not-allowed",
            variant === "liked" && "bg-primary-subtle text-primary-subtle-foreground hover:bg-primary-subtle/70",
            variant === "disliked" && "bg-destructive-subtle text-destructive hover:bg-destructive-subtle/70"
          )}
        >
          <X className="h-[16px] w-[16px]" />
        </button>
      )}
    </span>
  )
}

function AddCategoryInput({
  variant,
  existingCategories,
  oppositeCategories,
  onChange,
  onCancel,
}: {
  variant: "liked" | "disliked"
  existingCategories: string[]
  oppositeCategories: string[]
  onChange: (categories: string[]) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState("")

  function handleSubmit() {
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.length > MAX_CUSTOM_LENGTH) return
    const lowerExisting = existingCategories.map((c) => c.toLowerCase())
    const lowerOpposite = oppositeCategories.map((c) => c.toLowerCase())
    if (lowerExisting.includes(trimmed.toLowerCase())) return
    if (lowerOpposite.includes(trimmed.toLowerCase())) return

    onChange([...existingCategories, trimmed])
    setValue("")
    onCancel()
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            handleSubmit()
          }
          if (e.key === "Escape") onCancel()
        }}
        maxLength={MAX_CUSTOM_LENGTH}
        placeholder="Custom category"
        aria-label="Custom category name"
        autoFocus
        className={cn(
          "h-11 w-40 px-3 py-2 text-sm rounded-l-md bg-secondary",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        )}
      />
      <button
        type="button"
        aria-label="Confirm"
        onClick={handleSubmit}
        className={cn(
          "inline-flex items-center justify-center h-11 w-11 rounded-r-md transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
          variant === "liked" && "bg-primary-subtle text-primary-subtle-foreground hover:bg-primary-subtle/70",
          variant === "disliked" && "bg-destructive-subtle text-destructive hover:bg-destructive-subtle/70"
        )}
      >
        <Check className="h-[16px] w-[16px]" />
      </button>
    </span>
  )
}

export function ContentCategoryPicker({
  likedCategories,
  dislikedCategories,
  onLikedChange,
  onDislikedChange,
  customPool,
  disabled,
}: ContentCategoryPickerProps) {
  const [addingLiked, setAddingLiked] = useState(false)
  const [addingDisliked, setAddingDisliked] = useState(false)
  const addLikedRef = useRef<HTMLButtonElement>(null)
  const addDislikedRef = useRef<HTMLButtonElement>(null)

  const cancelLiked = useCallback(() => {
    setAddingLiked(false)
    requestAnimationFrame(() => addLikedRef.current?.focus())
  }, [])

  const cancelDisliked = useCallback(() => {
    setAddingDisliked(false)
    requestAnimationFrame(() => addDislikedRef.current?.focus())
  }, [])

  function toggleCategory(
    category: string,
    current: string[],
    onChange: (categories: string[]) => void
  ) {
    if (current.includes(category)) {
      onChange(current.filter((c) => c !== category))
    } else {
      onChange([...current, category])
    }
  }

  // Custom categories currently selected on this source
  const customLiked = likedCategories.filter((c) => !LIKED_SET.has(c))
  const customDisliked = dislikedCategories.filter((c) => !DISLIKED_SET.has(c))

  // Pool categories from other sources that aren't selected here (show as unselected toggleable chips)
  const poolLiked = (customPool?.liked ?? []).filter(
    (c) => !likedCategories.includes(c) && !LIKED_SET.has(c)
  )
  const poolDisliked = (customPool?.disliked ?? []).filter(
    (c) => !dislikedCategories.includes(c) && !DISLIKED_SET.has(c)
  )

  return (
    <div className="space-y-5">
      {/* Liked categories */}
      <div className="space-y-2.5">
        <label id="liked-label" className="text-sm font-medium">I want to see</label>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="liked-label">
          {LIKED_CATEGORIES.map((cat) => (
            <CategoryChip
              key={cat}
              label={cat}
              selected={likedCategories.includes(cat)}
              variant="liked"
              onClick={() => toggleCategory(cat, likedCategories, onLikedChange)}
              disabled={disabled}
            />
          ))}
          {customLiked.map((cat) => (
            <CategoryChip
              key={`custom-${cat}`}
              label={cat}
              selected={true}
              variant="liked"
              onClick={() => toggleCategory(cat, likedCategories, onLikedChange)}
              onRemove={() => onLikedChange(likedCategories.filter((c) => c !== cat))}
              disabled={disabled}
            />
          ))}
          {poolLiked.map((cat) => (
            <CategoryChip
              key={`pool-${cat}`}
              label={cat}
              selected={false}
              variant="liked"
              onClick={() => toggleCategory(cat, likedCategories, onLikedChange)}
              disabled={disabled}
            />
          ))}
          {addingLiked ? (
            <AddCategoryInput
              variant="liked"
              existingCategories={likedCategories}
              oppositeCategories={dislikedCategories}
              onChange={onLikedChange}
              onCancel={cancelLiked}
            />
          ) : (
            <button
              ref={addLikedRef}
              type="button"
              aria-label="Add liked category"
              onClick={() => setAddingLiked(true)}
              disabled={disabled}
              className={cn(
                "inline-flex items-center justify-center h-11 w-11 rounded-md border border-dashed transition-colors",
                "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
                disabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <Plus className="h-[16px] w-[16px]" />
            </button>
          )}
        </div>
      </div>

      {/* Disliked categories */}
      <div className="space-y-2.5">
        <label id="disliked-label" className="text-sm font-medium">I don&apos;t want to see</label>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="disliked-label">
          {DISLIKED_CATEGORIES.map((cat) => (
            <CategoryChip
              key={cat}
              label={cat}
              selected={dislikedCategories.includes(cat)}
              variant="disliked"
              onClick={() => toggleCategory(cat, dislikedCategories, onDislikedChange)}
              disabled={disabled}
            />
          ))}
          {customDisliked.map((cat) => (
            <CategoryChip
              key={`custom-${cat}`}
              label={cat}
              selected={true}
              variant="disliked"
              onClick={() => toggleCategory(cat, dislikedCategories, onDislikedChange)}
              onRemove={() => onDislikedChange(dislikedCategories.filter((c) => c !== cat))}
              disabled={disabled}
            />
          ))}
          {poolDisliked.map((cat) => (
            <CategoryChip
              key={`pool-${cat}`}
              label={cat}
              selected={false}
              variant="disliked"
              onClick={() => toggleCategory(cat, dislikedCategories, onDislikedChange)}
              disabled={disabled}
            />
          ))}
          {addingDisliked ? (
            <AddCategoryInput
              variant="disliked"
              existingCategories={dislikedCategories}
              oppositeCategories={likedCategories}
              onChange={onDislikedChange}
              onCancel={cancelDisliked}
            />
          ) : (
            <button
              ref={addDislikedRef}
              type="button"
              aria-label="Add disliked category"
              onClick={() => setAddingDisliked(true)}
              disabled={disabled}
              className={cn(
                "inline-flex items-center justify-center h-11 w-11 rounded-md border border-dashed transition-colors",
                "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
                disabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <Plus className="h-[16px] w-[16px]" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
