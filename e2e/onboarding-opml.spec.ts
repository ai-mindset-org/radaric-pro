/**
 * E2E: OPML file upload onboarding
 * Signup → Upload .opml file → Review shows RSS feeds
 *
 * Primary migration use case for users coming from Feedly/Inoreader.
 *
 * RAD-178
 */

import { test, expect } from "./fixtures/auth"
import path from "path"

const OPML_FEEDS = [
  { url: "https://alistapart.com/main/feed/", name: "A List Apart", type: "RSS", status: "found" },
  { url: "https://www.smashingmagazine.com/feed/", name: "Smashing Magazine", type: "RSS", status: "found" },
  { url: "https://news.ycombinator.com/rss", name: "Hacker News", type: "RSS", status: "found" },
  { url: "https://techcrunch.com/feed/", name: "TechCrunch", type: "RSS", status: "found" },
  { url: "https://www.theverge.com/rss/index.xml", name: "The Verge", type: "RSS", status: "found" },
]

function buildMockSSE(): string {
  const lines = OPML_FEEDS.map(
    (f) => `data: ${JSON.stringify({ type: "feed", feed: f })}`
  )
  lines.push(`data: ${JSON.stringify({ type: "complete", feeds: OPML_FEEDS })}`)
  return lines.join("\n\n") + "\n\n"
}

test.describe("Onboarding OPML import", () => {
  test("upload .opml file → review shows 5 RSS feeds", async ({ authedPage }) => {
    const page = authedPage

    // Mock SSE for parse-feeds (returns OPML feeds)
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

    // --- Step 2: Upload OPML file ---
    const fileInput = page.locator('input[type="file"]')
    const opmlPath = path.resolve(__dirname, "fixtures/test-feeds.opml")
    await fileInput.setInputFiles(opmlPath)

    // Verify file name appears
    await expect(page.getByText("test-feeds.opml")).toBeVisible()

    // Submit
    await page.getByRole("button", { name: "Find feeds" }).click()

    // --- Step 3: Wait for navigation to review ---
    await page.waitForURL("**/onboarding/review", { timeout: 15_000 })

    // --- Step 4: Verify all 5 feeds shown ---
    await expect(page.locator("h1")).toHaveText("Your feeds")
    await expect(page.getByText("5 feeds found")).toBeVisible()

    // All should be RSS type
    await expect(page.getByText("RSS").first()).toBeVisible()
  })
})
