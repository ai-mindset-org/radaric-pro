import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { sanitizeModelId as sanitizeModelField } from "@/lib/models/registry"
import { validateTypographyInput } from "@/lib/typography/prefs"
import {
  USER_PROMPT_MAX,
  STORY_SYSTEM_PROMPT_MAX,
  promptLengthError,
} from "@/lib/validations/prompt-limits"
import { toPublicUserSettings } from "@/lib/user-settings-public"
import { sealNotionToken } from "@/lib/notion-token"
import { TokenKeyError, isEncryptedToken } from "@/lib/token-crypto"

// RAD-380: every response goes through toPublicUserSettings — the Notion token
// never leaves the server, only `hasNotionToken` does.

type NotionTokenWrite =
  | { kind: "keep" }
  | { kind: "write"; value: string | null }
  | { kind: "error"; response: NextResponse }

/**
 * The token is write-only (RAD-380) and sealed at rest (RAD-221): an absent key
 * keeps the stored value, null or "" clears it, a non-empty string replaces it.
 * The form never holds the stored token, so it sends the key only on change.
 */
function notionTokenWrite(body: Record<string, unknown>, userId: string): NotionTokenWrite {
  if (!Object.hasOwn(body, "notionToken") || body.notionToken === undefined) return { kind: "keep" }
  const raw = body.notionToken
  if (raw === null) return { kind: "write", value: null }
  if (typeof raw !== "string") {
    return { kind: "error", response: NextResponse.json({ error: "notionToken must be a string" }, { status: 400 }) }
  }
  const token = raw.trim()
  if (token === "") return { kind: "write", value: null }
  if (isEncryptedToken(token)) {
    return { kind: "error", response: NextResponse.json({ error: "notionToken is not a valid Notion token" }, { status: 400 }) }
  }
  try {
    return { kind: "write", value: sealNotionToken(token, userId) }
  } catch (error) {
    if (error instanceof TokenKeyError) {
      console.error("PUT /api/user-settings - cannot store a Notion token:", error.message)
      return {
        kind: "error",
        response: NextResponse.json(
          { error: "This server cannot store integration tokens: TOKEN_ENC_KEY is missing or malformed" },
          { status: 503 },
        ),
      }
    }
    throw error
  }
}

/** Sanitizes a category array: strings only, trimmed, max 50 chars each, max 30 items, no empties. */
function sanitizeCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().slice(0, 50))
    .filter(Boolean)
    .slice(0, 30)
}

// GET /api/user-settings - Get current user's personal settings
export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    let settings = await db.userSettings.findUnique({
      where: { userId },
    })

    // Create settings record if it doesn't exist
    if (!settings) {
      settings = await db.userSettings.create({
        data: {
          userId,
          globalPrompt: null,
          notionToken: null,
          notionDatabaseId: null,
        },
      })
      console.log('Created initial user settings record for user:', userId)
    }

    return NextResponse.json(toPublicUserSettings(settings))
  } catch (error) {
    console.error("Error fetching user settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch user settings" },
      { status: 500 }
    )
  }
}

