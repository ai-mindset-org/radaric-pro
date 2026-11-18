/**
 * E2E: Onboarding bug fix regressions
 *
 * All API routes are mocked via page.route() — no real DB writes needed
 * beyond the auth fixture creating a test user.
 *
 * BUG-2:  Unresolved → Review data handoff (resolved feed visible on review page)
 * BUG-6:  Review page shows skeleton while loading
 * BUG-7:  Skip feeds → Preferences → Back lands on /onboarding/feeds
 * BUG-8:  Preferences skip with API error stays on page and shows error toast
 * RAD-216: Confirm button on custom category input adds tag and closes input
 */

import { test, expect } from "./fixtures/auth"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUnresolvedSSE(): string {
  const feeds = [
    { url: "https://smashingmagazine.com", name: "Smashing Magazine", type: "WEBSITE", status: "not_found" },
    { url: "https://css-tricks.com", name: "CSS-Tricks", type: "WEBSITE", status: "not_found" },
    { url: "https://dev.to", name: "DEV Community", type: "WEBSITE", status: "not_found" },
  ]
  const lines = feeds.map(
    (f) => `data: ${JSON.stringify({ type: "feed", feed: f })}`
  )
  lines.push(`data: ${JSON.stringify({ type: "complete", feeds })}`)
  return lines.join("\n\n") + "\n\n"
}

// ---------------------------------------------------------------------------
// BUG-2: Unresolved → Review data handoff
// ---------------------------------------------------------------------------

test.describe("BUG-2: Unresolved → Review data handoff", () => {
  test("resolved feed entered on /unresolved is visible on /review", async ({ authedPage }) => {
    const page = authedPage

    // Mock parse-feeds to return 3 unresolved WEBSITE feeds → triggers /unresolved redirect
    await page.route("**/api/onboarding/parse-feeds", (route) => {
      route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
        body: buildUnresolvedSSE(),
      })
    })

    // Mock validate-feed to return a valid RSS feed for the manual URL
    await page.route("**/api/onboarding/validate-feed", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          feed: {
            url: "https://smashingmagazine.com/feed/",
            name: "Smashing Magazine",
            type: "RSS",
            status: "found",
          },
        }),
      })
    })

    // Mock save-feeds to succeed
    await page.route("**/api/onboarding/save-feeds", (route) => {
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ created: 1, skipped: 0 }),
      })
    })

    // Mock user-settings PATCH to succeed
    await page.route("**/api/user-settings", (route) => {
      if (route.request().method() === "PATCH") {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        })
      } else {
        route.continue()
      }
    })

    // Step 1: Navigate to feeds and submit
    await page.goto("/onboarding/feeds")
    await expect(page.locator("h1")).toHaveText("Add your feeds")

    const textarea = page.locator("textarea")
    await textarea.fill("smashingmagazine.com\ncss-tricks.com\ndev.to")
    await page.getByRole("button", { name: "Find feeds" }).click()

    // Step 2: Auto-navigate to /unresolved (3+ unresolved WEBSITE feeds)
    await page.waitForURL("**/onboarding/unresolved", { timeout: 15_000 })

    // Step 3: Enter a manual RSS URL for the first unresolved feed
    const rssInput = page.locator("input[type='url'], input[placeholder*='https']").first()
    await rssInput.fill("https://smashingmagazine.com/feed/")
    await rssInput.blur()

    // Wait for validate-feed to respond (valid indicator should appear)
    await expect(page.locator("[data-valid='true'], .text-green-500, [aria-label*='valid']").first()).toBeVisible({
      timeout: 5_000,
    })

    // Step 4: Click Save & continue
    await page.getByRole("button", { name: /Save & continue|Continue/ }).click()

    // Step 5: Land on review page
    await page.waitForURL("**/onboarding/review", { timeout: 10_000 })
    await expect(page.locator("h1")).toHaveText("Your feeds")

    // Step 6: The manually resolved feed must be visible
    await expect(page.getByText("Smashing Magazine")).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// BUG-7: Skip feeds → Preferences → Back lands on /onboarding/feeds
// ---------------------------------------------------------------------------

