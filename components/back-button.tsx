"use client"

import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

// Returns to the page the user actually came from (per-source view, filtered
// list, …); falls back to `fallback` when the detail page is the first entry
// in the tab's history (deep link, new tab).
export function BackButton({ fallback = "/posts" }: { fallback?: string }) {
  const router = useRouter()

  function handleBack() {
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push(fallback)
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleBack} className="-ml-2">
      <ArrowLeft className="h-[16px] w-[16px] mr-2" />
      Back
    </Button>
  )
}
