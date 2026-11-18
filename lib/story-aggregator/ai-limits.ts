/**
 * Wall-clock caps for the Story Aggregator's AI calls.
 *
 * Every generateObject/generateText call in pipeline-deps.ts and worker.ts was
 * previously unbounded — no abortSignal, no maxRetries — so a hung provider
 * request wedged the story pipeline indefinitely. That is the same failure mode
 * as RAD-232 (a hung OpenRouter request froze /api/parse-stream), which is why
 * lib/ai.ts grew AI_EVAL_TIMEOUT_MS; the story paths never got the equivalent.
 *
 * Story writing produces long output and gets the larger budget; matching
 * returns a small JSON verdict. Worst-case wall clock per call is
 * TIMEOUT * (MAX_RETRIES + 1).
 */
export const STORY_GENERATION_TIMEOUT_MS = 120_000
export const STORY_MATCHING_TIMEOUT_MS = 60_000
export const STORY_AI_MAX_RETRIES = 2
