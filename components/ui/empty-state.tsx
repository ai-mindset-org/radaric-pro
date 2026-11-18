"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
  count?: number
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  count,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl p-12 surface-card",
        className
      )}
      {...props}
    >
      <div className="relative">
        <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-primary-subtle text-primary-subtle-foreground">
          {icon}
        </div>
        {count !== undefined && (
          <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-green-bright shadow-sm">
            <span data-numeric className="text-xs font-bold text-white">
              {count}
            </span>
          </div>
        )}
      </div>
      <h3 className="mt-6 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground text-pretty">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
