import { z } from "zod"

/**
 * Rubric values the story writer may assign. The hosted instance configures
 * its own taxonomy via STORY_RUBRICS (comma-separated); the default below is a
 * generic starter set for a fresh install.
 */
export const DEFAULT_RUBRICS = [
  "News",
  "Analysis",
  "Tools",
  "Research",
  "Opinion",
  "Tutorial",
  "Case Study",
  "Interview",
  "Roundup",
  "Fun",
] as const

function configuredRubrics(): string[] {
  const raw = process.env.STORY_RUBRICS
  if (!raw) return []
  return raw.split(",").map((r) => r.trim()).filter(Boolean)
}

const configured = configuredRubrics()

export const VALID_RUBRICS: readonly string[] =
  configured.length > 0 ? configured : DEFAULT_RUBRICS

export function validateRubrics(rubrics: string[]): string[] {
  return rubrics.filter((r) => VALID_RUBRICS.includes(r))
}

export const StoryOutputSchema = z.object({
  languageFlag: z.enum(["GB", "RU"]),
  title: z.string(),
  rubrics: z.array(z.string()).min(1).max(2),
  authorLevel: z.enum(["nouname", "beginner", "mid", "expert", "industry leader", "visionary"]),
  materialType: z.enum([
    "article",
    "essay",
    "case",
    "tool",
    "interview",
    "video",
    "news",
    "press-release",
    "practical article",
  ]),
  materialCharacter: z.enum([
    "banal",
    "interesting",
    "authorial",
    "original",
    "practical",
    "breakthrough",
    "useful",
  ]),
  summary: z.string(),
  body: z.string(),
  keyPoints: z.array(z.string()),
  sourceUrls: z.array(z.string().url()),
})

export const ArchiveLinkSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  issueNumber: z.number().optional(),
  similarity: z.number().min(0).max(1).optional(),
})

export const ArchiveLinksSchema = z.array(ArchiveLinkSchema)

export const InboxItemCreateSchema = z.object({
  userId: z.string(),
  externalId: z.string().regex(/^-\d+:\d+$/),
  messageId: z.number(),
  mediaUrls: z.array(z.string()).default([]),
  rawText: z.string().optional(),
  sourceChannel: z.string().optional(),
  forwardedFromId: z.string().optional(),
})
