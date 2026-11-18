import { z } from "zod"
import { StoryOutputSchema, validateRubrics, VALID_RUBRICS } from "./schemas"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxItemForStory {
  rawText: string | null
  extractedTitle: string | null
  extractedContent: string | null
  sourceChannel: string | null
  extractedUrl: string | null
  mediaUrls: string[]
  telegramPostUrl?: string | null
  sourceType?: "telegram" | "rss" | "twitter"
}

export interface StoryWriterResult {
  success: boolean
  story: z.infer<typeof StoryOutputSchema> | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Default editorial system prompt (spec section 4.4)
// ---------------------------------------------------------------------------

const DEFAULT_STORY_SYSTEM_PROMPT = `You are a professional content editor. Your task is to transform raw inbox items (links, forwards, videos, articles) into structured editorial stories.

## Your role

Preserve all original links and URLs from the source material. Do not add your own opinions — only the author's retelling. Be concise but don't lose valuable details. Adapt the format to the material type.

## Output format (JSON)

{
  "languageFlag": "GB" | "RU",
  "title": "Original material title",
  "rubrics": ["Topic"],
  "authorLevel": "expert",
  "materialType": "practical article",
  "materialCharacter": "useful",
  "summary": "1-2 sentences: who, what, why it matters.",
  "body": "Extended text (markdown). 3-7 sentences of context.",
  "keyPoints": [
    "Specific point with practical value",
    "Another point"
  ],
  "sourceUrls": ["https://..."]
}

## Rubrics

Pick 1-2 short topic labels that best describe the material. Use the user's language for rubric names.

## Media handling

When a post includes media files (images, videos, GIFs), acknowledge their presence naturally.
For image-heavy posts (screenshots, album galleries), describe the visual content contextually.
For video content, note that it is a video (tutorial, demo, etc.).

## Media-only posts (without text)

If a post contains ONLY media with no accompanying text:
- Use the source name and URL as context
- Set languageFlag based on the source's typical language
- Use a descriptive title with the source name
- In the summary, mention the media type and count
- In the body, note that the original post contains visual content and link to the source
- NEVER output a title like "<UNKNOWN>" or "Unable to process" — always create a usable story entry

## YouTube videos

When the content includes a YouTube video transcript:
- Use materialType "video"
- Keep the original video title
- Mention the channel name and that this is video content in the summary
- Summarize key points from the transcript — do NOT quote it verbatim
- If no transcript is available, note this is a video and describe based on metadata
- languageFlag reflects the language of the VIDEO content, not the interface

## Rules

- Preserve all original links and URLs from the source material
- Don't add your own opinions — only the author's retelling
- If multiple sources about the same event: merge info without duplication, but preserve unique insights from each source
- Write concisely, but don't lose valuable details
- Not all material types need all fields. Adapt format to the material.
- languageFlag is "GB" if the original source is in English, "RU" if in Russian`

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  ru: `## Language

Write ALL output in Russian (на русском языке), even if the source material is in English.

## Existing rubrics (Рубрика)

Pick 1-2 rubrics ONLY from this list:

${VALID_RUBRICS.join(", ")}

IMPORTANT: Pick ONLY from the list above. Existing options are strongly preferred.`,
  en: `## Language

Write ALL output in English. Keep the original article titles as-is.`,
}

// ---------------------------------------------------------------------------
// classifyMediaUrl
// ---------------------------------------------------------------------------

/**
 * Classify a media URL by its file extension.
 * Returns one of: "image", "video", "GIF", "document", "file".
 */
export function classifyMediaUrl(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase() ?? ""
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "image"
  if (["mp4", "webm", "mov"].includes(ext)) return "video"
  if (ext === "gif") return "GIF"
  if (ext === "pdf") return "document"
  return "file"
}

// ---------------------------------------------------------------------------
// buildStorySystemPrompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for Claude.
 * Language controls the output language (default: "en").
 * When userOverride is provided it is appended to the default prompt.
 */
