import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

// RAD-168: the preferences step starts from default categories, so a user who
// already finished onboarding would overwrite their filters here. The client
// routes a returning user past it when it knows; this guard covers the cases
// where it does not (settings fetch failed or timed out, back button, typed URL).
export default async function PreferencesLayout({ children }: { children: React.ReactNode }) {
  const userId = (await auth())?.user?.id
  if (userId) {
    const settings = await db.userSettings.findUnique({ where: { userId }, select: { onboardingCompleted: true } })
    if (settings?.onboardingCompleted) redirect("/posts")
  }
  return children
}
