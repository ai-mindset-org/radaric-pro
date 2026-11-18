import { db } from "@/lib/db"
import { isOpenRouterModel, resolveModelForStage } from "@/lib/models/registry"

/**
 * Is a given model's REQUIRED credential present? Faithful counterpart to
 * `lib/ai.ts`'s createModel(): an OpenRouter model needs the env key, a direct
 * Anthropic model needs the global Settings key or the env key. (RAD-293 — a
 * provider-blind "any key exists" check went silent in the documented
 * self-host configuration where filtering runs on an OpenRouter default.)
 */
export function isModelConfigured(modelId: string, aiApiKey: string | null | undefined): boolean {
  if (isOpenRouterModel(modelId)) return Boolean(process.env.OPENROUTER_API_KEY)
  return Boolean(aiApiKey || process.env.ANTHROPIC_API_KEY)
}

export type AiConfigStatus = {
  configured: boolean
  model: string
  requiredKey: "OPENROUTER_API_KEY" | "ANTHROPIC_API_KEY"
}

/** Status for the DEFAULT FILTERING model — what the banner and first-run rely on. */
export async function getAiConfigStatus(): Promise<AiConfigStatus> {
  const settings = await db.settings.findFirst({ select: { aiModel: true, aiApiKey: true } })
  const model = resolveModelForStage("filtering", settings?.aiModel)
  const requiredKey = isOpenRouterModel(model) ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"
  return { configured: isModelConfigured(model, settings?.aiApiKey), model, requiredKey }
}
