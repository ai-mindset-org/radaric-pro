/**
 * server-only — offer onboarding again on a new visit while the account has
 * zero sources (RAD-168).
 *
 * The proxy marks the first request of a visit (lib/visit-marker.ts); only then
 * are feeds counted. Hidden feeds (self-filling collections' monitors) are not
 * sources the user added; paused ones are. Never writes settings:
 * `onboardingCompleted` stays a one-way latch (lib/entitlements.ts).
 */
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { NEW_VISIT_HEADER } from "@/lib/visit-marker"

export async function redirectToOnboardingOnNewVisit(userId: string): Promise<void> {
  if ((await headers()).get(NEW_VISIT_HEADER) !== "1") return
  const feedCount = await db.feed.count({ where: { userId, hidden: false } })
  // `revisit=1` only picks the welcome-back copy; where skip and save go is
  // decided from onboardingCompleted (app/onboarding/feeds/page.tsx).
  if (feedCount === 0) redirect("/onboarding/feeds?revisit=1")
}
