import * as React from "react"

import { cn } from "@/lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** Outer sizing (`flex-1`, grid placement) — lands on the frame, not the input.
   *  Unframed types (range, checkbox, …) have no frame, so it joins `className`. */
  wrapperClassName?: string
}

/**
 * The frame carries the shape and the paint; the native input inside is
 * transparent. WebKit renders no `corner-shape`, so on every iPhone the
 * superellipse is a mask, and a mask cuts a box-shadow hairline off at the
 * corners. The ring that survives is painted on a masked pseudo-element, which
 * a native `<input>` cannot have — hence the frame. `className`, the ref and
 * every attribute still reach the input; see `__tests__/components/input-frame.test.tsx`.
 *
 * The ring is the frame's inset box-shadow in Chromium, painted beneath the
 * input — and Chromium's autofill background is opaque and `!important`, so an
 * autofilled field would hide it. The `autofill:` transition keeps it transparent.
 */
const FRAME =
  "relative flex w-full overflow-hidden rounded-sm bg-secondary ring-1 ring-inset ring-hairline transition-[background-color,box-shadow] hover:bg-accent/60 focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[[aria-invalid=true]]:animate-shake has-[[aria-invalid=true]]:ring-2 has-[[aria-invalid=true]]:ring-destructive"

/** Controls with a native widget of their own, or no box at all, are not fields and get no frame. */
const UNFRAMED = new Set(["range", "checkbox", "radio", "hidden", "file", "color"])

const RANGE =
  "flex h-10 w-full rounded-sm bg-secondary px-3 py-2 ring-1 ring-inset ring-hairline disabled:cursor-not-allowed disabled:opacity-50"

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, wrapperClassName, type, ...props }, ref) => {
    if (type && UNFRAMED.has(type)) {
      return (
        <input type={type} className={cn(type === "range" && RANGE, wrapperClassName, className)} ref={ref} {...props} />
      )
    }
    return (
      <span data-slot="field" className={cn(FRAME, wrapperClassName)}>
        <input
          type={type}
          className={cn(
            "flex h-10 w-full min-w-0 bg-transparent px-3 py-2 text-sm autofill:[transition:background-color_600000s_0s] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed",
            className
          )}
          ref={ref}
          {...props}
        />
      </span>
    )
  }
)
Input.displayName = "Input"

export { Input }
