/**
 * The automatic first parse (RAD-318 Phase 5).
 *
 * This is the one run the client must not own. `POST /api/parse` awaits the
 * whole pipeline server-side (`app/api/parse/route.ts:18`), so a new user who
 * clicks the sidebar five seconds in keeps their ingestion. The processing card
 * *observes* that run; it never drives it, and unmounting the observer does not
 * abort anything.
 *
 * The dangerous part was never the transport, it was the bookkeeping: the
 * banner-dismissal flag used to be written at kickoff, in parallel with the
 * request and before any result existed. A run killed mid-flight therefore left
 * a user permanently ineligible for the retry — an empty Posts screen with no
 * way back. It is now written only when the server has actually answered.
 */

import { toast } from "sonner"

const POLL_DELAY_MS = 15_000
const POLL_INTERVAL_MS = 10_000
const MAX_POLL_ATTEMPTS = 30

export const STILL_PROCESSING_MESSAGE =
  "Your feeds are still being processed. Check back in a few minutes."

/**
 * Mark onboarding complete. Called only on a terminal outcome — never at
 * kickoff, so a run lost to navigation still offers the retry next visit.
 */
export async function dismissOnboardingBanner(): Promise<void> {
  try {
    await fetch("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingBannerDismissed: true }),
    })
  } catch {
    // A failed write costs one redundant banner, never a lost run.
  }
}

/**
 * Poll `/api/stats` until posts appear, then say so. When they never do, say
 * *that* — the silent case is what BUG-12 was about.
 */
export async function reportFirstResults(
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  signal?: AbortSignal
): Promise<void> {
  await sleep(POLL_DELAY_MS)
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    // Up to 5m15s of polling that ends in a toast. Tied to nothing, it would
    // outlive the screen that started it and surface "still being processed"
    // on some unrelated page the user navigated to minutes ago.
    if (signal?.aborted) return
    try {
      const response = await fetch("/api/stats")
      if (response.ok) {
        const stats = await response.json()
        const total = stats.materials?.total ?? 0
        const approved = stats.materials?.approved ?? 0
        if (total > 0) {
          toast.success(`First results: ${total} posts found, ${approved} matched your interests.`, {
            duration: 6000,
          })
          return
        }
      }
    } catch {
      // Keep polling: a single failed stats read is not a verdict.
    }
    if (attempt < MAX_POLL_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS)
  }
  toast.info(STILL_PROCESSING_MESSAGE)
}

/**
 * Start the first parse and resolve when the server has finished it.
 *
 * Resolving means the server answered *yes*: the run happened and onboarding is
 * dismissed. A rejection — a network failure, the tab navigating away, or a
 * non-OK status — says the run did not happen, and eligibility is deliberately
 * left intact so the next visit offers the retry.
 *
 * The non-OK case matters as much as the network one: a 402 from the paywall, a
 * 401, or a 500 are all answers, and treating "the server answered" as success
 * would spend the one-shot retry on a run that never ran and report an empty
 * success on a screen with no posts — the same bug as writing the flag at
 * kickoff, moved from "too early" to "on failure".
 */
export async function startFirstParse(feedCount: number): Promise<void> {
  toast.success(
    `Parsing ${feedCount} feeds now — your first filtered results will appear in about a minute.`,
    { duration: 8000 }
  )

  let response: Response
  try {
    response = await fetch("/api/parse", { method: "POST" })
  } catch {
    toast.info(STILL_PROCESSING_MESSAGE)
    throw new Error(STILL_PROCESSING_MESSAGE)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error ?? "Could not start collecting your posts")
  }

  await dismissOnboardingBanner()
  void reportFirstResults()
}