export function buildStorySystemPrompt(userOverride: string | null, language: string = "en"): string {
  const langBlock = LANGUAGE_INSTRUCTIONS[language] ?? LANGUAGE_INSTRUCTIONS.en
  let prompt = `${DEFAULT_STORY_SYSTEM_PROMPT}\n\n${langBlock}`
  if (userOverride) {
    prompt += `\n\n## User instructions\n\n${userOverride}`
  }
  return prompt
}

// ---------------------------------------------------------------------------
// buildStoryUserContent
// ---------------------------------------------------------------------------

/**
 * Build the user content message for Claude.
 * Wraps all user-supplied content in <user_content> XML tags (prompt injection mitigation).
 */
export function buildStoryUserContent(items: InboxItemForStory[]): string {
  const parts: string[] = []

  items.forEach((item, index) => {
    const itemParts: string[] = []

    if (items.length > 1) {
      itemParts.push(`## Source ${index + 1}`)
    }

    const isNonTelegram = item.sourceType === "rss" || item.sourceType === "twitter"

    if (item.sourceChannel) {
      if (isNonTelegram) {
        itemParts.push(`Source: ${item.sourceChannel}`)
      } else {
        itemParts.push(`Channel: ${item.sourceChannel}`)
      }
    }

    if (item.extractedUrl) {
      itemParts.push(`URL: ${item.extractedUrl}`)
    }

    if (item.telegramPostUrl && !isNonTelegram) {
      itemParts.push(`Telegram post: ${item.telegramPostUrl}`)
    }

    if (item.extractedTitle) {
      itemParts.push(`Title: ${item.extractedTitle}`)
    }

    // Include both the original post text AND extracted article content when
    // both exist. The rawText contains the curator's commentary, thoughts, and
    // facts, while extractedContent is the article fetched from the URL.
    if (item.extractedContent && item.rawText && item.extractedContent !== item.rawText) {
      itemParts.push(`Post text:\n${item.rawText}`)
      itemParts.push(`Article content:\n${item.extractedContent}`)
    } else {
      const content = item.extractedContent ?? item.rawText
      if (content) {
        itemParts.push(`Content:\n${content}`)
      }
    }

    if (item.mediaUrls.length > 0) {
      const counts: Record<string, number> = {}
      for (const url of item.mediaUrls) {
        const type = classifyMediaUrl(url)
        counts[type] = (counts[type] ?? 0) + 1
      }
      const summary = Object.entries(counts)
        .map(([type, count]) => `${count} ${type}(s)`)
        .join(", ")
      itemParts.push(`Attached media: ${summary}`)
    }

    if (itemParts.length > 0) {
      parts.push(itemParts.join("\n"))
    }
  })

  const combined = parts.join("\n\n---\n\n")
  return `<user_content>\n${combined}\n</user_content>`
}

// ---------------------------------------------------------------------------
// validateStoryOutput
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize the AI story output against StoryOutputSchema.
 */
