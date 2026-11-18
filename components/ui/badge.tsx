import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "type-tag inline-flex items-center gap-1 rounded-xs font-medium transition-colors duration-150 focus:outline-none",
  {
    variants: {
      variant: {
        // Tonal green — the default. Uses the subtle token so text always hits AA.
        default: "bg-primary-subtle text-primary-subtle-foreground",
        success: "bg-success-subtle text-primary-subtle-foreground",
        // Solid green — for the rare high-emphasis status.
        solid: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive-subtle text-destructive",
        info: "bg-info-subtle text-info",
        warning: "bg-warning-subtle text-warning",
        outline: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
        subtle: "bg-muted text-muted-foreground",
      },
      size: {
        default: "px-2.5 py-1 text-xs",
        sm: "px-2 py-0.5 text-xs",
        lg: "px-4 py-1.5 text-sm min-h-[44px] rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
