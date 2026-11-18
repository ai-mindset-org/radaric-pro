// @vitest-environment node

/**
 * RAD-369 — story models and story prompts are a server-side ADMIN entitlement,
 * and every free-text prompt has a length cap.
 *
 * The settings UI hides the story-model pickers and the story system prompt
 * behind `isAdmin`, but `PUT /api/user-settings` wrote them for any signed-in
 * user. `POST /api/posts/group-stories` then ran the material story pipeline
 * with those values on Radaric's AI keys, so a user could pick the most
 * expensive model in the catalogue and a 200k-character prompt and let the
 * per-minute rate limit bound calls, not tokens.
 *
 * Contracts:
 *   D4 — PUT strips `storyWriterModel` / `storyMatcherModel` /
 *        `materialStoryModel` / `storySystemPrompt` for a non-admin (silently:
 *        the settings form re-sends whatever GET returned), on BOTH branches;
 *        an admin is untouched
 *   D5 — a stored override is ignored at read time for a non-admin:
 *        `buildMaterialStoryDeps` builds the stage default and hands the
 *        pipeline a `storySystemPrompt` of null
 *   D6 — `globalPrompt` / `storySystemPrompt` / feed `customPrompt` are capped
 *        server-side, over the cap → 400 and nothing written
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    settings: { findFirst: vi.fn() },
    feed: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    story: { findMany: vi.fn() },
    inboxItem: { findUnique: vi.fn() },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

vi.mock("@/lib/entitlements", () => ({
  getTwitterEntitlement: vi.fn(),
}))

vi.mock("@/lib/feed-validation", async (actual) => ({
  ...(await actual<object>()),
  validateRssSource: vi.fn(),
  validateTelegramSource: vi.fn(),
}))

vi.mock("@/lib/parsers/twitter", () => ({ buildTwitterSourceUrl: vi.fn(() => "https://x.com/u") }))
vi.mock("@/lib/parsers/interest", () => ({
  createParallelMonitor: vi.fn(),
  deleteParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(() => "https://radaric.pro/api/webhooks/parallel"),
}))
vi.mock("@/lib/youtube", () => ({
  resolveYouTubeChannel: vi.fn(),
  YouTubeResolveError: class extends Error {},
}))
vi.mock("@/lib/feed-cover", () => ({ saveSourceCover: vi.fn(() => Promise.resolve()) }))
vi.mock("@/lib/feed-favicon", () => ({ saveSourceFavicon: vi.fn(() => Promise.resolve()) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

// D5: the model constructor is the observable boundary — the real registry
// resolver stays in play, so the assertion is about the id it was handed.
vi.mock("@/lib/models/provider", () => ({ createModelInstance: vi.fn() }))

vi.mock("ai", () => ({
  generateObject: vi.fn().mockResolvedValue({ object: {} }),
  generateText: vi.fn().mockResolvedValue({ text: "{}" }),
}))

import { generateText } from "ai"

import { db } from "@/lib/db"
import { requireAuth } from "@/lib/auth-utils"
import { validateRssSource } from "@/lib/feed-validation"
import { createModelInstance } from "@/lib/models/provider"
import {
  ANTHROPIC_MODELS,
  OPENROUTER_MODELS,
  STAGE_DEFAULTS,
} from "@/lib/models/registry"
import { sourceSchema, updateSourceSchema } from "@/lib/validations/feed"
import { buildMaterialStoryDeps, buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"
import { PUT, PATCH } from "@/app/api/user-settings/route"
import { POST as POST_FEED } from "@/app/api/feeds/route"
import { PATCH as PATCH_FEED } from "@/app/api/feeds/[id]/route"

const USER_ID = "user-1"
const FEED_ID = "feed-1"

/** The most expensive model in the catalogue — the id the exploit reaches for. */
const PREMIUM_MODEL = [...ANTHROPIC_MODELS, ...OPENROUTER_MODELS].reduce((a, b) =>
  (b.priceOut ?? 0) > (a.priceOut ?? 0) ? b : a
).id

const STORY_PROMPT = "You are the house story writer. Match and write in this voice."

function setupAuth(role: "USER" | "ADMIN", userId = USER_ID) {
  vi.mocked(requireAuth).mockResolvedValue({ userId, role })
}

function existingSettings() {
  const base = {
    id: "settings-1",
    userId: USER_ID,
    globalPrompt: null,
    notionToken: null,
    notionDatabaseId: null,
    storyInboxChannelId: null,
    storyNotionDatabaseId: null,
    storySystemPrompt: null,
    storyWriterModel: null,
    storyMatcherModel: null,
    materialStoryModel: null,
    storyLanguage: "en",
    autoDeleteTelegramMessages: false,
    globalLikedCategories: [],
    globalDislikedCategories: [],
  }
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(base as never)
  vi.mocked(db.userSettings.update).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...base, ...data }) as never
  )
  return base
}

