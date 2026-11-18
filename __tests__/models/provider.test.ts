/**
 * createModelInstance — the single provider-construction site.
 *
 * This exists because there used to be six of these, each with its own copy of
 * the "slash means OpenRouter" branch and its own credential handling, and any
 * cross-cutting change (reasoning effort, provider data-collection policy) had to
 * be applied to all six. These assertions are what makes the next such change a
 * one-file change with a test that notices when it is wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const openrouterChat = vi.fn((id: string) => ({ provider: "openrouter", id }))
const createOpenAI = vi.fn(() => ({ chat: openrouterChat }))
const anthropicModel = vi.fn((id: string) => ({ provider: "anthropic", id }))
const createAnthropic = vi.fn(() => anthropicModel)

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: (...a: unknown[]) => createOpenAI(...(a as [])) }))
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...a: unknown[]) => createAnthropic(...(a as [])),
}))

import { createModelInstance } from "@/lib/models/provider"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

describe("OpenRouter ids", () => {
  it("builds an OpenRouter client pinned to the OpenRouter base URL", async () => {
    process.env.OPENROUTER_API_KEY = "or-key"

    const model = await createModelInstance("google/gemini-3.8-flash")

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "or-key",
        baseURL: "https://openrouter.ai/api/v1",
      })
    )
    expect(openrouterChat).toHaveBeenCalledWith("google/gemini-3.8-flash")
    expect(model).toEqual({ provider: "openrouter", id: "google/gemini-3.8-flash" })
    expect(createAnthropic).not.toHaveBeenCalled()
  })

  it("never spends the Anthropic credential on an anthropic/* OpenRouter slug", async () => {
    // "anthropic/claude-sonnet-5" is the SAME model as "claude-sonnet-5", billed
    // through a different account. Getting this branch wrong bills the wrong one.
    process.env.OPENROUTER_API_KEY = "or-key"

    await createModelInstance("anthropic/claude-sonnet-5", { anthropicApiKey: "fake-anthropic-key" })

    expect(openrouterChat).toHaveBeenCalledWith("anthropic/claude-sonnet-5")
    expect(createAnthropic).not.toHaveBeenCalled()
  })

  it("throws, naming the model, when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY

    await expect(createModelInstance("google/gemini-3.8-flash")).rejects.toThrow(
      /OPENROUTER_API_KEY.*google\/gemini-3\.8-flash/
    )
  })
})

describe("direct-Anthropic ids", () => {
  it("prefers the settings credential over the environment", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-anthropic-key-env"

    const model = await createModelInstance("claude-sonnet-4-6", { anthropicApiKey: "fake-anthropic-key-settings" })

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "fake-anthropic-key-settings" })
    expect(anthropicModel).toHaveBeenCalledWith("claude-sonnet-4-6")
    expect(model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" })
    expect(createOpenAI).not.toHaveBeenCalled()
  })

  it("falls back to ANTHROPIC_API_KEY when settings has none", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-anthropic-key-env"

    await createModelInstance("claude-sonnet-4-6", { anthropicApiKey: null })

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "fake-anthropic-key-env" })
  })

  it("treats an empty settings credential as absent rather than sending it", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-anthropic-key-env"

    await createModelInstance("claude-sonnet-4-6", { anthropicApiKey: "" })

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "fake-anthropic-key-env" })
  })

  it("throws, naming the model, when no Anthropic credential exists anywhere", async () => {
    delete process.env.ANTHROPIC_API_KEY

    await expect(createModelInstance("claude-sonnet-4-6")).rejects.toThrow(
      /ANTHROPIC_API_KEY.*claude-sonnet-4-6/
    )
  })
})

// ---------------------------------------------------------------------------
// Provider routing
//
// `provider: { data_collection: "deny" }` is an OpenRouter body field, and
// @ai-sdk/openai builds its body from a CLOSED key set — no extraBody, and an
// unknown key in providerOptions.openai is dropped by its zod parse. The fetch
// middleware is the only seam that reaches the wire, so these assertions are what
// stop a refactor from silently removing a privacy control.
// ---------------------------------------------------------------------------

describe("data-collection policy", () => {
  /** Grab the fetch middleware createModelInstance handed to the provider. */
  async function captureFetch(): Promise<typeof fetch> {
    process.env.OPENROUTER_API_KEY = "or-key"
    await createModelInstance("z-ai/glm-5.3-flash")
    const config = createOpenAI.mock.calls[0][0] as unknown as { fetch: typeof fetch }
    expect(typeof config.fetch).toBe("function")
    return config.fetch
  }

  it("adds provider.data_collection=deny to the request body", async () => {
    const patched = await captureFetch()
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))

    await patched("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [] }),
    })

    const sent = JSON.parse(String((globalFetch.mock.calls[0][1] as RequestInit).body))
    expect(sent.provider).toEqual({ data_collection: "deny" })
  })

  it("preserves the rest of the body", async () => {
    const patched = await captureFetch()
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))

    await patched("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "z-ai/glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "low",
      }),
    })

    const sent = JSON.parse(String((globalFetch.mock.calls[0][1] as RequestInit).body))
    expect(sent.model).toBe("z-ai/glm-5.3-flash")
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }])
    expect(sent.reasoning_effort).toBe("low")
  })

  it("passes a non-JSON body through untouched rather than corrupting it", async () => {
    const patched = await captureFetch()
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))

    await patched("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: "not json",
    })

    expect((globalFetch.mock.calls[0][1] as RequestInit).body).toBe("not json")
  })
})
