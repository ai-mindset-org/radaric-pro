/**
 * Local DB fixture for E2E specs (RAD-393).
 *
 * Playwright runs against the development database from `.env` — the same
 * one the dev server uses. `@next/env` loads that file the same way Next does,
 * so the PrismaClient here and the app talk to the same place.
 *
 * Everything is user-scoped: seed under the freshly signup'd test user, and
 * `deleteUser` cascades feeds/materials/folders. Never point this at prod.
 */

import { loadEnvConfig } from "@next/env"
import { PrismaClient } from "@prisma/client"

let prisma: PrismaClient | null = null

export function testDb(): PrismaClient {
  if (!prisma) {
    loadEnvConfig(process.cwd())
    prisma = new PrismaClient()
  }
  return prisma
}

export async function findUserIdByEmail(email: string): Promise<string> {
  const user = await testDb().user.findUnique({ where: { email }, select: { id: true } })
  if (!user) throw new Error(`E2E user not found for ${email}`)
  return user.id
}

/**
 * Dashboard specs need a paid/comped account: a fresh credential signup is
 * unsubscribed and the onboarding demo no longer applies once the onboarding
 * gate auto-completes. An operator script grants the same field — one hour is
 * plenty for a test.
 */
export async function grantTestAccess(userId: string): Promise<void> {
  await testDb().user.update({
    where: { id: userId },
    data: { complimentaryAccessUntil: new Date(Date.now() + 60 * 60 * 1000) },
  })
}

export async function seedFeed(params: {
  userId: string
  name: string
  url: string
}): Promise<{ feedId: string; materialId: string; materialTitle: string }> {
  const db = testDb()
  const feed = await db.feed.create({
    data: {
      userId: params.userId,
      type: "RSS",
      url: params.url,
      name: params.name,
      // Explicit: the folder scope predicate requires visible + active members.
      isActive: true,
      hidden: false,
    },
    select: { id: true },
  })

  const materialTitle = `${params.name} marker post`
  const material = await db.material.create({
    data: {
      sourceId: feed.id,
      title: materialTitle,
      url: `${params.url}#post`,
      content: `Seeded body for ${params.name}`,
      publishedAt: new Date(),
      aiEvaluation: "APPROVED",
      aiConfidence: 90,
      userStatus: "NEW",
    },
    select: { id: true },
  })

  return { feedId: feed.id, materialId: material.id, materialTitle }
}

export async function deleteUser(userId: string): Promise<void> {
  await testDb()
    .user.delete({ where: { id: userId } })
    .catch(() => {
      // Best-effort cleanup; the dev DB tolerates leftovers.
    })
}

export async function disconnectTestDb(): Promise<void> {
  await prisma?.$disconnect()
  prisma = null
}