function noSettings() {
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(null as never)
  vi.mocked(db.userSettings.create).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }) as never
  )
}

function storyAdminBody() {
  return {
    storyWriterModel: PREMIUM_MODEL,
    storyMatcherModel: PREMIUM_MODEL,
    materialStoryModel: PREMIUM_MODEL,
    storySystemPrompt: STORY_PROMPT,
  }
}

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/user-settings", {
      method: "PUT",
      body: JSON.stringify(body),
    })
  )
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/user-settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  )
}

function postFeed(body: unknown) {
  return POST_FEED(
    new NextRequest("http://localhost/api/feeds", {
      method: "POST",
      body: JSON.stringify(body),
    })
  )
}

function patchFeed(body: unknown) {
  return PATCH_FEED(
    new NextRequest(`http://localhost/api/feeds/${FEED_ID}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: FEED_ID }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.userSettings.upsert).mockImplementation(
    async (args: { create: Record<string, unknown> }) => ({ id: "upserted", ...args.create }) as never
  )
})

// ---------------------------------------------------------------------------
// D4 — the four story fields are admin-only on write
// ---------------------------------------------------------------------------

describe("PUT /api/user-settings — story admin fields are admin-only", () => {
  it("strips all four story fields for a non-admin on the update branch (200, nothing written)", async () => {
    setupAuth("USER")
    existingSettings()

    const res = await put({ ...storyAdminBody(), globalLikedCategories: ["Design"] })

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty("storyWriterModel")
    expect(data).not.toHaveProperty("storyMatcherModel")
    expect(data).not.toHaveProperty("materialStoryModel")
    expect(data).not.toHaveProperty("storySystemPrompt")
    // The rest of the save still lands.
    expect(data.globalLikedCategories).toEqual(["Design"])
  })

  it("strips all four story fields for a non-admin on the create branch", async () => {
    setupAuth("USER")
    noSettings()

    const res = await put(storyAdminBody())

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.create).mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty("storyWriterModel")
    expect(data).not.toHaveProperty("storyMatcherModel")
    expect(data).not.toHaveProperty("materialStoryModel")
    expect(data).not.toHaveProperty("storySystemPrompt")
    expect(data.userId).toBe(USER_ID)
  })

  it("still writes all four story fields for an admin (regression guard)", async () => {
    setupAuth("ADMIN")
    existingSettings()

    const res = await put(storyAdminBody())

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data.storyWriterModel).toBe(PREMIUM_MODEL)
    expect(data.storyMatcherModel).toBe(PREMIUM_MODEL)
    expect(data.materialStoryModel).toBe(PREMIUM_MODEL)
    expect(data.storySystemPrompt).toBe(STORY_PROMPT)
  })
})

// ---------------------------------------------------------------------------
// D6 — prompt length caps
// ---------------------------------------------------------------------------

describe("prompt caps — globalPrompt (PUT and PATCH)", () => {
  it("PUT rejects an 8001-character globalPrompt with 400 and writes nothing", async () => {
    setupAuth("USER")
    existingSettings()

    const res = await put({ globalPrompt: "a".repeat(8001) })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Global prompt is too long (max 8000 characters)" })
    expect(db.userSettings.update).not.toHaveBeenCalled()
    expect(db.userSettings.create).not.toHaveBeenCalled()
  })

  it("PUT accepts an 8000-character globalPrompt", async () => {
    setupAuth("USER")
    existingSettings()

    const res = await put({ globalPrompt: "a".repeat(8000) })

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect((data.globalPrompt as string).length).toBe(8000)
  })

  it("PUT accepts an unchanged over-cap globalPrompt without writing it (legacy round-trip)", async () => {
    setupAuth("USER")
    const stored = "a".repeat(9000)
    const base = existingSettings()
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ ...base, globalPrompt: stored } as never)

    const res = await put({ globalPrompt: stored, globalLikedCategories: ["Design"] })

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    // Dropped from the write, not rejected: the rest of the save still lands.
    expect(data).not.toHaveProperty("globalPrompt")
    expect(data.globalLikedCategories).toEqual(["Design"])
  })

  it("PATCH rejects an 8001-character globalPrompt with 400 and writes nothing", async () => {
    setupAuth("USER")

    const res = await patch({ globalPrompt: "a".repeat(8001) })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Global prompt is too long (max 8000 characters)" })
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })

  it("PATCH accepts an 8000-character globalPrompt", async () => {
    setupAuth("USER")

    const res = await patch({ globalPrompt: "a".repeat(8000) })

    expect(res.status).toBe(200)
    expect(db.userSettings.upsert).toHaveBeenCalledTimes(1)
  })

  it("PATCH accepts an unchanged over-cap globalPrompt without writing it (legacy round-trip)", async () => {
    setupAuth("USER")
    const stored = "a".repeat(9000)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ globalPrompt: stored } as never)

    const res = await patch({ globalPrompt: stored })

    expect(res.status).toBe(200)
    expect(db.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: {},
      create: { userId: USER_ID },
    })
  })

  it("PUT rejects a non-string globalPrompt with 400", async () => {
    setupAuth("USER")
    existingSettings()

    const res = await put({ globalPrompt: 42 })

    expect(res.status).toBe(400)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })
})

describe("prompt caps — storySystemPrompt (admin)", () => {
  it("rejects a 20001-character storySystemPrompt with 400 and writes nothing", async () => {
    setupAuth("ADMIN")
    existingSettings()

    const res = await put({ storySystemPrompt: "a".repeat(20001) })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Story system prompt is too long (max 20000 characters)",
    })
    expect(db.userSettings.update).not.toHaveBeenCalled()
    expect(db.userSettings.create).not.toHaveBeenCalled()
  })

  it("accepts an exactly-20000-character storySystemPrompt", async () => {
    setupAuth("ADMIN")
    existingSettings()

    const res = await put({ storySystemPrompt: "a".repeat(20000) })

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect((data.storySystemPrompt as string).length).toBe(20000)
  })

  it("accepts an admin's unchanged over-cap storySystemPrompt without writing it (legacy round-trip)", async () => {
    setupAuth("ADMIN")
    const stored = "a".repeat(25000)
    const base = existingSettings()
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ ...base, storySystemPrompt: stored } as never)

    const res = await put({ storySystemPrompt: stored })

    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty("storySystemPrompt")
  })

  it("rejects a non-string storySystemPrompt from an admin with 400", async () => {
    setupAuth("ADMIN")
    existingSettings()

    const res = await put({ storySystemPrompt: ["not", "a", "string"] })

    expect(res.status).toBe(400)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// D6 — feed customPrompt cap
// ---------------------------------------------------------------------------

describe("prompt caps — feed customPrompt", () => {
  it("POST /api/feeds rejects an 8001-character customPrompt with 400 and creates nothing", async () => {
    setupAuth("USER")
    vi.mocked(validateRssSource).mockResolvedValue({ ok: true, itemCount: 3 } as never)
    vi.mocked(db.feed.findFirst).mockResolvedValue(null as never)
    vi.mocked(db.feed.create).mockResolvedValue({ id: FEED_ID } as never)

    const res = await postFeed({
      type: "RSS",
      name: "A feed",
      url: "https://example.com/feed.xml",
      isActive: true,
      customPrompt: "a".repeat(8001),
    })

    expect(res.status).toBe(400)
    expect(db.feed.create).not.toHaveBeenCalled()
  })

  it("PATCH /api/feeds/[id] rejects an 8001-character customPrompt with 400 and updates nothing", async () => {
    setupAuth("USER")

    const res = await patchFeed({ customPrompt: "a".repeat(8001) })

    expect(res.status).toBe(400)
    expect(db.feed.findUnique).not.toHaveBeenCalled()
    expect(db.feed.updateMany).not.toHaveBeenCalled()
  })

  it("sourceSchema and updateSourceSchema both cap customPrompt at 8000", () => {
    const tooLong = "a".repeat(8001)
    const atCap = "a".repeat(8000)

    expect(sourceSchema.safeParse({ type: "RSS", name: "F", url: "https://e.com/f", isActive: true, customPrompt: tooLong }).success).toBe(false)
    expect(sourceSchema.safeParse({ type: "RSS", name: "F", url: "https://e.com/f", isActive: true, customPrompt: atCap }).success).toBe(true)

    expect(updateSourceSchema.safeParse({ id: FEED_ID, customPrompt: tooLong }).success).toBe(false)
    expect(updateSourceSchema.safeParse({ id: FEED_ID, customPrompt: atCap }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D5 — read-time entitlement for stored overrides
// ---------------------------------------------------------------------------

describe("buildMaterialStoryDeps — stored story overrides are ignored for a non-admin", () => {
  function storedRow() {
    const row = {
      userId: USER_ID,
      materialStoryModel: PREMIUM_MODEL,
      storySystemPrompt: STORY_PROMPT,
      storyLanguage: "en",
    }
    vi.mocked(db.settings.findFirst).mockResolvedValue({ aiApiKey: "sk-test" } as never)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(row as never)
    return row
  }

  it("a USER's stored premium model resolves to the stage default and the prompt reads as null", async () => {
    storedRow()
    vi.mocked(db.user.findUnique).mockResolvedValue({ role: "USER" } as never)
    vi.mocked(createModelInstance).mockResolvedValue({} as never)

    const deps = await buildMaterialStoryDeps(USER_ID)
    await deps.generateStory("system", "user content")

    expect(STAGE_DEFAULTS.materialStory).not.toBe(PREMIUM_MODEL)
    expect(createModelInstance).toHaveBeenCalledWith(
      STAGE_DEFAULTS.materialStory,
      expect.objectContaining({ anthropicApiKey: "sk-test" })
    )

    const seen = await deps.db.userSettings.findUnique({ where: { userId: USER_ID } })
    expect(seen?.storySystemPrompt).toBeNull()
    expect(seen?.storyLanguage).toBe("en")
  })

  it("an ADMIN's stored model and prompt pass through", async () => {
    storedRow()
    vi.mocked(db.user.findUnique).mockResolvedValue({ role: "ADMIN" } as never)
    vi.mocked(createModelInstance).mockResolvedValue({} as never)

    const deps = await buildMaterialStoryDeps(USER_ID)
    await deps.generateStory("system", "user content")

    expect(createModelInstance).toHaveBeenCalledWith(
      PREMIUM_MODEL,
      expect.objectContaining({ anthropicApiKey: "sk-test" })
    )

    const seen = await deps.db.userSettings.findUnique({ where: { userId: USER_ID } })
    expect(seen?.storySystemPrompt).toBe(STORY_PROMPT)
  })
})

// The inbox-item factory is the other HTTP entry point (stories/poll,
// posts/[id]/stories, inbox-items/[id]/retry, stories/[id]/notion) — it must
// answer the same way, and the mask must not take sibling fields with it.
describe("buildPipelineDeps — the inbox path is masked the same way", () => {
  function inboxRow() {
    vi.mocked(db.settings.findFirst).mockResolvedValue({ aiApiKey: "sk-test" } as never)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      userId: USER_ID,
      storyWriterModel: PREMIUM_MODEL,
      storyMatcherModel: PREMIUM_MODEL,
      storySystemPrompt: STORY_PROMPT,
      storyNotionDatabaseId: "notion-db-1",
      storyLanguage: "en",
    } as never)
    vi.mocked(createModelInstance).mockResolvedValue({} as never)
  }

  it("a USER's writer/matcher overrides fall back to the stage defaults and the prompt reads null", async () => {
    inboxRow()
    vi.mocked(db.user.findUnique).mockResolvedValue({ role: "USER" } as never)

    const deps = await buildPipelineDeps(USER_ID, "notion-token")
    await deps.generateStory("system", "user content")

    expect(STAGE_DEFAULTS.storyWriter).not.toBe(PREMIUM_MODEL)
    expect(createModelInstance.mock.calls[0][0]).toBe(STAGE_DEFAULTS.storyWriter)

    const seen = await deps.db.userSettings.findUnique({ where: { userId: USER_ID } })
    expect(seen?.storySystemPrompt).toBeNull()
    // Sibling fields the pipeline legitimately needs survive the mask.
    expect(seen?.storyNotionDatabaseId).toBe("notion-db-1")

    // The matcher is built lazily inside matchItem — same entitlement, same defaults.
    vi.mocked(createModelInstance).mockClear()
    vi.mocked(db.story.findMany).mockResolvedValue([
      { id: "story-1", title: "Existing story", summary: "s", sourceUrls: [], materials: [], createdAt: new Date() },
    ] as never)
    vi.mocked(db.inboxItem.findUnique).mockResolvedValue({
      userId: USER_ID,
      extractedTitle: "New item",
      extractedContent: "content",
      extractedUrl: null,
      rawText: "content",
    } as never)
    vi.mocked(generateText).mockResolvedValue({ text: '{"match":null,"reasoning":"none"}' } as never)

    await deps.matchItem("item-1", USER_ID)

    expect(createModelInstance).toHaveBeenCalledTimes(1)
    expect(createModelInstance.mock.calls[0][0]).toBe(STAGE_DEFAULTS.storyMatcher)
  })

  it("a missing user row fails closed to the non-admin path", async () => {
    inboxRow()
    vi.mocked(db.user.findUnique).mockResolvedValue(null as never)

    const deps = await buildPipelineDeps(USER_ID, "")
    await deps.generateStory("system", "user content")

    expect(createModelInstance.mock.calls[0][0]).toBe(STAGE_DEFAULTS.storyWriter)
    const seen = await deps.db.userSettings.findUnique({ where: { userId: USER_ID } })
    expect(seen?.storySystemPrompt).toBeNull()
  })
})
