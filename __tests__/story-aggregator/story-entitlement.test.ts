// @vitest-environment node

/**
 * RAD-369 — the read-time story entitlement, in isolation.
 *
 * The settings UI hides the story model pickers and the story system prompt
 * behind `isAdmin`, and the PUT route strips them for everyone else. This helper
 * is the read half: a row written before that guard existed (or by an admin
 * later demoted) must not steer a non-admin's run. Both pipeline dep factories
 * and the worker's retry daemon call it, so it is tested directly rather than
 * only through them.
 */

import { describe, it, expect } from "vitest"
import { storyOverridesFor } from "@/lib/story-aggregator/story-entitlement"

const PREMIUM = "claude-opus-5"
const PROMPT = "You are the house story writer. Match and write in this voice."

const ROW = {
  userId: "user-1",
  storySystemPrompt: PROMPT,
  storyLanguage: "en",
  storyNotionDatabaseId: "notion-db-1",
}

describe("storyOverridesFor — the read-time story entitlement", () => {
  it("ADMIN keeps the stored override and the prompt", () => {
    const overrides = storyOverridesFor("ADMIN")

    expect(overrides.model(PREMIUM)).toBe(PREMIUM)
    expect(overrides.model(null)).toBeNull()
    expect(overrides.settings(ROW)).toBe(ROW)
  })

  it("USER gets no override and a null prompt", () => {
    const overrides = storyOverridesFor("USER")

    expect(overrides.model(PREMIUM)).toBeNull()
    expect(overrides.model(null)).toBeNull()
    expect(overrides.settings(ROW)?.storySystemPrompt).toBeNull()
  })

  it("an undefined role fails closed", () => {
    const overrides = storyOverridesFor(undefined)

    expect(overrides.model(PREMIUM)).toBeNull()
    expect(overrides.settings(ROW)?.storySystemPrompt).toBeNull()
  })

  it("masks on a copy — the caller's row is untouched and sibling fields survive", () => {
    const seen = storyOverridesFor("USER").settings(ROW)

    expect(seen).not.toBe(ROW)
    expect(seen?.storySystemPrompt).toBeNull()
    expect(seen?.storyLanguage).toBe("en")
    expect(seen?.storyNotionDatabaseId).toBe("notion-db-1")
    expect(ROW.storySystemPrompt).toBe(PROMPT)
  })

  it("a missing row stays null for either role", () => {
    expect(storyOverridesFor("USER").settings(null)).toBeNull()
    expect(storyOverridesFor("ADMIN").settings(null)).toBeNull()
  })
})
