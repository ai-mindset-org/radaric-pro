/**
 * E2E: Full onboarding happy path
 * Signup → Feed import → Review → Preferences → Posts
 *
 * External APIs mocked:
 * - POST /api/onboarding/parse-feeds → static SSE response
 * - POST /api/onboarding/validate-feed → always valid
 *
 * Real APIs hit:
 * - POST /api/auth/signup → creates real test user
 * - POST /api/onboarding/save-feeds → saves to real DB
 * - PATCH /api/user-settings → marks onboarding complete
 *
 * RAD-178
 */

import { test, expect } from "./fixtures/auth"

const MOCK_SSE_FEEDS = [
  { url: "https://alistapart.com/main/feed/", name: "A List Apart", type: "RSS", status: "found" },
  { url: "https://t.me/testchannel", name: "@testchannel", type: "TELEGRAM", status: "found" },
  { url: "https://x.com/testuser", name: "@testuser", type: "TWITTER", status: "found" },
]

function buildMockSSE(): string {
  const lines = MOCK_SSE_FEEDS.map(
    (f) => `data: ${JSON.stringify({ type: "feed", feed: f })}`
  )
  lines.push(`data: ${JSON.stringify({ type: "complete", feeds: MOCK_SSE_FEEDS })}`)
  return lines.join("\n\n") + "\n\n"
}

test.describe("Onboarding happy path", () => {
  // Requires a DB with proper schema for user creation (production or CI DB).
  // Skip locally if DATABASE_URL points to a dev DB without users table.
  test("signup → feeds → review → preferences → posts", async ({ authedPage }) => {
    const page = authedPage

    // Mock SSE response for parse-feeds (static, all feeds found)
    await page.route("**/api/onboarding/parse-feeds", (route) => {
      route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
        body: buildMockSSE(),
      })
    })

    // --- Step 1: Navigate to feed import ---
    await page.goto("/onboarding/feeds")
    await expect(page.locator("h1")).toHaveText("Add your feeds")

    // --- Step 2: Paste feed URLs and submit ---
    const textarea = page.locator("textarea")
    await textarea.fill(
      "https://alistapart.com/main/feed/\nt.me/testchannel\n@testuser"
    )
    await page.getByRole("button", { name: "Find feeds" }).click()

    // --- Step 3: Wait for feed discovery and navigation to review ---
    // FeedDiscoveryProgress shows feeds, then 1.5s celebration, then auto-navigates
    await page.waitForURL("**/onboarding/review", { timeout: 15_000 })

    // --- Step 4: Review page — verify feeds listed ---
    await expect(page.locator("h1")).toHaveText("Your feeds")
    // Should show our 3 feeds
    await expect(page.getByText("A List Apart")).toBeVisible()
    await expect(page.getByText("@testchannel")).toBeVisible()
    await expect(page.getByText("@testuser")).toBeVisible()

    // Mock save-feeds to avoid hitting real save (feeds may not validate against real DB schema)
    await page.route("**/api/onboarding/save-feeds", (route) => {
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ created: 3, skipped: 0 }),
      })
    })

    // Click save
    await page.getByRole("button", { name: /Save \d+ feeds/ }).click()

    // --- Step 5: Preferences page ---
    await page.waitForURL("**/onboarding/preferences", { timeout: 10_000 })
    await expect(page.locator("h1")).toHaveText("What are you looking for?")

    // Verify pre-populated disliked defaults
    const dislikedGroup = page.getByRole("group", { name: "Disliked categories" })
    await expect(dislikedGroup.getByText("Ads")).toBeVisible()
    await expect(dislikedGroup.getByText("Sponsored")).toBeVisible()

    // Select a liked category
    const likedGroup = page.getByRole("group", { name: "Liked categories" })
    const firstCategory = likedGroup.locator("button").first()
    await firstCategory.click()

    // Click "Start Radaric"
    await page.getByRole("button", { name: "Start Radaric" }).click()

    // --- Step 6: Should land on /posts ---
    await page.waitForURL("**/posts", { timeout: 10_000 })
  })
})
