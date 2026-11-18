/**
 * RAD-393 — source folders end to end.
 *
 * Real signup + real dev DB (seeded via Prisma: two feeds, one material each).
 * The menu path is deterministic; the drag is a manual mouse sequence against
 * dnd-kit's PointerSensor. If the drag proves unreliable in CI-less local runs,
 * the menu path still covers every outcome — the drag assertion is the extra.
 */

import { test, expect } from "./fixtures/auth"
import { findUserIdByEmail, seedFeed, deleteUser, testDb, grantTestAccess } from "./fixtures/db"

const PASSWORD = "e2e-test-password-123"

test.describe("source folders", () => {
  test("create, move (menu + drag), scope and delete", async ({ page, testUser, baseURL }) => {
    // --- auth (fail loudly: this spec requires the migrated dev DB) ----------
    const signup = await page.request.post(`${baseURL}/api/auth/signup`, {
      data: { email: testUser.email, password: PASSWORD },
    })
    expect(signup.ok(), `signup failed: ${signup.status()} ${await signup.text()}`).toBe(true)

    const csrf = await page.request.get(`${baseURL}/api/auth/csrf`)
    const { csrfToken } = await csrf.json()
    await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
      form: { email: testUser.email, password: PASSWORD, csrfToken, json: "true" },
    })

    const userId = await findUserIdByEmail(testUser.email)
    await grantTestAccess(userId)
    const alpha = await seedFeed({
      userId,
      name: "Alpha Source",
      url: "https://e2e-rad393.example.com/alpha.xml",
    })
    const beta = await seedFeed({
      userId,
      name: "Beta Source",
      url: "https://e2e-rad393.example.com/beta.xml",
    })

    try {
      await page.goto("/posts")
      const sidebar = page.locator("#app-sidebar-desktop")
      await expect(sidebar.getByRole("link", { name: /alpha source/i })).toBeVisible()
      await expect(sidebar.getByRole("link", { name: /beta source/i })).toBeVisible()

      // --- create a folder inline ------------------------------------------
      await page.getByRole("button", { name: "New folder" }).click()
      await page.getByRole("textbox", { name: "Folder name" }).fill("Design")
      await page.keyboard.press("Enter")
      const folderLink = sidebar.getByRole("link", { name: /design/i })
      await expect(folderLink).toBeVisible()
      const folderId = (await folderLink.getAttribute("href"))!.split("/").pop()!

      // --- move Alpha via the kebab menu (the canonical path) ---------------
      // Wait for the PATCH itself: the nested-row assertion below passes on the
      // optimistic tree, but the folder page reads committed membership.
      const alphaMove = page.waitForResponse(
        res =>
          res.url().includes(`/api/feeds/${alpha.feedId}/folder`) &&
          res.request().method() === "PATCH"
      )
      await page.getByRole("button", { name: "Actions for Alpha Source" }).click()
      await page.getByRole("menuitem", { name: "Move to folder" }).hover()
      await page.getByRole("menuitem", { name: "Design" }).click()
      await alphaMove
      await expect(
        page.locator(`#desktop-folder-${folderId}-sources`).getByRole("link", { name: /alpha source/i })
      ).toBeVisible()

      // --- folder view is scoped to its members -----------------------------
      // Let the dropdown finish closing so its layer cannot swallow the click.
      await expect(page.getByRole("menu")).toHaveCount(0)
      await folderLink.click()
      await expect(page).toHaveURL(new RegExp(`/folders/${folderId}$`))
      await expect(page.getByRole("heading", { name: "Design" })).toBeVisible()
      await expect(page.getByText(alpha.materialTitle)).toBeVisible()
      await expect(page.getByText(beta.materialTitle)).toHaveCount(0)
      await expect(page.getByRole("button", { name: /all types/i })).toBeVisible()

      // --- drag Beta into the folder ---------------------------------------
      await page.goto("/posts")
      const sourceRow = sidebar.getByRole("link", { name: /beta source/i })
      const target = sidebar.getByRole("link", { name: /design/i })
      await expect(sourceRow).toBeVisible()
      const sourceBox = (await sourceRow.boundingBox())!
      const targetBox = (await target.boundingBox())!
      const sx = sourceBox.x + sourceBox.width / 2
      const sy = sourceBox.y + sourceBox.height / 2
      const tx = targetBox.x + targetBox.width / 2
      const ty = targetBox.y + targetBox.height / 2

      const betaMove = page.waitForResponse(
        res =>
          res.url().includes(`/api/feeds/${beta.feedId}/folder`) &&
          res.request().method() === "PATCH"
      )
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      for (let step = 1; step <= 10; step++) {
        await page.mouse.move(sx + ((tx - sx) * step) / 10, sy + ((ty - sy) * step) / 10)
        await page.waitForTimeout(30)
      }
      await page.mouse.up()
      await betaMove

      await expect(
        page.locator(`#desktop-folder-${folderId}-sources`).getByRole("link", { name: /beta source/i })
      ).toBeVisible()

      // --- delete the folder; sources survive ------------------------------
      await page.getByRole("button", { name: "Actions for Design" }).click()
      await page.getByRole("menuitem", { name: "Delete folder…" }).click()
      await expect(page.getByText("Delete folder “Design”?")).toBeVisible()
      await page.getByRole("button", { name: "Delete folder" }).click()
      await expect(sidebar.getByRole("link", { name: /design/i })).toHaveCount(0)
      await expect(sidebar.getByRole("link", { name: /alpha source/i })).toBeVisible()
      await expect(sidebar.getByRole("link", { name: /beta source/i })).toBeVisible()
    } finally {
      await deleteUser(userId)
      await testDb().$disconnect()
    }
  })
})