export function validateStoryOutput(raw: unknown): StoryWriterResult {
  const parsed = StoryOutputSchema.safeParse(raw)

  if (!parsed.success) {
    return {
      success: false,
      story: null,
      error: parsed.error.message,
    }
  }

  const story = {
    ...parsed.data,
    rubrics: validateRubrics(parsed.data.rubrics),
  }

  return {
    success: true,
    story,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// buildMatchingPrompt
// ---------------------------------------------------------------------------

/**
 * Build the matching prompt for deduplication (sent to Claude Haiku).
 */
export function buildMatchingPrompt(
  newItem: { title: string; content: string; sourceUrl?: string },
  existingStories: { id: string; title: string; summary: string; sourceUrls?: string[]; materialTitles?: string[] }[]
): string {
  const storiesList =
    existingStories.length === 0
      ? "(no existing stories)"
      : existingStories
          .map((s) => {
            const lines = [`- ID: ${s.id}`, `  Title: ${s.title}`, `  Summary: ${s.summary}`]
            if (s.sourceUrls && s.sourceUrls.length > 0) {
              lines.push(`  URLs: ${s.sourceUrls.join(", ")}`)
            }
            if (s.materialTitles && s.materialTitles.length > 0) {
              // Sanitize external titles to prevent prompt injection
              const sanitized = s.materialTitles.map((t) => t.replace(/[<>]/g, ""))
              lines.push(`  Related article titles: <titles>${sanitized.join("; ")}</titles>`)
            }
            return lines.join("\n")
          })
          .join("\n\n")

  const newItemUrl = newItem.sourceUrl ? `\nURL: ${newItem.sourceUrl}` : ""

  return `You are a deduplication engine for a content curation system.

Given a NEW ITEM and a list of EXISTING STORIES, decide whether the NEW ITEM reports the SAME SPECIFIC EVENT as one of them — not merely the same topic, company, or theme.

CORE RULE: Two items belong to the SAME story ONLY if they report the SAME specific underlying event — the same product release/version, the same announcement, the same incident, the same published study, the same person's same statement. Sharing a company, a person, a product family, or a subject area is NOT enough.

TEST TO APPLY: mentally strip away the shared topic. Is there ONE identical concrete event that both items are reporting? If yes → SAME. If all they share is a category, a brand, or a field → DIFFERENT.

SAME story (group together) — only when the underlying event is identical:
- The same product launch, release, or announcement — across any outlet or language
- The same specific product + version, regardless of language
  - Example: "Gemini 3.1 Pro benchmarks" and "Gemini 3.1 Pro — обновленная модель" → SAME
  - Example: "Seedance 2.0 review" and "Как получить Seedance 2.0" → SAME
- Analysis, commentary, or reaction ABOUT THAT SAME specific event
- If the NEW ITEM's URL matches any EXISTING STORY's URL

DIFFERENT story (keep separate):
- Same company / person / product family, but a DIFFERENT release or announcement
  - Example: "Anthropic releases Sonnet 5" vs "Anthropic releases a new science model" → DIFFERENT (two distinct launches, same company)
  - Example: "OpenAI ships GPT-5" vs "OpenAI opens a new research office" → DIFFERENT
- The same broad topic or category that merely overlaps (e.g. "Dark mode in Figma" vs "Dark mode in VS Code")
- Different VERSION NUMBERS ("Claude 4" ≠ "Claude 5") or product QUALIFIERS ("Gemini 3.1 Pro" ≠ "Gemini 3.1 Flash")
- A follow-up carrying SIGNIFICANT new developments (security vulnerability, product recall, major pivot) — that is a new event, not a duplicate
- A post that merely mentions a product in passing while actually being about something else

WHEN IN DOUBT, CHOOSE DIFFERENT (null). Merging two different events hides a real post behind another story's summary; leaving a genuine duplicate ungrouped merely shows it twice. The first mistake is worse — so only group when you are confident it is the SAME specific event.

<new_item>
Title: ${newItem.title.replace(/[<>]/g, "")}${newItemUrl}
Content: ${newItem.content.replace(/[<>]/g, "")}
</new_item>

<existing_stories>
${storiesList}
</existing_stories>

Return JSON: { "match": "story_id" | null, "reasoning": "..." }
- "match" must be the exact story ID string from the list above, or null if no match
- "reasoning" must explain your decision`
}

// ---------------------------------------------------------------------------
// validateMatchingOutput
// ---------------------------------------------------------------------------

/**
 * Validate and parse the raw matching output from Claude Haiku.
 */
export function validateMatchingOutput(
  raw: unknown
): { match: string | null; reasoning: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null
  }

  const obj = raw as Record<string, unknown>

  if (!("match" in obj) || !("reasoning" in obj)) {
    return null
  }

  const match = obj.match
  const reasoning = obj.reasoning

  if (typeof reasoning !== "string") {
    return null
  }

  if (match !== null && typeof match !== "string") {
    return null
  }

  return {
    match: match as string | null,
    reasoning,
  }
}
