/**
 * RAD-138 — Data Integrity Verification
 * TDD RED phase: all tests are expected to FAIL until implementation is verified/fixed.
 *
 * Verifies that Radaric's data pipeline preserves all content, media,
 * and AI reasoning at every processing stage.
 *
 * Criteria covered:
 *   AC-1: Parse route creates RSS materials preserving full `content`, `mediaUrls[]`,
 *         `thumbnailUrl`, and `publishedAt` fields — none are stripped or overwritten
 *   AC-2: Parse route creates Telegram materials preserving `contentEntities` alongside `content`
 *   AC-3: evaluateMaterial() stores `aiReasoning` string on the material after evaluation
 *   AC-4: buildEvaluationPrompt() truncates at 3000 chars in the prompt but does NOT
 *         mutate the original material object's content field
 *   AC-5: Material unique constraint is (sourceId, url), not url alone — same URL from
 *         different sources is permitted
 *   AC-6: processApprovedMaterials() only sets storyId/storyMatchedAt on material.update —
 *         never touches content, mediaUrls, or thumbnailUrl
 *   AC-7: DELETE handler never deletes R2 media — the objects are shared and
 *         deduped across users, so per-user delete leaves them alone (RAD-368)
 *   EC-1: Material with empty content ("") — AI evaluation still runs and stores reasoning
 *   EC-2: Material with no mediaUrls (empty array) — deletion skips media cleanup entirely
 *   ERR-1: AI evaluation failure leaves the material record unchanged
 */

import { describe, it, expect, vi } from "vitest"
import type { NextRequest } from "next/server"
import { buildEvaluationPrompt } from "@/lib/ai"
import {
  processApprovedMaterials,
  type MaterialPipelineDeps,
} from "@/lib/story-aggregator/material-story-pipeline"

// ---------------------------------------------------------------------------
// Warm-up (collection time, not inside a test)
//
// Every route test below calls vi.resetModules() and then re-imports the route,
// so the first one to run pays for transforming and resolving the route's whole
// dependency tree — the parsers pull in GramJS and the AI SDK. Measured cold on
// an idle machine that first import was ~16s, while the same import in later
// tests cost 70-330ms because Vite's transform cache is warm. That is why AC-1
// and AC-2 timed out under CPU contention and passed in isolation.
//
// Doing the cold import once here pays it during collection, which testTimeout
// does not bound. @/lib/db is stubbed for the warm-up only so no PrismaClient is
// constructed; the stub is removed immediately after, and every test still calls
// vi.resetModules() and registers its own mocks, so nothing about what the tests
// exercise changes — only which phase absorbs the one-time cost.
// ---------------------------------------------------------------------------
vi.doMock("@/lib/db", () => ({ db: {} }))
vi.doMock("@/lib/auth-utils", () => ({ requireAuth: vi.fn(), isErrorResponse: vi.fn() }))
await import("@/app/api/parse/route")
await import("@/app/api/posts/[id]/route")
vi.doUnmock("@/lib/db")
vi.doUnmock("@/lib/auth-utils")
vi.resetModules()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "rad138_user_001"
const MATERIAL_ID = "mat_rad138_001"

const mockAIStoryOutput = {
  languageFlag: "GB",
  title: "Test Story",
  rubrics: ["Новые технологии"],
  authorLevel: "expert",
  materialType: "news",
  materialCharacter: "useful",
  summary: "Test summary.",
  body: "Test body.",
  keyPoints: ["Key point 1"],
  sourceUrls: ["https://example.com/article"],
}

const mockApprovedMaterial = {
  id: MATERIAL_ID,
  title: "Test Article",
  content: "Full article content here.",
  url: "https://example.com/article",
  rawText: null,
  aiEvaluation: "APPROVED",
  userStatus: "NEW",
  storyId: null,
  storyMatchedAt: null,
  feed: {
    userId: USER_ID,
    name: "Test Source",
    type: "RSS",
  },
}

