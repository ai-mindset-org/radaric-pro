/**
 * Model registry — catalogue shape, stage resolution, retired-override fallback.
 *
 * Replaces __tests__/story-aggregator/model-resolver.test.ts. The resolver used
 * to expose a story-shaped `resolveStoryModels({user, user, globalAiModel})`
 * whose writer chain fell through `Settings.aiModel`; that fallback is severed
 * (the story writer is not the filtering model), so there is one generic
 * `resolveModelForStage(stage, override)` and no way to pass a global model to a
 * stage that should not have one.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ANTHROPIC_MODELS,
  OPENROUTER_MODELS,
  STAGE_DEFAULTS,
  isKnownModel,
  isOpenRouterModel,
  requiresAnthropicKey,
  resolveModelForStage,
  resolveReasoningEffort,
  buildProviderOptions,
  DEFAULT_REASONING_EFFORT,
  getModelOption,
  sanitizeModelId,
  sanitizeReasoningEffort,
  REASONING_EFFORTS,
  type ModelStage,
} from "@/lib/models/registry"

const ALL_STAGES = Object.keys(STAGE_DEFAULTS) as ModelStage[]

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe("catalogue", () => {
  it("exports non-empty lists whose entries all carry a non-empty id and label", () => {
    for (const list of [ANTHROPIC_MODELS, OPENROUTER_MODELS]) {
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBeGreaterThan(0)
      for (const model of list) {
        expect(typeof model.id).toBe("string")
        expect(model.id.length).toBeGreaterThan(0)
        expect(typeof model.label).toBe("string")
        expect(model.label.length).toBeGreaterThan(0)
      }
    }
  })

  it("has no duplicate ids across both lists", () => {
    const ids = [...ANTHROPIC_MODELS, ...OPENROUTER_MODELS].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps the two lists on the right side of the slash rule", () => {
    // The slash is not cosmetic — it selects the credential. An Anthropic-list
    // entry with a slash would be billed through OpenRouter, and an OpenRouter
    // entry without one would demand settings.aiApiKey.
    for (const m of ANTHROPIC_MODELS) expect(isOpenRouterModel(m.id)).toBe(false)
    for (const m of OPENROUTER_MODELS) expect(isOpenRouterModel(m.id)).toBe(true)
  })

  it("isKnownModel accepts every listed id and rejects anything else", () => {
    for (const m of [...ANTHROPIC_MODELS, ...OPENROUTER_MODELS]) {
      expect(isKnownModel(m.id)).toBe(true)
    }
    expect(isKnownModel("google/gemini-2.5-flash-lite")).toBe(false)
    expect(isKnownModel("totally/made-up")).toBe(false)
    expect(isKnownModel("")).toBe(false)
  })

  it("requiresAnthropicKey is exactly the non-OpenRouter half", () => {
    expect(requiresAnthropicKey("claude-sonnet-4-6")).toBe(true)
    expect(requiresAnthropicKey("anthropic/claude-sonnet-5")).toBe(false)
    expect(requiresAnthropicKey("google/gemini-3.8-flash")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stage defaults
// ---------------------------------------------------------------------------

describe("catalogue metadata", () => {
  const ALL = [...ANTHROPIC_MODELS, ...OPENROUTER_MODELS]

  it("keeps score and price plausible where they are given", () => {
    // These drive the Settings dropdown's "AAI 41.9 · $0.07 / $0.25 per 1M" line.
    // Nothing routes on them, so the failure mode is a label that lies rather
    // than a broken request — which is exactly the failure this catches.
    for (const m of ALL) {
      if (m.score !== undefined) {
        expect(m.score, m.id).toBeGreaterThan(0)
        expect(m.score, m.id).toBeLessThan(100)
      }
      if (m.priceIn !== undefined) expect(m.priceIn, m.id).toBeGreaterThan(0)
      if (m.priceOut !== undefined) expect(m.priceOut, m.id).toBeGreaterThan(0)
      // Prices come as a pair or not at all — a half-filled pair renders as a
      // silently missing price rather than a visible gap.
      expect(m.priceIn === undefined, m.id).toBe(m.priceOut === undefined)
    }
  })

  it("getModelOption round-trips every listed id and returns undefined otherwise", () => {
    for (const m of ALL) expect(getModelOption(m.id)?.id).toBe(m.id)
    expect(getModelOption("some-lab/unreleased-model")).toBeUndefined()
  })

  it("puts the score-per-cent leader at the top of the OpenRouter list", () => {
    // The list order IS the dropdown order, and the first rows are the ones a
    // human scans. Whatever the defaults are, they should be reachable without
    // scrolling past two dozen worse-value options.
    const defaults = new Set(Object.values(STAGE_DEFAULTS))
    const topThree = OPENROUTER_MODELS.slice(0, 3).map((m) => m.id)
    expect(topThree.some((id) => defaults.has(id))).toBe(true)
  })
})

describe("STAGE_DEFAULTS", () => {
  it("covers every stage with an id that is in the catalogue", () => {
    expect(ALL_STAGES.length).toBeGreaterThan(0)
    for (const stage of ALL_STAGES) {
      expect(isKnownModel(STAGE_DEFAULTS[stage])).toBe(true)
    }
  })

  it("defaults to models that actually accept a reasoning effort", () => {
    // The whole point of DEFAULT_REASONING_EFFORT is that it takes effect. A
    // default whose model advertises no reasoning_effort would silently run at
    // the provider's own setting while the UI claimed otherwise.
    for (const stage of ALL_STAGES) {
      const option = getModelOption(STAGE_DEFAULTS[stage])
      expect(option, `${stage} default is not in the catalogue`).toBeDefined()
      expect(option?.supportsReasoningEffort, `${stage} default takes no effort`).toBe(true)
      expect(buildProviderOptions(STAGE_DEFAULTS[stage])).toEqual({
        openai: { reasoningEffort: DEFAULT_REASONING_EFFORT },
      })
    }
  })

  it("defaults to OpenRouter, so no stage is hostage to the Anthropic key", () => {
    // The credential gate resolves models first and only then demands a key.
    // With every default on OpenRouter, a missing ANTHROPIC_API_KEY stops
    // nothing until somebody explicitly picks a direct-Anthropic model.
    for (const stage of ALL_STAGES) {
      expect(requiresAnthropicKey(STAGE_DEFAULTS[stage]), `${stage}`).toBe(false)
    }
  })

  it("keeps the story writer separate from the filtering model", () => {
    // Severed deliberately: the writer used to inherit Settings.aiModel, which is
    // how the Telegram story writer silently ended up on a flash-lite filtering
    // model. They may hold the same value, but neither derives from the other.
    expect(STAGE_DEFAULTS.storyWriter).toBeTypeOf("string")
    expect(STAGE_DEFAULTS.filtering).toBeTypeOf("string")
  })
})

// ---------------------------------------------------------------------------
// resolveModelForStage
// ---------------------------------------------------------------------------

describe("resolveModelForStage", () => {
  it("returns the stage default when there is no override", () => {
    for (const stage of ALL_STAGES) {
      expect(resolveModelForStage(stage)).toBe(STAGE_DEFAULTS[stage])
      expect(resolveModelForStage(stage, null)).toBe(STAGE_DEFAULTS[stage])
      expect(resolveModelForStage(stage, undefined)).toBe(STAGE_DEFAULTS[stage])
    }
  })

  it("treats an empty or whitespace-only override as no override", () => {
    expect(resolveModelForStage("storyWriter", "")).toBe(STAGE_DEFAULTS.storyWriter)
    expect(resolveModelForStage("storyWriter", "   ")).toBe(STAGE_DEFAULTS.storyWriter)
  })

  it("honours an override that is a currently offered model", () => {
    expect(resolveModelForStage("storyWriter", "claude-opus-4-6")).toBe("claude-opus-4-6")
    expect(resolveModelForStage("materialStory", OPENROUTER_MODELS[0].id)).toBe(
      OPENROUTER_MODELS[0].id
    )
  })

  it("resolves each stage independently — one override does not leak into another", () => {
    expect(resolveModelForStage("storyWriter", "claude-opus-4-6")).toBe("claude-opus-4-6")
    expect(resolveModelForStage("storyMatcher")).toBe(STAGE_DEFAULTS.storyMatcher)
    expect(resolveModelForStage("filtering")).toBe(STAGE_DEFAULTS.filtering)
  })
})

// ---------------------------------------------------------------------------
// Retired overrides
//
// Stored overrides outlive the dropdown. A prod account really did hold
// "google/gemini-2.5-flash-lite" (announced shutdown 2026-10-16) as its story
// matcher; once the entry is removed the id stays in user_settings, and the
// provider answers a retired id with a hard error rather than a fallback.
// ---------------------------------------------------------------------------

describe("retired overrides", () => {
  const RETIRED = "google/gemini-2.5-flash-lite"

  it("falls back to the stage default rather than handing a retired id to a provider", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const stage of ALL_STAGES) {
      expect(resolveModelForStage(stage, RETIRED)).toBe(STAGE_DEFAULTS[stage])
    }
  })

  it("warns, naming both the dropped value and the stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    resolveModelForStage("storyMatcher", RETIRED)

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain(RETIRED)
    expect(message).toContain("storyMatcher")
  })

  it("does not warn for a valid override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    resolveModelForStage("storyWriter", "claude-opus-4-6")

    expect(warn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

describe("resolveReasoningEffort", () => {
  it("accepts every value the SDK's zod enum accepts", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(resolveReasoningEffort(effort)).toBe(effort)
    }
  })

  it("normalises case and surrounding whitespace", () => {
    expect(resolveReasoningEffort("  LOW ")).toBe("low")
  })

  it("returns null — 'no explicit choice' — when unset", () => {
    // Null is not an effort, and this function does NOT apply the default: it
    // normalises a stored value, and buildProviderOptions decides what an absent
    // one means. Keeping the two separate is what lets an explicit "none" mean
    // something different from an empty column.
    expect(resolveReasoningEffort(null)).toBeNull()
    expect(resolveReasoningEffort(undefined)).toBeNull()
    expect(resolveReasoningEffort("")).toBeNull()
    expect(resolveReasoningEffort("   ")).toBeNull()
  })

  it("drops a value the provider would reject, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(resolveReasoningEffort("turbo")).toBeNull()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("turbo")
  })
})

describe("buildProviderOptions", () => {
  it("uses the SDK's camelCase key, not the snake_case wire name", () => {
    // providerOptions.openai is parsed by a zod schema that knows `reasoningEffort`;
    // `reasoning_effort` is what the SDK EMITS and is dropped if passed in.
    expect(buildProviderOptions("google/gemini-3.8-flash", { reasoningEffort: "low" })).toEqual({
      openai: { reasoningEffort: "low" },
    })
  })

  it("returns undefined for a direct-Anthropic model even when an effort is set", () => {
    // An openai-namespaced block reaching createAnthropic is ignored at best and
    // a 400 at worst.
    expect(buildProviderOptions("claude-sonnet-4-6", { reasoningEffort: "high" })).toBeUndefined()
  })

  it("falls back to DEFAULT_REASONING_EFFORT when nothing is stored", () => {
    // The absent case is "think hard", not "send nothing". Reasoning tokens bill
    // at the output rate, and the default model's output rate is $0.25/1M, so the
    // setting that used to be the expensive part of the bill is now free enough
    // to leave on everywhere.
    expect(buildProviderOptions("google/gemini-3.8-flash")).toEqual({
      openai: { reasoningEffort: DEFAULT_REASONING_EFFORT },
    })
    expect(buildProviderOptions("google/gemini-3.8-flash", { reasoningEffort: null })).toEqual({
      openai: { reasoningEffort: DEFAULT_REASONING_EFFORT },
    })
  })

  it("defaults to high — not xhigh, which no catalogue model advertises", () => {
    // The SDK's zod enum accepts xhigh, but it is documented as a GPT-5.1-Codex-Max
    // value; an unrecognised effort is DROPPED by OpenRouter, which would silently
    // leave the stage at the provider's own default instead of the maximum.
    expect(DEFAULT_REASONING_EFFORT).toBe("high")
  })

  it("sends no effort to a model that does not accept the parameter", () => {
    // Read off supported_parameters, not guessed: Claude Haiku 4.5, GLM-4.7 and
    // Qwen 3.5 take no reasoning_effort, and Gemini 2.5 Pro takes none either.
    for (const id of [
      "anthropic/claude-haiku-4.5",
      "z-ai/glm-4.7",
      "qwen/qwen3.5-27b",
      "google/gemini-2.5-pro",
    ]) {
      expect(buildProviderOptions(id, { reasoningEffort: "high" })).toBeUndefined()
    }
  })

  it("sends no effort for an id outside the catalogue — unknown capability", () => {
    expect(buildProviderOptions("some-lab/unreleased-model", { reasoningEffort: "high" })).toBeUndefined()
  })

  it("honours an explicit effort over the default", () => {
    expect(buildProviderOptions("z-ai/glm-5.3-flash", { reasoningEffort: "minimal" })).toEqual({
      openai: { reasoningEffort: "minimal" },
    })
  })
})

// ---------------------------------------------------------------------------
// Write-time validation
//
// Stricter than the read-time resolver on purpose: reject on the way in so a bad
// value never reaches the column, tolerate on the way out so the UI can still
// show a user that their saved choice was retired.
// ---------------------------------------------------------------------------

describe("sanitizeModelId", () => {
  it("accepts a listed id", () => {
    expect(sanitizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(sanitizeModelId(OPENROUTER_MODELS[0].id)).toBe(OPENROUTER_MODELS[0].id)
  })

  it("returns null for an unlisted id, an empty string, or a non-string", () => {
    expect(sanitizeModelId("google/gemini-2.5-flash-lite")).toBeNull()
    expect(sanitizeModelId("")).toBeNull()
    expect(sanitizeModelId(null)).toBeNull()
    expect(sanitizeModelId(undefined)).toBeNull()
    expect(sanitizeModelId(42)).toBeNull()
    expect(sanitizeModelId({ id: "claude-sonnet-4-6" })).toBeNull()
  })
})

describe("sanitizeReasoningEffort", () => {
  it("accepts a supported effort", () => {
    expect(sanitizeReasoningEffort("low")).toBe("low")
  })

  it("returns null for anything else", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(sanitizeReasoningEffort("turbo")).toBeNull()
    expect(sanitizeReasoningEffort("")).toBeNull()
    expect(sanitizeReasoningEffort(null)).toBeNull()
    expect(sanitizeReasoningEffort(3)).toBeNull()
  })
})
