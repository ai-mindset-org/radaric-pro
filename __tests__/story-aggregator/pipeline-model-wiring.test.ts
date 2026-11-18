/**
 * Story-pipeline model wiring — which model each stage gets, and which
 * credential it demands.
 *
 * Two regressions this pins:
 *
 * 1. The story writer used to fall through to `Settings.aiModel`, the FILTERING
 *    model. Production filtering runs a flash-lite model chosen for throughput on
 *    hundreds of short items a day, so the Telegram story writer — long-form prose
 *    — silently ran on it too. Nobody chose that; it fell out of a fallback chain.
 *
 * 2. Both `buildPipelineDeps` and the worker threw on a missing Anthropic key
 *    BEFORE resolving any model, so moving a stage to an OpenRouter slug still
 *    left the pipeline hostage to a credential it no longer used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { STAGE_DEFAULTS } from "@/lib/models/registry"

const createModelInstance = vi.fn(async (modelId: string) => ({ modelId }) as never)

vi.mock("@/lib/models/provider", () => ({
  createModelInstance: (...args: unknown[]) =>
    (createModelInstance as unknown as (...a: unknown[]) => unknown)(...args),
}))

const settingsFindFirst = vi.fn()
const userSettingsFindUnique = vi.fn()
const userFindUnique = vi.fn()

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: (...a: unknown[]) => settingsFindFirst(...a) },
    userSettings: { findUnique: (...a: unknown[]) => userSettingsFindUnique(...a) },
    // RAD-369: an admin role keeps these fixtures' full-override behaviour;
    // the non-admin entitlement has its own file (rad-369-settings-entitlements).
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    inboxItem: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    story: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    material: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock("ai", () => ({
  generateObject: vi.fn(async () => ({ object: { title: "t" } })),
  generateText: vi.fn(async () => ({ text: "{}" })),
}))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env = { ...ORIGINAL_ENV }
  settingsFindFirst.mockResolvedValue({ id: "s1", aiApiKey: "fake-anthropic-key", aiModel: null })
  userSettingsFindUnique.mockResolvedValue(null)
  userFindUnique.mockResolvedValue({ role: "ADMIN" })
})

async function importFresh() {
  return import("@/lib/story-aggregator/pipeline-deps")
}

describe("story writer is severed from the filtering model", () => {
  it("ignores Settings.aiModel and uses the storyWriter default", async () => {
    settingsFindFirst.mockResolvedValue({
      id: "s1",
      aiApiKey: "fake-anthropic-key",
      // The real production value: a cheap flash-lite tier picked for filtering.
      aiModel: "google/gemini-3.1-flash-lite",
    })

    const { buildPipelineDeps } = await importFresh()
    const deps = await buildPipelineDeps("user_1", "")
    await deps.generateStory("system", "user")

    expect(createModelInstance).toHaveBeenCalledTimes(1)
    expect(createModelInstance.mock.calls[0][0]).toBe(STAGE_DEFAULTS.storyWriter)
    expect(createModelInstance.mock.calls[0][0]).not.toBe("google/gemini-3.1-flash-lite")
  })

  it("still honours an explicit per-user storyWriterModel", async () => {
    settingsFindFirst.mockResolvedValue({
      id: "s1",
      aiApiKey: "fake-anthropic-key",
      aiModel: "google/gemini-3.1-flash-lite",
    })
    userSettingsFindUnique.mockResolvedValue({
      storyWriterModel: "claude-opus-4-6",
      storyMatcherModel: null,
    })

    const { buildPipelineDeps } = await importFresh()
    const deps = await buildPipelineDeps("user_1", "")
    await deps.generateStory("system", "user")

    expect(createModelInstance.mock.calls[0][0]).toBe("claude-opus-4-6")
  })
})

describe("Anthropic credential is demanded only when a resolved model needs it", () => {
  it("throws when a resolved model is direct-Anthropic and no key exists", async () => {
    delete process.env.ANTHROPIC_API_KEY
    settingsFindFirst.mockResolvedValue({ id: "s1", aiApiKey: null, aiModel: null })
    // Explicit overrides, because the stage DEFAULTS now route through
    // OpenRouter — the gate only fires for a model that actually needs the key,
    // which is the whole point of resolving before demanding a credential.
    userSettingsFindUnique.mockResolvedValue({
      storyWriterModel: "claude-opus-4-6",
      storyMatcherModel: null,
    })

    const { buildPipelineDeps } = await importFresh()

    await expect(buildPipelineDeps("user_1", "")).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it("does NOT throw when both resolved models route through OpenRouter", async () => {
    delete process.env.ANTHROPIC_API_KEY
    settingsFindFirst.mockResolvedValue({ id: "s1", aiApiKey: null, aiModel: null })
    userSettingsFindUnique.mockResolvedValue({
      storyWriterModel: "anthropic/claude-sonnet-5",
      storyMatcherModel: "deepseek/deepseek-v4-flash-0731",
    })

    const { buildPipelineDeps } = await importFresh()

    await expect(buildPipelineDeps("user_1", "")).resolves.toBeDefined()
  })

  it("passes the settings key down to the constructor for a direct-Anthropic model", async () => {
    settingsFindFirst.mockResolvedValue({ id: "s1", aiApiKey: "fake-anthropic-key-settings", aiModel: null })

    const { buildPipelineDeps } = await importFresh()
    const deps = await buildPipelineDeps("user_1", "")
    await deps.generateStory("system", "user")

    expect(createModelInstance.mock.calls[0][1]).toEqual({ anthropicApiKey: "fake-anthropic-key-settings" })
  })
})
