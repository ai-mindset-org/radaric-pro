import type { Metadata } from "next"
import { redirect, notFound } from "next/navigation"
import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { requireOnboarded } from "@/lib/materials/fetch-materials-page"
import { MaterialDetailPage } from "@/components/materials/material-detail-page"

export const dynamic = "force-dynamic"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const material = await db.material.findUnique({
    where: { id },
    select: { title: true },
  })
  return { title: material?.title || "Post" }
}

export default async function MaterialPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }

  const userSettings = await requireOnboarded(session.user.id)
  const hasNotionIntegration = !!(
    userSettings.notionToken && userSettings.notionDatabaseId
  )

  const { id } = await params

  const material = await db.material.findUnique({
    where: { id },
    include: {
      feed: {
        select: {
          id: true,
          name: true,
          type: true,
          userId: true,
        },
      },
      feedbacks: {
        where: { userId: session.user.id },
        select: { feedbackType: true },
        take: 1,
      },
      savedItems: {
        where: { userId: session.user.id },
        select: { id: true },
        take: 1,
      },
    },
  })

  if (!material || material.feed.userId !== session.user.id) {
    notFound()
  }

  return (
    <MaterialDetailPage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape matches the component's material prop
      material={material as any}
      hasNotionIntegration={hasNotionIntegration}
      initialSaved={((material as { savedItems?: unknown[] }).savedItems?.length ?? 0) > 0}
    />
  )
}