// ---------------------------------------------------------------------------
// Dep factory for processApprovedMaterials
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<MaterialPipelineDeps> = {}): MaterialPipelineDeps {
  const storyCreate = vi.fn().mockResolvedValue({ id: "story_new_001" })
  const materialUpdateMany = vi.fn().mockResolvedValue({ count: 1 })
  return {
    db: {
      material: {
        findMany: vi.fn().mockResolvedValue([mockApprovedMaterial]),
        update: vi.fn().mockResolvedValue({}),
        updateMany: materialUpdateMany,
      },
      story: {
        create: storyCreate,
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue({
          userId: USER_ID,
          storySystemPrompt: null,
          storyLanguage: "en",
        }),
      },
      $transaction: vi.fn(async (fn) =>
        fn({ story: { create: storyCreate }, material: { updateMany: materialUpdateMany } })
      ),
    },
    matchContent: vi
      .fn()
      .mockResolvedValue({ match: null, matchType: null, isNew: true, reasoning: "No match" }),
    generateStory: vi.fn().mockResolvedValue(mockAIStoryOutput),
    matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "No match" }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC-1: Parse route — RSS material field preservation
// ---------------------------------------------------------------------------
describe("AC-1: parse route — RSS material field preservation", () => {
  it("AC-1: createMany data includes full content, thumbnailUrl, mediaUrls[], and publishedAt (not truncated)", async () => {
    vi.resetModules()

    const fullContent = "Full article content with many paragraphs. ".repeat(100)
    const mockCreateMany = vi.fn().mockResolvedValue({ count: 1 })

    vi.doMock("@/lib/parsers/rss", () => ({
      parseRSSFeed: vi.fn().mockResolvedValue([
        {
          title: "Rich RSS Item",
          url: "https://example.com/rich-item",
          externalId: "ext_001",
          content: fullContent,
          publishedAt: new Date("2026-03-20T10:00:00Z"),
          thumbnailUrl: "https://example.com/thumb.jpg",
          mediaUrls: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
        },
      ]),
    }))

    vi.doMock("@/lib/ai", () => ({
      evaluateMaterialsBatch: vi.fn().mockResolvedValue([
        { relevant: true, confidence: 85, reasoning: "Relevant tech content" },
      ]),
    }))

    vi.doMock("@/lib/db", () => ({
      db: {
        feed: {
          findMany: vi.fn()
            .mockResolvedValueOnce([
              {
                id: "src_aaa",
                type: "RSS",
                url: "https://feed.example.com/rss",
                name: "Test Feed",
                isActive: true,
                includeRetweets: false,
              },
            ])
            .mockResolvedValueOnce([]),
          update: vi.fn().mockResolvedValue({}),
        },
        material: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: mockCreateMany,
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("next/cache", () => ({
      revalidatePath: vi.fn(),
    }))

    const { POST } = await import("@/app/api/parse/route")
    const req = new Request("http://localhost/api/parse", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["src_aaa"] }),
    })

    await POST(req as unknown as NextRequest)

    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            content: fullContent,
            thumbnailUrl: "https://example.com/thumb.jpg",
            mediaUrls: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
            publishedAt: expect.any(Date),
          }),
        ]),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// AC-2: Parse route — Telegram contentEntities preservation
// ---------------------------------------------------------------------------
describe("AC-2: parse route — Telegram contentEntities preservation", () => {
  it("AC-2: createMany data includes contentEntities for Telegram items when present", async () => {
    vi.resetModules()

    const mockCreateMany = vi.fn().mockResolvedValue({ count: 1 })
    const contentEntities = [{ type: "bold", offset: 0, length: 5 }]

    vi.doMock("@/lib/parsers/telegram", () => ({
      parseTelegramChannel: vi.fn().mockResolvedValue([
        {
          title: "Telegram Post",
          url: "https://t.me/channel/123",
          externalId: "tg_ext_001",
          content: "Telegram post with *bold* text",
          contentEntities,
          publishedAt: new Date("2026-03-21T10:00:00Z"),
          thumbnailUrl: null,
          mediaUrls: [],
        },
      ]),
    }))

    vi.doMock("@/lib/ai", () => ({
      evaluateMaterialsBatch: vi.fn().mockResolvedValue([
        { relevant: true, confidence: 75, reasoning: "Relevant" },
      ]),
    }))

    vi.doMock("@/lib/db", () => ({
      db: {
        feed: {
          findMany: vi.fn()
            .mockResolvedValueOnce([
              {
                id: "src_bbb",
                type: "TELEGRAM",
                url: "@testchannel",
                name: "Test TG Channel",
                isActive: true,
                includeRetweets: false,
              },
            ])
            .mockResolvedValueOnce([]),
          update: vi.fn().mockResolvedValue({}),
        },
        material: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: mockCreateMany,
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("next/cache", () => ({
      revalidatePath: vi.fn(),
    }))

    const { POST } = await import("@/app/api/parse/route")
    const req = new Request("http://localhost/api/parse", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["src_bbb"] }),
    })

    await POST(req as unknown as NextRequest)

    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            content: "Telegram post with *bold* text",
            contentEntities,
          }),
        ]),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// AC-3: Parse route — aiReasoning stored on material record
// ---------------------------------------------------------------------------
describe("AC-3: parse route — aiReasoning stored in createMany data", () => {
  it("AC-3: createMany data includes aiReasoning from AI evaluation (not dropped)", async () => {
    vi.resetModules()

    const mockCreateMany = vi.fn().mockResolvedValue({ count: 1 })
    const expectedReasoning = "This article discusses cutting-edge AI research."

    vi.doMock("@/lib/parsers/rss", () => ({
      parseRSSFeed: vi.fn().mockResolvedValue([
        {
          title: "AI Research Article",
          url: "https://example.com/ai-research",
          externalId: "ext_ai_001",
          content: "Article about deep learning.",
          publishedAt: new Date("2026-03-22T10:00:00Z"),
          thumbnailUrl: null,
          mediaUrls: [],
        },
      ]),
    }))

    vi.doMock("@/lib/ai", () => ({
      evaluateMaterialsBatch: vi.fn().mockResolvedValue([
        { relevant: true, confidence: 90, reasoning: expectedReasoning },
      ]),
    }))

    vi.doMock("@/lib/db", () => ({
      db: {
        feed: {
          findMany: vi.fn()
            .mockResolvedValueOnce([
              {
                id: "src_aaa",
                type: "RSS",
                url: "https://feed.example.com/rss",
                name: "AI Blog",
                isActive: true,
                includeRetweets: false,
              },
            ])
            .mockResolvedValueOnce([]),
          update: vi.fn().mockResolvedValue({}),
        },
        material: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: mockCreateMany,
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("next/cache", () => ({
      revalidatePath: vi.fn(),
    }))

    const { POST } = await import("@/app/api/parse/route")
    const req = new Request("http://localhost/api/parse", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["src_aaa"] }),
    })

    await POST(req as unknown as NextRequest)

    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            aiReasoning: expectedReasoning,
          }),
        ]),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// AC-4: buildEvaluationPrompt — truncates in prompt but does NOT mutate input
// ---------------------------------------------------------------------------
describe("AC-4: buildEvaluationPrompt — content truncation does not mutate input material", () => {
  it("AC-4: input material.content remains full-length after buildEvaluationPrompt is called", () => {
    const originalContent = "z".repeat(5000)
    const material = {
      title: "Long Article",
      content: originalContent,
      url: "https://example.com/long",
    }

    buildEvaluationPrompt({
      material,
      globalPrompt: "Tech only",
      sourcePrompt: "",
      globalFeedbacks: [],
      sourceFeedbacks: [],
      sourceName: "Test",
    })

    // The original object must NOT have been mutated
    expect(material.content).toBe(originalContent)
    expect(material.content.length).toBe(5000)
  })

  it("AC-4: the prompt text contains only the first 3000 chars of content, with ellipsis, not the full 5000", () => {
    const originalContent = "a".repeat(5000)
    const material = {
      title: "Long Article",
      content: originalContent,
      url: "https://example.com/long",
    }

    const prompt = buildEvaluationPrompt({
      material,
      globalPrompt: "",
      sourcePrompt: "",
      globalFeedbacks: [],
      sourceFeedbacks: [],
      sourceName: "Test",
    })

    expect(prompt).toContain("a".repeat(3000) + "...")
    expect(prompt).not.toContain("a".repeat(3001))
  })
})

// ---------------------------------------------------------------------------
// AC-5: Schema — unique constraint is (sourceId, url), not url alone
// ---------------------------------------------------------------------------
describe("AC-5: dedup — unique constraint is (sourceId, url), not url alone", () => {
  it("AC-5: Prisma schema defines @@unique on [sourceId, url] for Material, with no standalone url @unique", async () => {
    const fs = await import("fs")
    const path = await import("path")
    const schemaPath = path.resolve(process.cwd(), "prisma/schema.prisma")
    const schema = fs.readFileSync(schemaPath, "utf-8")

    // The composite unique constraint must exist on (sourceId, url)
    expect(schema).toContain('@@unique([sourceId, url], map: "material_source_url_unique")')

    // Extract the Material model block to check the url field specifically
    const materialModelMatch = schema.match(/model Material \{[\s\S]*?\}/)
    expect(materialModelMatch).not.toBeNull()
    const materialModel = materialModelMatch![0]

    // The url field line must NOT be marked @unique (only the composite constraint is allowed)
    const urlFieldLine = materialModel
      .split("\n")
      .find((line) => line.trim().startsWith("url") && line.includes("String"))
    expect(urlFieldLine).toBeDefined()
    expect(urlFieldLine).not.toContain("@unique")
  })

  it("AC-5: parse route dedup query scopes existingMaterials by sourceId (same URL from different source is NOT a duplicate)", async () => {
    // Verify the existingMaterials query in the parse route filters by sourceId — meaning
    // the same URL under a different source.id would be a new material (not skipped).
    const fs = await import("fs")
    const path = await import("path")
    const routePath = path.resolve(process.cwd(), "app/api/parse/route.ts")
    const routeSource = fs.readFileSync(routePath, "utf-8")

    // The existingMaterials findMany must be scoped within a source (sourceId: source.id)
    expect(routeSource).toContain("sourceId: source.id")
    // And it must use URL-based OR filter within that scope
    expect(routeSource).toContain("url: { in:")
  })
})

// ---------------------------------------------------------------------------
// AC-6: processApprovedMaterials — does NOT modify content/mediaUrls/thumbnailUrl
// ---------------------------------------------------------------------------
describe("AC-6: processApprovedMaterials — story link only sets storyId and storyMatchedAt", () => {
  it("AC-6: no story-link write includes content, mediaUrls, or thumbnailUrl", async () => {
    const deps = buildDeps()

    // Singleton path links via the guarded updateMany — assert it never carries content fields.
    await processApprovedMaterials([MATERIAL_ID], USER_ID, deps, { allowSingletonStory: true })

    const linkCalls = (deps.db.material.updateMany as ReturnType<typeof vi.fn>).mock.calls

    // There must be at least one link call (linking material to story)
    expect(linkCalls.length).toBeGreaterThan(0)

    for (const [call] of linkCalls) {
      const data = call?.data ?? {}
      expect(data).not.toHaveProperty("content")
      expect(data).not.toHaveProperty("mediaUrls")
      expect(data).not.toHaveProperty("thumbnailUrl")
    }
  })

  it("AC-6: story link sets storyId and storyMatchedAt when a new story is created", async () => {
    const deps = buildDeps()

    await processApprovedMaterials([MATERIAL_ID], USER_ID, deps, { allowSingletonStory: true })

    expect(deps.db.material.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID, storyId: null },
        data: expect.objectContaining({
          storyId: expect.any(String),
          storyMatchedAt: expect.any(Date),
        }),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// AC-7: DELETE handler — shared R2 media is never deleted per user (RAD-368)
// ---------------------------------------------------------------------------
describe("AC-7: DELETE /api/posts/[id] — no R2 delete for a material's media", () => {
  it("AC-7: sends no DeleteObjectCommand, even when mediaUrls and thumbnailUrl are set", async () => {
    vi.resetModules()

    // Assert at the SDK boundary, not at a module the route no longer imports:
    // a mock of `@/lib/blob-storage` can never fail once the import is gone.
    const deleteInputs: Array<Record<string, unknown>> = []
    vi.doMock("@aws-sdk/client-s3", () => {
      class PutObjectCommand {
        input: Record<string, unknown>
        constructor(input: Record<string, unknown>) {
          this.input = input
        }
      }
      class DeleteObjectCommand {
        input: Record<string, unknown>
        constructor(input: Record<string, unknown>) {
          this.input = input
          deleteInputs.push(input)
        }
      }
      class HeadObjectCommand {
        input: Record<string, unknown>
        constructor(input: Record<string, unknown>) {
          this.input = input
        }
      }
      class S3Client {
        send = vi.fn(async () => ({}))
      }
      return { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand }
    })

    // A complete R2 config, so a re-added delete path would really reach the SDK.
    process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com"
    process.env.R2_ACCESS_KEY_ID = "test-key"
    process.env.R2_SECRET_ACCESS_KEY = "test-secret"
    process.env.R2_BUCKET_NAME = "radaric-media"
    process.env.R2_PUBLIC_URL = "https://media.example.test"

    vi.doMock("@/lib/db", () => ({
      db: {
        material: {
          findUnique: vi.fn().mockResolvedValue({
            sourceId: "src_aaa",
            mediaUrls: [
              "https://media.example.test/telegram/channel/1.jpg",
              "https://media.example.test/telegram/channel/2.jpg",
            ],
            thumbnailUrl: "https://media.example.test/telegram/channel/1_thumb.jpg",
            feed: { userId: USER_ID },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        aIFeedback: {
          upsert: vi.fn().mockResolvedValue({}),
          create: vi.fn().mockResolvedValue({}),
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("@/lib/implicit-feedback", () => ({
      createImplicitFeedback: vi.fn().mockReturnValue(null),
    }))

    const { DELETE } = await import("@/app/api/posts/[id]/route")
    const req = new Request(`http://localhost/api/posts/${MATERIAL_ID}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    })

    const res = await DELETE(req as unknown as NextRequest, { params: Promise.resolve({ id: MATERIAL_ID }) })

    expect(res.status).toBe(200)
    // RAD-368: one R2 object per Telegram message, shared by every subscriber —
    // a per-user delete must leave it for the others (a GC sweep is the follow-up).
    expect(deleteInputs).toHaveLength(0)

    vi.doUnmock("@aws-sdk/client-s3")
    delete process.env.R2_ENDPOINT
    delete process.env.R2_ACCESS_KEY_ID
    delete process.env.R2_SECRET_ACCESS_KEY
    delete process.env.R2_BUCKET_NAME
    delete process.env.R2_PUBLIC_URL
  })
})

// ---------------------------------------------------------------------------
// EC-1: Empty content — AI evaluation still runs and reasoning is stored
// ---------------------------------------------------------------------------
describe("EC-1: material with empty content string — AI evaluation still runs", () => {
  it("EC-1: evaluateMaterialsBatch is called for empty-content items, and aiReasoning is stored in createMany", async () => {
    vi.resetModules()

    const mockCreateMany = vi.fn().mockResolvedValue({ count: 1 })
    const mockEvaluateBatch = vi.fn().mockResolvedValue([
      { relevant: false, confidence: 60, reasoning: "Empty content — cannot evaluate topic" },
    ])

    vi.doMock("@/lib/parsers/rss", () => ({
      parseRSSFeed: vi.fn().mockResolvedValue([
        {
          title: "Empty Article",
          url: "https://example.com/empty",
          externalId: "ext_empty_001",
          content: "",
          publishedAt: new Date("2026-03-22T10:00:00Z"),
          thumbnailUrl: null,
          mediaUrls: [],
        },
      ]),
    }))

    vi.doMock("@/lib/ai", () => ({
      evaluateMaterialsBatch: mockEvaluateBatch,
    }))

    vi.doMock("@/lib/db", () => ({
      db: {
        feed: {
          findMany: vi.fn()
            .mockResolvedValueOnce([
              {
                id: "src_aaa",
                type: "RSS",
                url: "https://feed.example.com/rss",
                name: "Test Feed",
                isActive: true,
                includeRetweets: false,
              },
            ])
            .mockResolvedValueOnce([]),
          update: vi.fn().mockResolvedValue({}),
        },
        material: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany: mockCreateMany,
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("next/cache", () => ({
      revalidatePath: vi.fn(),
    }))

    const { POST } = await import("@/app/api/parse/route")
    const req = new Request("http://localhost/api/parse", {
      method: "POST",
      body: JSON.stringify({ sourceIds: ["src_aaa"] }),
    })

    await POST(req as unknown as NextRequest)

    expect(mockEvaluateBatch).toHaveBeenCalled()
    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            content: "",
            aiReasoning: "Empty content — cannot evaluate topic",
          }),
        ]),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// EC-2: No mediaUrls — deletion skips media cleanup
// ---------------------------------------------------------------------------
describe("EC-2: material with empty mediaUrls and null thumbnailUrl — deletion skips media cleanup", () => {
  it("EC-2: deleteMultipleMedia is NOT called when material has no media files", async () => {
    vi.resetModules()

    const mockDeleteMultipleMedia = vi.fn().mockResolvedValue(undefined)

    vi.doMock("@/lib/blob-storage", () => ({
      deleteMultipleMedia: mockDeleteMultipleMedia,
    }))

    vi.doMock("@/lib/db", () => ({
      db: {
        material: {
          findUnique: vi.fn().mockResolvedValue({
            sourceId: "src_aaa",
            mediaUrls: [],
            thumbnailUrl: null,
            feed: { userId: USER_ID },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        aIFeedback: {
          upsert: vi.fn().mockResolvedValue({}),
          create: vi.fn().mockResolvedValue({}),
        },
      },
    }))

    vi.doMock("@/lib/auth-utils", () => ({
      requireAuth: vi.fn().mockResolvedValue({ userId: USER_ID, role: "ADMIN" }),
      isErrorResponse: vi.fn().mockReturnValue(false),
    }))

    vi.doMock("@/lib/implicit-feedback", () => ({
      createImplicitFeedback: vi.fn().mockReturnValue(null),
    }))

    const { DELETE } = await import("@/app/api/posts/[id]/route")
    const req = new Request(`http://localhost/api/posts/${MATERIAL_ID}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    })

    await DELETE(req as unknown as NextRequest, { params: Promise.resolve({ id: MATERIAL_ID }) })

    expect(mockDeleteMultipleMedia).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ERR-1: AI failure — material record must remain unchanged
// ---------------------------------------------------------------------------
describe("ERR-1: AI evaluation failure — material record remains unchanged", () => {
  it("ERR-1: processApprovedMaterials does not link material to story when AI generateStory throws, and error is counted", async () => {
    const deps = buildDeps({
      generateStory: vi.fn().mockRejectedValue(new Error("AI timeout — rate limit exceeded")),
    })

    // Singleton path invokes generateStory; when it throws the material must stay unlinked.
    const result = await processApprovedMaterials([MATERIAL_ID], USER_ID, deps, {
      allowSingletonStory: true,
    })

    const updateCalls = (deps.db.material.update as ReturnType<typeof vi.fn>).mock.calls
    const storyLinkCalls = updateCalls.filter(
      ([call]) => call?.data?.storyId !== undefined
    )

    // The failed material must NOT have been linked to a story
    expect(storyLinkCalls).toHaveLength(0)

    // The error must be counted in the result
    expect((result as { errors?: number }).errors).toBeGreaterThanOrEqual(1)

    // storiesCreated must be 0 since we failed
    expect(result.storiesCreated).toBe(0)
  })
})
