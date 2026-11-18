import type { Metadata } from "next"
import { db } from "@/lib/db"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { RulesPage } from "@/components/rules/rules-page"

export const metadata: Metadata = { title: "Rules" }
export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function Rules() {
  const { userId } = await requirePaidDashboardAccess()

  let userSettings = await db.userSettings.findUnique({
    where: { userId },
  })

  if (!userSettings) {
    userSettings = await db.userSettings.create({
      data: { userId },
    })
  }

  const blacklist = await db.blacklistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  })

  const feedback = await db.aIFeedback.findMany({
    where: { userId },
    include: {
      feed: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })

  return (
    <RulesPage
      globalPrompt={userSettings.globalPrompt ?? ""}
      blacklist={blacklist}
      feedback={feedback}
    />
  )
}
