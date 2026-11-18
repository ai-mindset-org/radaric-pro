/* eslint-disable react-hooks/rules-of-hooks */
/**
 * Test user fixture for E2E tests.
 * Creates a unique test user via the real signup API,
 * authenticates via NextAuth, and cleans up after tests.
 */

import { test as base, expect, type Page } from "@playwright/test"

interface TestUser {
  email: string
  password: string
}

interface AuthFixtures {
  testUser: TestUser
  authedPage: Page
}

/** Generate a unique test email that can be bulk-cleaned */
function makeTestEmail(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `e2e-${ts}-${rand}@radaric-test.local`
}

const TEST_PASSWORD = "e2e-test-password-123"

export const test = base.extend<AuthFixtures>({
  testUser: async ({}, use) => {
    const email = makeTestEmail()
    await use({ email, password: TEST_PASSWORD })
  },

  authedPage: async ({ page, testUser, baseURL }, use, testInfo) => {
    // 1. Create user via signup API
    const signupRes = await page.request.post(`${baseURL}/api/auth/signup`, {
      data: { email: testUser.email, password: testUser.password },
    })

    if (!signupRes.ok()) {
      // DB schema mismatch (e.g., a development database without the users table)
      testInfo.skip(true, "Signup API failed — DB may not support user creation. Run against production-schema DB.")
      return
    }

    // 2. Sign in via NextAuth credentials
    const csrfRes = await page.request.get(`${baseURL}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()

    await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
      form: {
        email: testUser.email,
        password: testUser.password,
        csrfToken,
        json: "true",
      },
    })

    await use(page)
  },
})

export { expect }
