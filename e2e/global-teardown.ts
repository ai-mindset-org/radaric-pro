/**
 * Playwright global teardown — clean up test users after all tests complete.
 * Silently skips if DB is unreachable or schema doesn't match.
 */

import { PrismaClient } from "@prisma/client"

export default async function globalTeardown() {
  const prisma = new PrismaClient()
  try {
    const deleted = await prisma.user.deleteMany({
      where: { email: { startsWith: "e2e-" } },
    })
    if (deleted.count > 0) {
      console.log(`[E2E teardown] Cleaned ${deleted.count} test user(s)`)
    }
  } catch {
    // DB may not be reachable or schema may not match — skip silently
  } finally {
    await prisma.$disconnect()
  }
}
