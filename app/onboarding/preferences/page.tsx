"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { PhaseIndicator } from "@/components/onboarding/phase-indicator"
import { ContentCategoryPicker } from "@/components/feeds/content-category-picker"
import { Loader2, ArrowLeft, ChevronDown } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { USER_PROMPT_MAX } from "@/lib/validations/prompt-limits"

const DEFAULT_DISLIKED = ["Ads", "Self-promotion", "Sponsored", "Clickbait"]

export default function PreferencesPage() {
  const router = useRouter()
  const [liked, setLiked] = useState<string[]>([])
  const [disliked, setDisliked] = useState<string[]>([...DEFAULT_DISLIKED])
  const [showPrompt, setShowPrompt] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [isSkipping, setIsSkipping] = useState(false)
  const [hasFeeds] = useState(() => {
    try {
      const raw = typeof window !== "undefined" ? sessionStorage.getItem("onboarding:feeds") : null
      const parsed = raw ? JSON.parse(raw) : null
      return Array.isArray(parsed) && parsed.length > 0
    } catch {
      return false
    }
  })

  const save = async () => {
    setIsSaving(true)
    try {
      const r = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalPrompt: prompt.trim() || null,
          globalLikedCategories: liked,
          globalDislikedCategories: disliked,
          onboardingCompleted: true,
        }),
      })
      if (!r.ok) {
        // Surface the server's reason (e.g. the prompt cap) — "Failed" is not actionable.
        const data = await r.json().catch(() => null)
        toast.error(data?.error ?? "Couldn't save your settings. Please try again.")
        setIsSaving(false)
        return
      }
      router.push("/posts")
    } catch {
      toast.error("Error")
      setIsSaving(false)
    }
  }

  const skip = async () => {
    if (isSaving || isSkipping) return
    setIsSkipping(true)
    try {
      const r = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalDislikedCategories: DEFAULT_DISLIKED,
          onboardingCompleted: true,
        }),
      })
      if (!r.ok) {
        toast.error("Couldn't save your settings. Please try again.")
        setIsSkipping(false)
        return
      }
      router.push("/posts")
    } catch {
      toast.error("Couldn't save your settings. Please try again.")
      setIsSkipping(false)
    }
  }

  return (
    <>
      <PhaseIndicator currentPhase="preferences" />
      <div className="mt-10 space-y-6">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 -ml-2 text-muted-foreground"
            onClick={() => router.push(hasFeeds ? "/onboarding/review" : "/onboarding/feeds")}
          >
            <ArrowLeft className="h-[16px] w-[16px] mr-1" />
            Back
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">What are you looking for?</h1>
          <p className="mt-2 text-base text-muted-foreground">
            Most feed readers make you set up filters later. Let&apos;s do it now so your first results are already filtered.
          </p>
        </div>

        <div className="rounded-xl bg-card p-4">
          <ContentCategoryPicker
            likedCategories={liked}
            dislikedCategories={disliked}
            onLikedChange={setLiked}
            onDislikedChange={setDisliked}
            disabled={isSaving || isSkipping}
          />
        </div>

        <button
          onClick={() => setShowPrompt(!showPrompt)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px]"
        >
          <ChevronDown className={cn("h-[14px] w-[14px] transition-transform duration-[var(--dur-base)] ease-[var(--ease-snap)]", showPrompt && "rotate-180")} />
          Advanced: describe your interests in your own words
        </button>
        {showPrompt && (
          <div className="rounded-xl bg-card p-4 motion-safe:animate-fade-in-up">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={USER_PROMPT_MAX}
              rows={5}
              className="w-full rounded-sm bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 resize-none placeholder:text-muted-foreground"
              placeholder='e.g., "Product design case studies, UX research, design system updates"'
            />
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" onClick={skip} disabled={isSaving || isSkipping}>
            Skip for now &#x2192;
          </Button>
          <Button onClick={save} disabled={isSaving || isSkipping}>
            {isSaving ? (
              <>
                <Loader2 className="h-[16px] w-[16px] mr-2 motion-safe:animate-spin" />
                Setting up...
              </>
            ) : (
              "Start Radaric"
            )}
          </Button>
        </div>
      </div>
    </>
  )
}