// PUT /api/user-settings - Update current user's personal settings
// SECURITY (RAD-294): `onboardingCompleted` is a ONE-WAY LATCH here as it is in
// PATCH below — only `true` is ever written. `onboardingCompleted === false`
// re-opens the time-bounded full-access demo grant (lib/subscription.ts,
// lib/entitlements.ts), and this handler is guarded by requireAuth() only, so
// accepting the client's `false` would hand any signed-in user a free reset.
// Latching one handler and not the other leaves the hole open — keep both.
export async function PUT(request: Request) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const body = await request.json()
    const { role } = authResult
    // Session role is the WRITE gate — it is what renders the settings form.
    // The read-time mask in pipeline-deps re-reads `db.user`, which is fresher,
    // so a stale token can show an admin write that lands nowhere (200, field
    // stripped below) but can never grant spend.
    const isAdmin = role === "ADMIN"

    // `notionToken` is replaced by a presence flag: the value never reaches a log.
    const { notionToken: _notionToken, ...loggableBody } = body
    console.log('PUT /api/user-settings - received body:', {
      ...loggableBody,
      notionToken: typeof body.notionToken === 'string' && body.notionToken !== '' ? '<set>' : body.notionToken === undefined ? '<absent>' : '<clear>',
      // Both prompts are capped below; the log keeps their size, not their text.
      globalPrompt: typeof body.globalPrompt === 'string' ? `<${body.globalPrompt.length} chars>` : body.globalPrompt,
      storySystemPrompt: typeof body.storySystemPrompt === 'string' ? `<${body.storySystemPrompt.length} chars>` : body.storySystemPrompt,
    })

    // Admin-only fields: reject if non-admin tries to SET them (non-null / true).
    // A form that sends these as null/false (their default/no-op value) must not be rejected.
    if (!isAdmin) {
      if (body.storyInboxChannelId != null && body.storyInboxChannelId !== "") {
        return NextResponse.json({ error: "Only admins can configure the inbox channel" }, { status: 403 })
      }
      if (body.autoDeleteTelegramMessages != null && body.autoDeleteTelegramMessages !== false) {
        return NextResponse.json({ error: "Only admins can configure auto-delete" }, { status: 403 })
      }
      if (body.storyNotionDatabaseId != null && body.storyNotionDatabaseId !== "") {
        return NextResponse.json({ error: "Only admins can configure Story Notion database" }, { status: 403 })
      }
      // Strip admin-only fields so the downstream update/create spreads never apply them
      delete body.storyInboxChannelId
      delete body.storyNotionDatabaseId
      delete body.autoDeleteTelegramMessages
      // RAD-369: the story model pickers and the story system prompt are an
      // admin entitlement too — the settings form hides them behind `isAdmin`.
      // Strip rather than 403: the form re-sends whatever GET returned, so a
      // non-admin holding a legacy value would otherwise fail every save.
      delete body.storyWriterModel
      delete body.storyMatcherModel
      delete body.materialStoryModel
      delete body.storySystemPrompt
    }

    // Validate channelId format if provided
    if (body.storyInboxChannelId && typeof body.storyInboxChannelId === 'string' && body.storyInboxChannelId.trim() !== '') {
      if (!/^-100\d{7,15}$/.test(body.storyInboxChannelId)) {
        return NextResponse.json({ error: "Invalid channel ID format. Expected: -100XXXXXXXXXX" }, { status: 400 })
      }
    }

    const tokenWrite = notionTokenWrite(body, userId)
    if (tokenWrite.kind === "error") return tokenWrite.response
    const notionTokenData = tokenWrite.kind === "write" ? { notionToken: tokenWrite.value } : {}

    // Check if settings exist
    const existingSettings = await db.userSettings.findUnique({
      where: { userId },
    })

    // RAD-369: no free-text prompt is unbounded. An over-cap value is only a
    // problem when it is a NEW one: the settings form re-sends whatever GET
    // returned, so a row that predates the cap must still save its other fields
    // (D6 leaves stored values untouched). That round-trip is dropped from the
    // write instead of rejected. `null` keeps its "clear it" meaning, and
    // `storySystemPrompt` is admin-only, so a stripped body never reaches it.
    const globalPromptError = promptLengthError("Global prompt", body.globalPrompt, USER_PROMPT_MAX)
    if (globalPromptError) {
      if (body.globalPrompt !== existingSettings?.globalPrompt) {
        return NextResponse.json({ error: globalPromptError }, { status: 400 })
      }
      delete body.globalPrompt
    }
    const storyPromptError = promptLengthError("Story system prompt", body.storySystemPrompt, STORY_SYSTEM_PROMPT_MAX)
    if (storyPromptError) {
      if (body.storySystemPrompt !== existingSettings?.storySystemPrompt) {
        return NextResponse.json({ error: storyPromptError }, { status: 400 })
      }
      delete body.storySystemPrompt
    }

    let settings
    if (existingSettings) {
      settings = await db.userSettings.update({
        where: { userId },
        data: {
          // Absent means "leave it alone" (Prisma ignores undefined, but the
          // spread also keeps a dropped over-cap round-trip out of the write).
          ...(body.globalPrompt !== undefined && { globalPrompt: body.globalPrompt }),
          ...notionTokenData,
          notionDatabaseId: body.notionDatabaseId,
          ...(body.storyInboxChannelId !== undefined && { storyInboxChannelId: body.storyInboxChannelId || null }),
          ...(body.storyNotionDatabaseId !== undefined && { storyNotionDatabaseId: body.storyNotionDatabaseId || null }),
          ...(body.storySystemPrompt !== undefined && { storySystemPrompt: body.storySystemPrompt || null }),
          ...(body.storyWriterModel !== undefined && { storyWriterModel: sanitizeModelField(body.storyWriterModel) }),
          ...(body.storyMatcherModel !== undefined && { storyMatcherModel: sanitizeModelField(body.storyMatcherModel) }),
          ...(body.materialStoryModel !== undefined && { materialStoryModel: sanitizeModelField(body.materialStoryModel) }),
          ...(body.storyLanguage !== undefined && { storyLanguage: body.storyLanguage === "ru" ? "ru" : "en" }),
          ...(typeof body.autoDeleteTelegramMessages === 'boolean' && { autoDeleteTelegramMessages: body.autoDeleteTelegramMessages }),
          ...(Array.isArray(body.globalLikedCategories) && { globalLikedCategories: sanitizeCategories(body.globalLikedCategories) }),
          ...(Array.isArray(body.globalDislikedCategories) && { globalDislikedCategories: sanitizeCategories(body.globalDislikedCategories) }),
          ...(body.onboardingCompleted === true && { onboardingCompleted: true }),
          ...(typeof body.onboardingBannerDismissed === 'boolean' && { onboardingBannerDismissed: body.onboardingBannerDismissed }),
        },
      })
    } else {
      settings = await db.userSettings.create({
        data: {
          userId,
          globalPrompt: body.globalPrompt || null,
          notionToken: tokenWrite.kind === "write" ? tokenWrite.value : null,
          notionDatabaseId: body.notionDatabaseId || null,
          // Admin-only fields are deleted from `body` above for non-admins, so these
          // spreads (including the story-four below) don't fire for them (mirrors
          // the update branch).
          ...(body.storyInboxChannelId !== undefined && { storyInboxChannelId: body.storyInboxChannelId || null }),
          ...(body.storyNotionDatabaseId !== undefined && { storyNotionDatabaseId: body.storyNotionDatabaseId || null }),
          ...(body.storySystemPrompt !== undefined && { storySystemPrompt: body.storySystemPrompt || null }),
          ...(body.storyWriterModel !== undefined && { storyWriterModel: sanitizeModelField(body.storyWriterModel) }),
          ...(body.storyMatcherModel !== undefined && { storyMatcherModel: sanitizeModelField(body.storyMatcherModel) }),
          ...(body.materialStoryModel !== undefined && { materialStoryModel: sanitizeModelField(body.materialStoryModel) }),
          storyLanguage: body.storyLanguage === "ru" ? "ru" : "en",
          ...(typeof body.autoDeleteTelegramMessages === 'boolean' && { autoDeleteTelegramMessages: body.autoDeleteTelegramMessages }),
          ...(Array.isArray(body.globalLikedCategories) && { globalLikedCategories: sanitizeCategories(body.globalLikedCategories) }),
          ...(Array.isArray(body.globalDislikedCategories) && { globalDislikedCategories: sanitizeCategories(body.globalDislikedCategories) }),
          ...(body.onboardingCompleted === true && { onboardingCompleted: true }),
          ...(typeof body.onboardingBannerDismissed === 'boolean' && { onboardingBannerDismissed: body.onboardingBannerDismissed }),
        },
      })
    }

    console.log('PUT /api/user-settings - saved settings for user:', userId)

    return NextResponse.json(toPublicUserSettings(settings))
  } catch (error) {
    console.error("Error updating user settings:", error)
    return NextResponse.json(
      { error: "Failed to update user settings" },
      { status: 500 }
    )
  }
}

