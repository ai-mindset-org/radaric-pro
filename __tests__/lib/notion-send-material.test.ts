/**
 * RAD-401 — a post exported to Notion keeps its media (lib/notion.ts sendMaterialToNotion).
 * Spec: AC-5 (cover first, text, divider + rest), AC-6 (> 100 blocks → append batches),
 * EC-1 (no media → paragraphs only), ERR-1 (url > 2000 chars skipped, page still created).
 *
 * Integration level: @/lib/db and @notionhq/client are mocked — never the real Notion API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { userSettingsFindUnique, materialFindUnique, materialUpdate, databasesRetrieve, pagesCreate, childrenAppend } =
  vi.hoisted(() => ({
    userSettingsFindUnique: vi.fn(),
    materialFindUnique: vi.fn(),
    materialUpdate: vi.fn(),
    databasesRetrieve: vi.fn(),
    pagesCreate: vi.fn(),
    childrenAppend: vi.fn(),
  }))

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: { findUnique: userSettingsFindUnique },
    material: { findUnique: materialFindUnique, update: materialUpdate },
  },
}))

vi.mock("@notionhq/client", () => {
  class Client {
    databases = { retrieve: databasesRetrieve }
    pages = { create: pagesCreate }
    blocks = { children: { append: childrenAppend } }
  }
  return { Client }
})

import { sendMaterialToNotion } from "@/lib/notion"

const USER_ID = "user_1"
const MATERIAL_ID = "mat_1"
const PAGE_ID = "page-1"

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: MATERIAL_ID,
    title: "A post with pictures",
    content: "Body text",
    contentEntities: null,
    url: "https://example.com/post",
    publishedAt: new Date("2026-10-10T10:00:00Z"),
    sourceId: "feed_1",
    thumbnailUrl: null,
    mediaUrls: [] as string[],
    feed: { id: "feed_1", name: "Example feed", type: "RSS", userId: USER_ID },
    ...overrides,
  }
}

const paragraph = (content: string) => ({
  type: "paragraph",
  paragraph: { rich_text: [{ text: { content } }] },
})
const img = (url: string) => ({ type: "image", image: { type: "external", external: { url } } })
const vid = (url: string) => ({ type: "video", video: { type: "external", external: { url } } })

function createdChildren(): any[] {
  return (pagesCreate.mock.calls[0][0] as { children: any[] }).children
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
  userSettingsFindUnique.mockResolvedValue({
    userId: USER_ID,
    notionToken: "secret_test_token",
    notionDatabaseId: "db_1",
  })
  databasesRetrieve.mockResolvedValue({ id: "db_1", properties: { Ссылка: { type: "url" } } })
  pagesCreate.mockResolvedValue({ id: PAGE_ID, url: "https://notion.so/page-1" })
  childrenAppend.mockResolvedValue({})
  materialUpdate.mockResolvedValue({})
})

describe("sendMaterialToNotion — media (RAD-401)", () => {
  it("AC-5: cover image first, then the text, then a divider + the rest (3 images + 1 video)", async () => {
    materialFindUnique.mockResolvedValue(
      material({
        thumbnailUrl: "https://cdn.example.com/cover.jpg",
        mediaUrls: [
          "https://cdn.example.com/p2.jpg",
          "https://cdn.example.com/p3.png",
          "https://cdn.example.com/clip.mp4",
        ],
      })
    )

    const result = await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    expect(result.notionPageId).toBe(PAGE_ID)
    const children = createdChildren()
    expect(children).toHaveLength(6)
    expect(children).toMatchObject([
      img("https://cdn.example.com/cover.jpg"),
      paragraph("Body text"),
      { type: "divider" },
      img("https://cdn.example.com/p2.jpg"),
      img("https://cdn.example.com/p3.png"),
      vid("https://cdn.example.com/clip.mp4"),
    ])
    expect(children.filter((b) => b.type === "image")).toHaveLength(3)
    expect(children.filter((b) => b.type === "video")).toHaveLength(1)
    expect(childrenAppend).not.toHaveBeenCalled()
  })

  it("AC-6: > 100 blocks → pages.create gets the first 100, the rest go via blocks.children.append in batches ≤ 100", async () => {
    const extra = Array.from({ length: 250 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`)
    materialFindUnique.mockResolvedValue(
      material({ thumbnailUrl: "https://cdn.example.com/cover.jpg", mediaUrls: extra })
    )
    // cover + paragraph + divider + 250 images = 253 blocks
    const expected = [
      img("https://cdn.example.com/cover.jpg"),
      paragraph("Body text"),
      { type: "divider" },
      ...extra.map(img),
    ]

    await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    const children = createdChildren()
    expect(children).toHaveLength(100)
    expect(children).toMatchObject(expected.slice(0, 100))

    expect(childrenAppend).toHaveBeenCalledTimes(2)
    const [first, second] = childrenAppend.mock.calls.map((c) => c[0] as { block_id: string; children: any[] })
    expect(first.block_id).toBe(PAGE_ID)
    expect(first.children).toHaveLength(100)
    expect(first.children).toMatchObject(expected.slice(100, 200))
    expect(second.block_id).toBe(PAGE_ID)
    expect(second.children).toHaveLength(53)
    expect(second.children).toMatchObject(expected.slice(200))
  })

  it("EC-1: a material without media → children are only the paragraphs (regression guard)", async () => {
    materialFindUnique.mockResolvedValue(material())

    await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    const children = createdChildren()
    expect(children).toHaveLength(1)
    expect(children).toMatchObject([paragraph("Body text")])
    expect(childrenAppend).not.toHaveBeenCalled()
  })

  it("ERR-1: a media url > 2000 chars is skipped and the page is still created with the other blocks", async () => {
    const longUrl = "https://cdn.example.com/" + "x".repeat(2000) + ".jpg"
    materialFindUnique.mockResolvedValue(
      material({
        thumbnailUrl: "https://cdn.example.com/cover.jpg",
        mediaUrls: ["https://cdn.example.com/ok.jpg", longUrl],
      })
    )

    const result = await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    expect(result.success).toBe(true)
    expect(pagesCreate).toHaveBeenCalledTimes(1)
    const children = createdChildren()
    expect(children).toHaveLength(4)
    expect(children).toMatchObject([
      img("https://cdn.example.com/cover.jpg"),
      paragraph("Body text"),
      { type: "divider" },
      img("https://cdn.example.com/ok.jpg"),
    ])
    expect(JSON.stringify(children)).not.toContain(longUrl)
  })

  it("a failed append after pages.create does not fail the export: material still SENT_TO_NOTION, truncated: true", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const extra = Array.from({ length: 250 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`)
    materialFindUnique.mockResolvedValue(
      material({ thumbnailUrl: "https://cdn.example.com/cover.jpg", mediaUrls: extra })
    )
    // 253 blocks: create(100) + append(100) ok + append(53) rejects.
    childrenAppend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Notion 502"))

    const result = await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    expect(result).toMatchObject({ success: true, notionPageId: PAGE_ID, truncated: true })
    expect(pagesCreate).toHaveBeenCalledTimes(1)
    expect(childrenAppend).toHaveBeenCalledTimes(2)
    expect(materialUpdate).toHaveBeenCalledWith({
      where: { id: MATERIAL_ID },
      data: { userStatus: "SENT_TO_NOTION" },
    })
  })

  it("an append failure stops further appends (no out-of-order tail)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const extra = Array.from({ length: 350 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`)
    materialFindUnique.mockResolvedValue(
      material({ thumbnailUrl: "https://cdn.example.com/cover.jpg", mediaUrls: extra })
    )
    // 353 blocks: create(100) + 3 appends; the first append rejects → no more.
    childrenAppend.mockRejectedValueOnce(new Error("Notion 502"))

    const result = await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    expect(result).toMatchObject({ success: true, truncated: true })
    expect(childrenAppend).toHaveBeenCalledTimes(1)
    expect(materialUpdate).toHaveBeenCalledTimes(1)
  })

  it("a full export reports truncated: false", async () => {
    materialFindUnique.mockResolvedValue(
      material({ thumbnailUrl: "https://cdn.example.com/cover.jpg", mediaUrls: ["https://cdn.example.com/b.jpg"] })
    )

    const result = await sendMaterialToNotion(MATERIAL_ID, USER_ID)

    expect(result).toMatchObject({ success: true, truncated: false })
  })
})
