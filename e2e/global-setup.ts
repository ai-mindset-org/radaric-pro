/**
 * Playwright global setup — clean up stale test users before running tests.
 * Deletes ALL users with e2e- email prefix to prevent accumulation.
 * Silently skips if the database is unreachable or its schema does not match.
 */

import { PrismaClient } from "@prisma/client"

export default async function globalSetup() {
  const prisma = new PrismaClient()
  try {
    const deleted = await prisma.user.deleteMany({
      where: { email: { startsWith: "e2e-" } },
    })
    if (deleted.count > 0) {
      console.log(`[E2E setup] Cleaned ${deleted.count} stale test user(s)`)
    }
  } catch {
    // DB may not be reachable or schema may not match — skip silently
  } finally {
    await prisma.$disconnect()
  }
}