// PATCH /api/user-settings - Partial update (used by onboarding)
// SECURITY: PATCH exposes only a non-admin allowlist (globalPrompt, categories,
// onboarding flags/state, typography — the RAD-363 font choice, validated by the
// strict prefs validator and never admin-only). The admin-only fields (storyInboxChannelId,
// storyNotionDatabaseId, autoDeleteTelegramMessages) are intentionally not routed
// here — add an admin guard like PUT's before ever adding one to this allowlist.
export async function PATCH(request: Request) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult
    const body = await request.json()
    // RAD-369: same cap as PUT. An unchanged over-cap value is a round-trip,
    // not a write — the settings form re-sends GET's row, and dropping it keeps
    // the rest of the save alive (same rationale as PUT).
    const globalPromptError = promptLengthError("Global prompt", body.globalPrompt, USER_PROMPT_MAX)
    if (globalPromptError) {
      const stored = await db.userSettings.findUnique({
        where: { userId },
        select: { globalPrompt: true },
      })
      if (body.globalPrompt !== stored?.globalPrompt) {
        return NextResponse.json({ error: globalPromptError }, { status: 400 })
      }
      delete body.globalPrompt
    }
    const data: Record<string, unknown> = {}
    if (body.globalPrompt !== undefined) data.globalPrompt = body.globalPrompt
    if (Array.isArray(body.globalLikedCategories)) data.globalLikedCategories = sanitizeCategories(body.globalLikedCategories)
    if (Array.isArray(body.globalDislikedCategories)) data.globalDislikedCategories = sanitizeCategories(body.globalDislikedCategories)
    // RAD-294: one-way latch — only `true` is accepted (see the PUT handler
    // above, which latches the same field for the same reason). The only
    // legitimate writers of `true` are app/onboarding/preferences/page.tsx and
    // the server-side auto-complete in lib/paywall.ts; no legitimate client
    // ever sends `false`.
    if (body.onboardingCompleted === true) data.onboardingCompleted = true
    if (typeof body.onboardingBannerDismissed === "boolean") data.onboardingBannerDismissed = body.onboardingBannerDismissed
    // null clears it (RAD-168: a revisit must not show the list from a months-old first onboarding); a Json column needs DbNull for that.
    if (body.onboardingState !== undefined) data.onboardingState = body.onboardingState === null ? Prisma.DbNull : body.onboardingState
    if (Object.hasOwn(body, "typography")) {
      const result = validateTypographyInput(body.typography)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      data.typography = result.value === null ? Prisma.DbNull : result.value
    }
    const settings = await db.userSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } })
    return NextResponse.json(toPublicUserSettings(settings))
  } catch (error) {
    console.error("Error patching user settings:", error)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
