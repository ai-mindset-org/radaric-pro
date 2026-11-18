import type { Metadata } from "next"
import { redirect, notFound } from "next/navigation"
import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { StoryDetail } from "@/components/stories/story-detail"

export const metadata: Metadata = { title: "Story" }
export const dynamic = "force-dynamic"

export default async function StoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }

  const { id } = await params

  const story = await db.story.findUnique({
    where: { id },
    include: {
      materials: {
        select: {
          id: true,
          title: true,
          url: true,
          content: true,
          contentEntities: true,
          publishedAt: true,
          thumbnailUrl: true,
          mediaUrls: true,
          aiEvaluation: true,
          aiConfidence: true,
          aiReasoning: true,
          userStatus: true,
          createdAt: true,
          feed: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          feedbacks: {
            select: { feedbackType: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { createdAt: "desc" },
      },
      inboxItems: {
        select: {
          id: true,
          externalId: true,
          messageId: true,
          rawText: true,
          extractedUrl: true,
          extractedTitle: true,
          mediaUrls: true,
          thumbnailUrl: true,
          sourceChannel: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  })

  if (!story || story.userId !== session.user.id) {
    notFound()
  }

  const userSettings = await db.userSettings.findUnique({
    where: { userId: session.user.id },
    select: { notionToken: true, storyNotionDatabaseId: true },
  })
  const hasNotionIntegration = !!(userSettings?.notionToken && userSettings?.storyNotionDatabaseId)

  return <StoryDetail story={story as any} hasNotionIntegration={hasNotionIntegration} />
}
