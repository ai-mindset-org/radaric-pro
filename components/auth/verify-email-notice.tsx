import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { VerifyEmailBanner } from "@/components/auth/verify-email-banner"

/**
 * Server-rendered verification banner host (RAD-297): shown in the dashboard
 * shell until the account's email is verified. Returns null for verified users
 * and for unauthenticated visitors (per-page auth handles those).
 */
export async function VerifyEmailNotice() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId || session?.user?.role === "ADMIN") return null

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  })
  if (!user || user.emailVerified) return null

  return <VerifyEmailBanner />
}
