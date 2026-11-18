import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-[background-color,box-shadow,transform,color] duration-150 ease-[var(--ease-out-quart)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/55 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Solid green — the primary action. Brand, front and centre.
        // Depth comes from the fill and a soft drop shadow, never a top strip.
        default:
          "bg-primary text-primary-foreground shadow-[0_1px_2px_0_#0000001f] hover:bg-primary-hover active:bg-primary-active",
        // Tonal green — secondary green actions (the old soft default).
        tonal:
          "bg-primary-subtle text-primary-subtle-foreground hover:bg-primary-subtle/70",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent",
        outline:
          "bg-transparent text-foreground shadow-2xs ring-1 ring-inset ring-border hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "link transition-[color,text-decoration-color] duration-[var(--dur-fast)] ease-[var(--ease-snap)]",
        // Inline destructive (list rows, detail pages).
        destructive: "text-destructive hover:bg-destructive-subtle",
        // Solid destructive — confirmation dialogs only.
        "destructive-solid":
          "bg-destructive text-destructive-foreground shadow-[0_1px_2px_0_#0000001f] hover:bg-destructive/90 active:bg-destructive/95",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 rounded-md px-8 text-[0.9375rem]",
        icon: "h-11 w-11 rounded-md",
        "icon-sm": "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot
          data-slot="button"
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          {...props}
        >
          {children}
        </Slot>
      )
    }
    return (
      <button
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="h-[16px] w-[16px] animate-spin" aria-hidden="true" />}
        {children}
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
