"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function MobileStickyCta() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const handleScroll = () => setVisible(window.scrollY > 600)
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-lg p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_16px_-4px_rgba(26,33,30,0.12)] md:hidden transition-transform duration-200 motion-reduce:transition-none",
        visible ? "translate-y-0" : "translate-y-full"
      )}
    >
      <Button className="w-full h-11" asChild>
        <Link href="/signup">Get Started</Link>
      </Button>
    </div>
  )
}
