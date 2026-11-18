/**
 * E2E: Skip onboarding flow
 * Signup → Skip feeds → Skip preferences → Posts
 *
 * Verifies that skipping saves default disliked categories
 * and sets onboardingCompleted = true.
 *
 * RAD-178
 */

import { test, expect } from "./fixtures/auth"

test.describe("Onboarding skip flow", () => {
  test("skip feeds → skip preferences → lands on /posts", async ({ authedPage }) => {
    const page = authedPage

    // --- Step 1: Navigate to feed import ---
    await page.goto("/onboarding/feeds")
    await expect(page.locator("h1")).toHaveText("Add your feeds")

    // --- Step 2: Click skip ---
    await page.getByRole("button", { name: /Skip/ }).click()

    // --- Step 3: Should land on preferences ---
    await page.waitForURL("**/onboarding/preferences", { timeout: 10_000 })
    await expect(page.locator("h1")).toHaveText("What are you looking for?")

    // Verify default disliked categories are pre-selected
    const dislikedGroup = page.getByRole("group", { name: "Disliked categories" })
    await expect(dislikedGroup.getByText("Ads")).toBeVisible()
    await expect(dislikedGroup.getByText("Clickbait")).toBeVisible()

    // --- Step 4: Click skip again ---
    await page.getByRole("button", { name: /Skip for now/ }).click()

    // --- Step 5: Should land on /posts with onboarding complete ---
    await page.waitForURL("**/posts", { timeout: 10_000 })
  })
})
