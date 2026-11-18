/**
 * Pure, duck-typed Telegram-media parsing for the feed parser.
 *
 * Operates on GramJS-shaped messages and `MediaResult` values WITHOUT importing
 * GramJS, so the grouping, placeholder and item-building rules are unit-testable
 * without a client. `handleParseChannel` (worker.ts) wires these onto the live
 * client. Spec: RAD-359.
 */

import { extractPollText, type MediaResult } from "./worker-helpers"
import { derivePostTitle } from "@/lib/title"

// ---------------------------------------------------------------------------
// Duck-typed message shape
// ---------------------------------------------------------------------------

/** The subset of a GramJS message this module reads. */
export interface TelegramMessageLike {
  id: number
  message?: string | null
  entities?: unknown[] | null
  media?: unknown
  groupedId?: unknown
  date?: number | null
}

/** One parsed channel item — the `/telegram/parse-channel` response shape. */
export interface ParsedChannelItem {
  title: string
  url: string
  externalId: string
  content: string
  contentEntities: unknown[]
  publishedAt: string | null
  messageId: number
  channelUsername: string
  thumbnailUrl?: string
  mediaUrls: string[]
}

/** A first-appearance-ordered unit: a lone message or a complete album. */
export type MessageUnit =
  | { kind: "single"; message: TelegramMessageLike }
  | { kind: "album"; messages: TelegramMessageLike[] }

