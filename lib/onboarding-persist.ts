import { toast } from "sonner"
import type { ExtractedFeed } from "@/lib/onboarding-types"

const PERSIST_BODY = (feeds: ExtractedFeed[]) =>
  JSON.stringify({
    onboardingState: { version: 1, step: "review", extractedFeeds: feeds },
  })

async function attemptPersist(feeds: ExtractedFeed[], signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: PERSIST_BODY(feeds),
      ...(signal ? { signal } : {}),
    })
    return response.ok
  } catch (e) {
    console.warn("[onboarding-persist] attempt failed:", e)
    return false
  }
}

export async function persistFeeds(feeds: ExtractedFeed[]): Promise<void> {
  // First attempt (no timeout signal)
  const firstSuccess = await attemptPersist(feeds)
  if (firstSuccess) return

  // Retry with a 3-second AbortController timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 3000)
  try {
    const retrySuccess = await attemptPersist(feeds, controller.signal)
    if (retrySuccess) return
  } finally {
    clearTimeout(timeoutId)
  }

  // Both attempts failed — show reassuring toast, never throw
  toast.warning(
    "Couldn't save your progress to the server. Your feeds are still here — we'll try saving again shortly."
  )
}
