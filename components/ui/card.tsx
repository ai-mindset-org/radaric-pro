"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
}

/**
 * `surface-card` carries the shape and the depth (app/globals.css). The corner
 * is a CSS mask rather than `corner-shape`, which is Chromium-only and
 * therefore rendered nothing on any iPhone; the elevation is a `drop-shadow`
 * filter rather than a box-shadow, because a mask clips outer shadows and
 * drop-shadow traces the rendered alpha instead.
 *
 * That costs the 1px ring `--shadow-card` used to lead with: drop-shadow has no
 * spread, and no hairline survives a mask (measured in WebKit — an inset ring
 * stops dead where the curve starts, a border-box gradient ring fades out
 * through it). Depth is blur in light and a lightness step in dark, which is
 * what the house rule asks for anyway: levels, not outlines, and no top-edge
 * highlight strip. The focus ring is inset for the same reason — an outer ring
 * would be cut off entirely.
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive = false, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        className={cn(
          "surface-card rounded-xl text-card-foreground",
          interactive && "surface-card-interactive cursor-pointer",
          className
        )}
        {...props}
      />
    )
  }
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-2 p-4", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "type-heading text-lg font-semibold leading-snug tracking-tight text-balance",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground leading-[1.7] text-pretty", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4 pt-3", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-4 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
