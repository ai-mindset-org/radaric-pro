"use client"

import { Toaster as Sonner } from "sonner"

export function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        className:
          "!bg-card !text-card-foreground !border-transparent !shadow-none !rounded-xl",
        descriptionClassName: "!text-muted-foreground",
      }}
    />
  )
}
