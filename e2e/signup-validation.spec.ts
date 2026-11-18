/**
 * E2E: Signup page validation and auth routing
 *
 * Tests form validation, error display, and redirect behavior
 * for protected routes.
 *
 * RAD-178
 */

import { test, expect } from "@playwright/test"

test.describe("Signup validation", () => {
  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/signup")

    // Fill in a non-existent user
    await page.locator("#email").fill("nonexistent-e2e@test.local")
    await page.locator("#password").fill("wrongpassword123")
    await page.getByRole("button", { name: "Continue", exact: true }).click()

    // Should show error (either from signup API or signIn)
    await expect(page.locator(".text-destructive")).toBeVisible({ timeout: 10_000 })
  })

  test("protected route /posts redirects to /signup when not authenticated", async ({ page }) => {
    await page.goto("/posts")
    // Middleware should redirect to /signup
    await page.waitForURL("**/signup", { timeout: 10_000 })
  })

  test("protected route /feeds redirects to /signup when not authenticated", async ({ page }) => {
    await page.goto("/feeds")
    await page.waitForURL("**/signup", { timeout: 10_000 })
  })

  test("signup page offers only the configured OAuth buttons (RAD-293)", async ({ page }) => {
    await page.goto("/signup")
    // Providers are server-resolved from env; assert presence only for those configured.
    if (process.env.GOOGLE_CLIENT_ID) {
      await expect(page.getByRole("button", { name: /Google/ })).toBeVisible()
    } else {
      await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0)
    }
    if (process.env.APPLE_ID) {
      await expect(page.getByRole("button", { name: /Apple/ })).toBeVisible()
    } else {
      await expect(page.getByRole("button", { name: /Apple/ })).toHaveCount(0)
    }
    await expect(page.getByLabel(/Email or username/)).toBeVisible()
  })

  test("password field has minLength=8 enforced by browser", async ({ page }) => {
    await page.goto("/signup")

    const passwordInput = page.locator("#password")
    const minLength = await passwordInput.getAttribute("minLength")
    expect(minLength).toBe("8")
  })

  test("password visibility toggle works", async ({ page }) => {
    await page.goto("/signup")

    const passwordInput = page.locator("#password")
    await passwordInput.fill("testpassword")

    // Initially password type
    await expect(passwordInput).toHaveAttribute("type", "password")

    // Click show password
    await page.getByRole("button", { name: "Show password" }).click()
    await expect(passwordInput).toHaveAttribute("type", "text")

    // Click hide password
    await page.getByRole("button", { name: "Hide password" }).click()
    await expect(passwordInput).toHaveAttribute("type", "password")
  })
})
