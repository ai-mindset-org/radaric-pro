import * as React from "react"

import { cn } from "@/lib/utils"

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Outer sizing (`flex-1`, margins, grid placement) — lands on the frame. */
  wrapperClassName?: string
}

/** Same frame as `Input`, for the same reason — see the note in input.tsx. */
const FRAME =
  "relative flex w-full overflow-hidden rounded-sm bg-secondary ring-1 ring-inset ring-hairline transition-[background-color,box-shadow] hover:bg-accent/60 focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, wrapperClassName, ...props }, ref) => {
    return (
      <span data-slot="field" className={cn(FRAME, wrapperClassName)}>
        <textarea
          className={cn(
            "flex min-h-[80px] w-full resize-y bg-transparent px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed",
            className
          )}
          ref={ref}
          {...props}
        />
      </span>
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