/** Minimal duck-typed view of the GramJS media fields this module inspects. */
interface MediaLike {
  className?: string
  webpage?: { photo?: unknown } | null
  document?: {
    attributes?: Array<{ className?: string; voice?: boolean }> | null
  } | null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * A channel username out of every stored source-URL shape — `@username`,
 * `username`, `https://t.me/username`, `t.me/s/username` (the web-preview
 * form, whose leading `s` segment would otherwise become the username), with
 * any path/trailing slash dropped.
 */
export function cleanChannelUsername(input: string): string {
  let username = input.trim()
  username = username.replace(/^(?:https?:\/\/)?(?:www\.)?t\.me\//i, "")
  username = username.replace(/^s\//, "")
  username = username.replace(/^@/, "")
  username = username.replace(/^\/+|\/+$/g, "")
  return username.split("/")[0].trim()
}

function asMessage(value: unknown): TelegramMessageLike {
  return (value ?? {}) as TelegramMessageLike
}

function mediaOf(message: TelegramMessageLike | null | undefined): MediaLike | null {
  const media = message?.media
  return media && typeof media === "object" ? (media as MediaLike) : null
}

function rawText(message: TelegramMessageLike | null | undefined): string {
  const text = message?.message
  return typeof text === "string" ? text : ""
}

function pollTextOf(message: TelegramMessageLike | null | undefined): string | null {
  return message && message.media ? extractPollText(message) : null
}

function isoDate(date: unknown): string | null {
  return typeof date === "number" && Number.isFinite(date) && date > 0
    ? new Date(date * 1000).toISOString()
    : null
}

function groupIdOf(message: TelegramMessageLike | null | undefined): string | null {
  const groupedId = message?.groupedId
  return groupedId == null ? null : String(groupedId)
}

// ---------------------------------------------------------------------------
// AC-1 — grouping
// ---------------------------------------------------------------------------

/**
 * Split a flat message list into parse units: albums (members ascending by id)
 * and singles, in first-appearance order; no id is ever emitted twice.
 *
 * Every group present is kept. An id gap inside a group is a member the channel
 * deleted — the post still exists on Telegram without it, so dropping the whole
 * group would lose the post. The one real way to hold a partial album is the
 * fetch boundary, and `boundaryAlbumMembers` completes that before this runs.
 */
export function splitMessages(messages: TelegramMessageLike[]): MessageUnit[] {
  const groupMembers = new Map<string, TelegramMessageLike[]>()
  for (const message of messages) {
    const groupId = groupIdOf(message)
    if (groupId === null) continue
    const members = groupMembers.get(groupId)
    if (members) members.push(message)
    else groupMembers.set(groupId, [message])
  }

  const units: MessageUnit[] = []
  const placedGroups = new Set<string>()
  for (const message of messages) {
    const groupId = groupIdOf(message)
    if (groupId === null) {
      units.push({ kind: "single", message })
      continue
    }
    if (placedGroups.has(groupId)) continue
    placedGroups.add(groupId)
    const members = (groupMembers.get(groupId) as TelegramMessageLike[])
      .slice()
      .sort((a, b) => a.id - b.id)
    units.push({ kind: "album", messages: members })
  }
  return units
}

// ---------------------------------------------------------------------------
// AC-2 — media placeholder
// ---------------------------------------------------------------------------

/**
 * A short `[Kind]` label for a message's media, or the poll text for a poll,
 * or null when there is no/unknown media.
 */
export function mediaPlaceholder(message: TelegramMessageLike): string | null {
  const media = mediaOf(message)
  if (!media) return null

  const className = media.className
  if (className === "MessageMediaPhoto") return "[Photo]"
  if (className === "MessageMediaWebPage") {
    return media.webpage?.photo ? "[Photo]" : "[Link]"
  }
  if (className === "MessageMediaDocument") {
    const attributes = media.document?.attributes ?? []
    const has = (name: string) => attributes.some((a) => a.className === name)
    // Narrowest kind first: a video sticker also carries Video, and a GIF is
    // an mp4 carrying both Animated and Video.
    if (has("DocumentAttributeSticker")) return "[Sticker]"
    if (has("DocumentAttributeAnimated")) return "[GIF]"
    if (has("DocumentAttributeVideo")) return "[Video]"
    const audio = attributes.find((a) => a.className === "DocumentAttributeAudio")
    if (audio) return audio.voice ? "[Voice message]" : "[Audio]"
    return "[Document]"
  }
  if (className === "MessageMediaPoll") return pollTextOf(message)
  if (className === "MessageMediaGeo" || className === "MessageMediaGeoLive") return "[Location]"
  if (className === "MessageMediaVenue") return "[Venue]"
  if (className === "MessageMediaContact") return "[Contact]"
  if (className === "MessageMediaDice") return "[Dice]"
  return null
}

// ---------------------------------------------------------------------------
// AC-3 — content + entities
// ---------------------------------------------------------------------------

/**
 * The item's content: raw text (entities kept) with any poll text appended
 * after one blank line; poll text alone; the media placeholder; or the
 * `[Media message]` fallback. Entities are returned only for a raw-text prefix.
 */
export function messageContent(message: TelegramMessageLike): {
  content: string
  contentEntities: unknown[] | undefined
} {
  const text = rawText(message)
  const entities = Array.isArray(message?.entities) ? message.entities : undefined
  const poll = pollTextOf(message)

  if (text.length > 0) {
    return {
      content: poll ? `${text}\n\n${poll}` : text,
      contentEntities: entities,
    }
  }
  if (poll) return { content: poll, contentEntities: undefined }
  const placeholder = mediaPlaceholder(message)
  if (placeholder) return { content: placeholder, contentEntities: undefined }
  return { content: "[Media message]", contentEntities: undefined }
}

// ---------------------------------------------------------------------------
// AC-4 — single item
// ---------------------------------------------------------------------------

/** Build a `ParsedChannelItem` for a lone (non-album) message. */
export function buildSingleItem(
  rawMessage: unknown,
  username: string,
  media: MediaResult | null | undefined
): ParsedChannelItem {
  const message = asMessage(rawMessage)
  const { content, contentEntities } = messageContent(message)
  const title = derivePostTitle(rawText(message)) ?? `Post from @${username}`

  return {
    title,
    url: `https://t.me/${username}/${message.id}`,
    externalId: `${username}:${message.id}`,
    content,
    contentEntities: contentEntities ?? [],
    publishedAt: isoDate(message.date),
    messageId: message.id,
    channelUsername: username,
    thumbnailUrl: media?.thumbUrl ?? undefined,
    mediaUrls: media?.url ? [media.url] : [],
  }
}

// ---------------------------------------------------------------------------
// AC-5 — album item
// ---------------------------------------------------------------------------

/** Build a `ParsedChannelItem` for an album, with `results` parallel to `group`. */
export function buildAlbumItem(
  rawGroup: unknown[],
  username: string,
  results: Array<MediaResult | null | undefined>
): ParsedChannelItem {
  const ascending = rawGroup
    .map((value, index) => ({ message: asMessage(value), result: results[index] ?? null }))
    .sort((a, b) => a.message.id - b.message.id)

  const mediaUrls = ascending
    .map((pair) => pair.result?.url)
    .filter((url): url is string => url != null)

  const photoPair = ascending.find((pair) => pair.result?.type === "photo")
  const thumbnailUrl = photoPair
    ? photoPair.result?.thumbUrl ?? photoPair.result?.url ?? undefined
    : ascending
        .map((pair) => pair.result?.thumbUrl)
        .find((thumb): thumb is string => thumb != null)

  // Identity stays on the group's HIGHEST id (unchanged from the previous
  // behavior — the album's canonical post is its newest message).
  const highest = ascending[ascending.length - 1]
  const maxId = highest?.message.id ?? 0

  // Content: first member with text (its entities), else poll text, else the
  // placeholder of the first member with media, else the album fallback.
  const textPair = ascending.find((pair) => rawText(pair.message).length > 0)
  const pollPair = textPair ? null : ascending.find((pair) => pollTextOf(pair.message) !== null)
  const mediaPair =
    textPair || pollPair ? null : ascending.find((pair) => mediaPlaceholder(pair.message) !== null)

  let content: string
  let contentEntities: unknown[] | undefined = undefined
  if (textPair) {
    const parsed = messageContent(textPair.message)
    content = parsed.content
    contentEntities = parsed.contentEntities
  } else if (pollPair) {
    content = pollTextOf(pollPair.message) ?? "[Media album]"
  } else {
    content = mediaPair ? mediaPlaceholder(mediaPair.message) ?? "[Media album]" : "[Media album]"
  }

  const title = textPair
    ? derivePostTitle(rawText(textPair.message)) ?? `Album from @${username}`
    : `Album from @${username}`

  return {
    title,
    url: `https://t.me/${username}/${maxId}`,
    externalId: `${username}:${maxId}`,
    content,
    contentEntities: contentEntities ?? [],
    publishedAt: isoDate(highest?.message.date),
    messageId: maxId,
    channelUsername: username,
    thumbnailUrl,
    mediaUrls,
  }
}

// ---------------------------------------------------------------------------
// AC-6 — boundary fetch signal
// ---------------------------------------------------------------------------

/** True when the oldest fetched message belongs to an album the fetch may have cut. */
export function needsBoundaryFetch(messages: TelegramMessageLike[]): boolean {
  if (messages.length === 0) return false
  return groupIdOf(messages[messages.length - 1]) !== null
}

/**
 * The members of the album the fetch boundary cut, taken from a page of older
 * messages. Only that album's missing members — the rest of the page lies
 * outside the requested window, and turning it into items would mirror, store
 * and AI-evaluate posts nobody asked for.
 */
export function boundaryAlbumMembers(
  fetched: TelegramMessageLike[],
  older: TelegramMessageLike[]
): TelegramMessageLike[] {
  const cutGroup = fetched.length > 0 ? groupIdOf(fetched[fetched.length - 1]) : null
  if (cutGroup === null) return []
  const known = new Set(fetched.map((message) => message.id))
  return older.filter((message) => groupIdOf(message) === cutGroup && !known.has(message.id))
}

// ---------------------------------------------------------------------------
// Media mirroring across units
// ---------------------------------------------------------------------------

/**
 * Mirror every unit's media in ONE call, so the mirror's concurrency spans the
 * whole parse instead of one unit at a time, and pair each unit with its own
 * slice of the results. `mirror` answers parallel to its input; a missing
 * entry is `null` (not mirrored).
 */
export async function mirrorUnits(
  units: MessageUnit[],
  mirror: (messages: TelegramMessageLike[]) => Promise<Array<MediaResult | null>>
): Promise<Array<{ unit: MessageUnit; results: Array<MediaResult | null> }>> {
  const messages = units.flatMap((unit) => (unit.kind === "single" ? [unit.message] : unit.messages))
  const results = messages.length > 0 ? await mirror(messages) : []
  let offset = 0
  return units.map((unit) => {
    const size = unit.kind === "single" ? 1 : unit.messages.length
    const slice = Array.from({ length: size }, (_, i) => results[offset + i] ?? null)
    offset += size
    return { unit, results: slice }
  })
}

// ---------------------------------------------------------------------------
// AC-7 — media budget
// ---------------------------------------------------------------------------

/** Wall-clock budget for media mirroring, measured against a `now()` clock. */
export function createMediaBudget(
  budgetMs: number,
  now: () => number
): { hasTime(): boolean; deadlineMs: number; remainingMs(): number } {
  const deadline = now() + budgetMs
  return {
    hasTime: () => now() < deadline,
    deadlineMs: deadline,
    remainingMs: () => Math.max(0, deadline - now()),
  }
}
