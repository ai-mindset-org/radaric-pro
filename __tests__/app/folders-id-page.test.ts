/**
 * RAD-393 — /folders/[id] folder view (server component)
 *
 * Covers the gating behaviour of app/(dashboard)/folders/[id]/page.tsx:
 *   - redirects to /signup when not authenticated
 *   - redirects to /onboarding/feeds when the user hasn't onboarded and has zero feeds
 *   - 404s when the folder doesn't exist / belongs to another user
 *   - loads materials scoped to the folder for a visible member set
 *   - skips the materials read entirely for an empty folder
 *
 * Mirrors __tests__/app/feeds-id-page.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    feed: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    folder: {
      findFirst: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

vi.mock("@/lib/entitlements", () => ({
  getTwitterEntitlement: vi.fn(async () => ({ tier: null, includesTwitter: true })),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    ;(err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error("NEXT_NOT_FOUND")
    ;(err as unknown as { digest: string }).digest = "NEXT_NOT_FOUND"
    throw err
  }),
}))

vi.mock("@/components/materials/materials-list", () => ({
  MaterialsList: () => null,
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { redirect, notFound } from "next/navigation"
import FolderMaterialsPage from "@/app/(dashboard)/folders/[id]/page"

const USER_ID = "user-rad-393"
const FOLDER_ID = "folder-abc"

function setSession(userId: string | null) {
  if (userId === null) {
    vi.mocked(auth).mockResolvedValue(null as never)
  } else {
    vi.mocked(auth).mockResolvedValue({ user: { id: userId, role: "USER" } } as never)
  }
}

function setOnboarded() {
  vi.mocked(db.userSettings.findUnique).mockResolvedValue({
    onboardingCompleted: true,
    onboardingBannerDismissed: true,
    notionToken: null,
    notionDatabaseId: null,
    storyNotionDatabaseId: null,
  } as never)
}

function stubMaterials() {
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(db.material.count).mockResolvedValue(0)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("FolderMaterialsPage — gates", () => {
  it("redirects to /signup when the user is not authenticated", async () => {
    setSession(null)
    await expect(
      FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) })
    ).rejects.toThrow("NEXT_REDIRECT:/signup")
    expect(redirect).toHaveBeenCalledWith("/signup")
  })

  it("redirects to onboarding when not onboarded with zero feeds", async () => {
    setSession(USER_ID)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: false,
      notionToken: null,
      notionDatabaseId: null,
      storyNotionDatabaseId: null,
    } as never)
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(
      FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) })
    ).rejects.toThrow("NEXT_REDIRECT:/onboarding/feeds")
  })

  it("404s a missing or foreign folder", async () => {
    setSession(USER_ID)
    setOnboarded()
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)

    await expect(
      FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalled()
    expect(db.folder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: FOLDER_ID, userId: USER_ID },
      })
    )
  })
})

describe("FolderMaterialsPage — scope", () => {
  it("loads materials for a folder with visible members", async () => {
    setSession(USER_ID)
    setOnboarded()
    vi.mocked(db.folder.findFirst).mockResolvedValue({
      id: FOLDER_ID,
      name: "Design",
      feeds: [{ id: "feed-1" }, { id: "feed-2" }],
    } as never)
    stubMaterials()

    await FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) })

    const where = vi.mocked(db.material.findMany).mock.calls[0][0]?.where as
      | { feed?: Record<string, unknown> }
      | undefined
    expect(where?.feed).toEqual(
      expect.objectContaining({ userId: USER_ID, folderId: FOLDER_ID, hidden: false, isActive: true })
    )
  })

  it("does not read materials for an empty folder", async () => {
    setSession(USER_ID)
    setOnboarded()
    vi.mocked(db.folder.findFirst).mockResolvedValue({
      id: FOLDER_ID,
      name: "Empty",
      feeds: [],
    } as never)

    await FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) })

    expect(db.material.findMany).not.toHaveBeenCalled()
  })
})

describe("FolderMaterialsPage — freshness (RAD-424)", () => {
  const NOW = new Date("2026-11-03T10:00:00Z")
  const folderWith = (feeds: Record<string, unknown>[]) =>
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: FOLDER_ID, name: "Mixed", feeds } as never)
  const freshnessOf = (el: unknown) =>
    (el as { props: { freshness: { activeCount: number; neverCount: number } } }).props.freshness

  it("does not count a locked X member that a parse would skip", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubMaterials()
    vi.mocked(getTwitterEntitlement).mockResolvedValueOnce({ tier: "lite", includesTwitter: false } as never)
    folderWith([
      { id: "r", type: "RSS", status: "ACTIVE", isActive: true, lastParsedAt: NOW },
      { id: "x", type: "TWITTER", status: "ACTIVE", isActive: true, lastParsedAt: null },
    ])
    const freshness = freshnessOf(await FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) }))
    expect(freshness.activeCount).toBe(1)
    expect(freshness.neverCount).toBe(0)
  })

  it("counts X members for a Pro user", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubMaterials()
    folderWith([{ id: "x", type: "TWITTER", status: "ACTIVE", isActive: true, lastParsedAt: null }])
    const freshness = freshnessOf(await FolderMaterialsPage({ params: Promise.resolve({ id: FOLDER_ID }) }))
    expect(freshness.neverCount).toBe(1)
  })
})