test.describe("BUG-7: Back button from preferences after skip returns to feeds", () => {
  test("clicking Back on preferences after skipping feeds goes to /onboarding/feeds", async ({ authedPage }) => {
    const page = authedPage

    // Step 1: Go to feeds and skip
    await page.goto("/onboarding/feeds")
    await expect(page.locator("h1")).toHaveText("Add your feeds")
    await page.getByRole("button", { name: /Skip/ }).click()

    // Step 2: Land on preferences
    await page.waitForURL("**/onboarding/preferences", { timeout: 10_000 })
    await expect(page.locator("h1")).toHaveText("What are you looking for?")

    // Step 3: Click Back button
    await page.getByRole("button", { name: /Back/ }).click()

    // Step 4: Must land on /onboarding/feeds (not /onboarding/review)
    await page.waitForURL("**/onboarding/feeds", { timeout: 10_000 })
    await expect(page).toHaveURL(/\/onboarding\/feeds/)
    await expect(page).not.toHaveURL(/\/onboarding\/review/)
  })
})

// ---------------------------------------------------------------------------
// BUG-8: Preferences skip with API error stays on page + shows error toast
// ---------------------------------------------------------------------------

test.describe("BUG-8: Preferences skip with API error stays on page", () => {
  test("500 from user-settings PATCH keeps user on preferences and shows error toast", async ({ authedPage }) => {
    const page = authedPage

    // Mock user-settings PATCH to return 500
    await page.route("**/api/user-settings", (route) => {
      if (route.request().method() === "PATCH") {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal server error" }),
        })
      } else {
        route.continue()
      }
    })

    // Navigate directly to preferences
    await page.goto("/onboarding/preferences")
    await expect(page.locator("h1")).toHaveText("What are you looking for?")

    // Click "Skip for now"
    await page.getByRole("button", { name: /Skip for now/ }).click()

    // Must stay on preferences
    await expect(page).toHaveURL(/\/onboarding\/preferences/, { timeout: 5_000 })

    // Must show an error toast
    const errorToast = page.locator("[role='alert'], [data-sonner-toast], [data-radix-toast-viewport] li").first()
    await expect(errorToast).toBeVisible({ timeout: 5_000 })
  })
})

// ---------------------------------------------------------------------------
// RAD-216: Confirm button on custom category input adds tag and closes input
// ---------------------------------------------------------------------------

test.describe("RAD-216: custom category ✓ button commits the typed value", () => {
  test("typing a value and clicking the confirm button adds the chip and closes the input", async ({ authedPage }) => {
    const page = authedPage

    await page.route("**/api/user-settings", (route) => {
      if (route.request().method() === "PATCH") {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        })
      } else {
        route.continue()
      }
    })

    await page.goto("/onboarding/preferences")
    await expect(page.locator("h1")).toHaveText("What are you looking for?")

    // Open the "I want to see" custom input
    await page.getByRole("button", { name: "Add liked category" }).click()

    const input = page.getByRole("textbox", { name: /custom category/i })
    await expect(input).toBeVisible()
    await input.fill("Tournaments")

    // Click the ✓ confirm button — this is the exact path that was broken on
    // the inline implementation: pressing Enter worked, clicking did not.
    await page.getByRole("button", { name: "Confirm" }).click()

    // The input must close (no more textbox) and the new chip must appear.
    await expect(page.getByRole("textbox", { name: /custom category/i })).toHaveCount(0)

    const likedGroup = page.getByRole("group", { name: /i want to see/i })
    await expect(likedGroup.getByRole("button", { name: "Tournaments", exact: true })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// BUG-6: Review page shows skeleton while loading
// ---------------------------------------------------------------------------

test.describe("BUG-6: Review page skeleton loading state", () => {
  test("skeleton elements visible during slow user-settings GET, feeds appear after response", async ({ authedPage }) => {
    const page = authedPage

    let resolveDelay: () => void
    const delayPromise = new Promise<void>((resolve) => {
      resolveDelay = resolve
    })

    const mockFeeds = [
      { url: "https://alistapart.com/main/feed/", name: "A List Apart", type: "RSS", status: "found" },
      { url: "https://t.me/testchannel", name: "@testchannel", type: "TELEGRAM", status: "found" },
    ]

    // Mock user-settings GET to delay 2 seconds before returning feeds
    await page.route("**/api/user-settings*", async (route) => {
      if (route.request().method() === "GET") {
        await delayPromise
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            onboardingState: {
              version: 1,
              step: "review",
              feeds: mockFeeds,
            },
          }),
        })
      } else {
        route.continue()
      }
    })

    // Also populate sessionStorage with feeds so the review page has data to render
    await page.goto("/onboarding/review")

    // Skeleton elements (animate-pulse) must be visible before the delay resolves
    await expect(page.locator(".animate-pulse").first()).toBeVisible({ timeout: 5_000 })

    // Release the delay
    resolveDelay!()

    // Feeds must appear after the response
    await expect(page.getByText("A List Apart")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("@testchannel")).toBeVisible({ timeout: 10_000 })
  })
})
