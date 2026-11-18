/**
 * The worker's Telegram proxy handlers — `/telegram/parse-channel` and
 * `/telegram/channel-info` — lifted out of worker.ts so they can be exercised
 * with a stub client. worker.ts self-starts at import (`main()` at module
 * scope), so nothing inside it is reachable from a test.
 *
 * The client is the worker's one live GramJS session (the operator's own
 * account); these functions receive it as a parameter and never create one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- GramJS has no exported types for entities and messages */

import { downloadMediaBatch, type MediaResult } from "./worker-helpers"
import {
  splitMessages,
  buildSingleItem,
  buildAlbumItem,
  needsBoundaryFetch,
  boundaryAlbumMembers,
  mirrorUnits,
  createMediaBudget,
  cleanChannelUsername,
  type ParsedChannelItem,
} from "./telegram-media"
import { utils as gramUtils } from "telegram"
import { uploadBufferToR2 } from "../blob-storage"
import {
  classifyEntity,
  isUsernameNotFoundError,
  NOT_FOUND_MARKER,
  UNSUPPORTED_MARKER,
  type TelegramKind,
} from "../telegram-kind"
import { isPublicTelegramUsername, isTelegramInviteLink, normalizeTelegramInput } from "../validations/feed"

const MEDIA_BUDGET_MS = 75_000 // stop mirroring media well before the 120s Telegram client timeout (lib/parsers/telegram.ts)
const MEDIA_CONCURRENCY = 3 // the feed parse mirrors videos too; fewer live 50MB buffers than the inbox path's 5

/** An HTTP answer the worker writes as-is: JSON for objects, text for strings. */
interface ProxyResponse {
  status: number
  body: Record<string, unknown> | string
}

// ---------------------------------------------------------------------------
// Source gate (RAD-364)
// ---------------------------------------------------------------------------

/**
 * A feed reference the worker will not read. The session is the operator's
 * own Telegram account: GramJS resolves "me"/"self"/"this" to its Saved
 * Messages, a "+<phone>" against its contacts, a numeric string as a cached
 * peer id, and a person's @username to the operator's DM history with them.
 * Only a PUBLIC channel or supergroup that owns the requested handle is ever
 * read.
 */
class UnsupportedTelegramSourceError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramKind
  ) {
    super(message)
    this.name = "UnsupportedTelegramSourceError"
  }
}

/**
 * The public @username a stored feed reference names — or a refusal. Anything
 * that is not a plain public username (phone, peer id, self alias, invite
 * link) never reaches GramJS at all.
 */
function vettedUsername(ref: string): string {
  if (isTelegramInviteLink(ref)) {
    throw new UnsupportedTelegramSourceError(
      "Private invite links can't be read — add the channel's public t.me/<name> link instead",
      "unknown"
    )
  }
  // cleanChannelUsername first, so every reference that parsed before keeps
  // the exact same label (item URLs and R2 keys are built from it).
  const cleaned = cleanChannelUsername(ref)
  if (isPublicTelegramUsername(cleaned)) return cleaned
  const normalized = normalizeTelegramInput(ref)
  if (normalized) return normalized.slice("https://t.me/".length)
  throw new UnsupportedTelegramSourceError(`"${ref}" is not a public Telegram channel`, "unknown")
}

/** The kind each non-channel InputPeer stands for, for the refusal message. */
const INPUT_PEER_KIND: Record<string, TelegramKind> = {
  InputPeerSelf: "user",
  InputPeerUser: "user",
  InputPeerChat: "group",
}

/** Does this fresh Channel publicly own `username` (primary or active collectible)? */
function ownsHandle(entity: any, username: string): boolean {
  if (entity?.className !== "Channel") return false
  const wanted = username.toLowerCase()
  const handles = [
    entity.username,
    ...((entity.usernames ?? []) as Array<{ username?: string; active?: boolean }>)
      .filter((u) => u.active)
      .map((u) => u.username),
  ]
  return handles.some((h) => typeof h === "string" && h.toLowerCase() === wanted)
}

/** A refusal naming what the non-channel peer is — a bot vs a person matters to the probe. */
async function notAChannel(client: any, username: string, peer: any): Promise<UnsupportedTelegramSourceError> {
  let kind: TelegramKind = INPUT_PEER_KIND[peer?.className] ?? "unknown"
  if (peer?.className === "InputPeerUser") {
    // users.GetUsers by id — cheap, and only the bot flag is used.
    try {
      kind = classifyEntity(await client.getEntity(peer))
    } catch {
      // keep "user"
    }
  }
  return new UnsupportedTelegramSourceError(`@${username} is not a Telegram channel (it is a ${kind})`, kind)
}

/**
 * Resolve a feed reference to a PUBLIC channel or supergroup that owns the
 * handle, and the InputPeer every read goes through.
 *
 * The session cache is not proof of that. MemorySession.getInputEntity tries
 * phone, username, id — and then an EXACT DISPLAY-NAME match over every
 * dialog the worker's getDialogs warm-up cached, so "t.me/Family" can land on
 * the operator's private group titled "Family". Its rows also go stale: the
 * entity set only grows, so a channel that dropped its username is still found
 * under the old one. So the cached InputPeer only says WHICH entity to ask
 * about; channels.GetChannels (by id — not the flood-limited ResolveUsername)
 * says what it is NOW, and it must own the handle. On a mismatch, Telegram's
 * own ResolveUsername gets one say, so a channel whose handle moved isn't
 * refused until the next restart.
 */
async function resolveReadableChannel(client: any, ref: string): Promise<{ username: string; entity: any; peer: any }> {
  const username = vettedUsername(ref)
  const cached = await client.getInputEntity(username)
  if (cached?.className !== "InputPeerChannel") throw await notAChannel(client, username, cached)

  let entity = await client.getEntity(cached)
  if (!ownsHandle(entity, username)) {
    try {
      entity = await client.getEntity(username)
    } catch (err) {
      // Telegram says nobody holds the handle any more: the cached channel
      // went private or renamed. A refusal, not a server error.
      if (isUsernameNotFoundError(err)) {
        throw new UnsupportedTelegramSourceError(`@${username} is not a public Telegram channel`, "unknown")
      }
      throw err
    }
    if (entity?.className !== "Channel") {
      const kind = classifyEntity(entity ?? {})
      throw new UnsupportedTelegramSourceError(`@${username} is not a Telegram channel (it is a ${kind})`, kind)
    }
    if (!ownsHandle(entity, username)) {
      throw new UnsupportedTelegramSourceError(`@${username} is not a public Telegram channel`, "unknown")
    }
  }
  return { username, entity, peer: gramUtils.getInputPeer(entity) }
}

function refusal(err: UnsupportedTelegramSourceError): ProxyResponse {
  return { status: 422, body: { error: UNSUPPORTED_MARKER, kind: err.kind, message: err.message } }
}

/**
 * `/telegram/channel-info` — name, kind and (optionally) the cover photo for a
 * username. Error mapping is part of the contract: see the comments below.
 */
export async function channelInfo(
  client: any,
  rawUsername: string,
  includePhoto: boolean
): Promise<ProxyResponse> {
  let username: string
  try {
    username = vettedUsername(rawUsername)
  } catch (err) {
    if (err instanceof UnsupportedTelegramSourceError) return refusal(err)
    throw err
  }
  try {
    // Refuses before anything about the entity — name, photo — is read.
    const { entity, peer } = await resolveReadableChannel(client, username)
    const name = ("title" in entity ? (entity.title as string) : username) || username
    const description = "about" in entity ? (entity.about as string | undefined) : undefined
    // "channel" or "megagroup" — anything else was refused above.
    const kind = classifyEntity(entity as { className?: string; bot?: boolean; megagroup?: boolean })

    let photoUrl: string | undefined
    if (includePhoto) {
      try {
        const photoBuffer = await client.downloadProfilePhoto(peer)
        if (photoBuffer && Buffer.isBuffer(photoBuffer) && photoBuffer.length > 0) {
          const key = `source-covers/telegram/${username}.jpg`
          photoUrl = await uploadBufferToR2(key, photoBuffer, "image/jpeg")
          console.log(`[Worker] Uploaded channel photo for ${username}: ${photoUrl}`)
        }
      } catch (photoErr) {
        console.error(`[Worker] Failed to download/upload channel photo for ${username}:`, photoErr)
        // Non-fatal — continue without photo
      }
    }

    return { status: 200, body: { name, description, kind, ...(photoUrl ? { photoUrl } : {}) } }
  } catch (err: unknown) {
    if (err instanceof UnsupportedTelegramSourceError) return refusal(err)
    // GramJS RPCErrors carry a code on .errorMessage, but for CLASSED errors
    // it's a coarse bucket, not the detail: FloodWaitError.errorMessage is
    // "FLOOD" and only .message carries "A wait of 42 seconds is required".
    // Log both, or the one number worth having is the one we throw away.
    const rpcCode = (err as { errorMessage?: string })?.errorMessage
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Worker] /telegram/channel-info error: ${rpcCode ? `[${rpcCode}] ` : ""}${msg}`)
    // "No such username" is a fact about the input, so it gets its own
    // status AND an explicit marker in the body — callers may reject on it.
    // The marker is what makes it distinguishable from this server's own
    // route-fallthrough 404 ("wrong worker"), which must fail open.
    // Everything else (FLOOD_WAIT, CHANNEL_PRIVATE, auth, network) stays 500
    // and means "we don't know", never grounds to reject a source.
    if (isUsernameNotFoundError(err)) {
      return { status: 404, body: { error: NOT_FOUND_MARKER, message: msg } }
    }
    return { status: 500, body: msg }
  }
}

/**
 * `/telegram/parse-channel` as an HTTP answer: a refusal is a 422 with a plain
 * message (the parser's fetchWorkerWithRetry does not retry a 4xx, and the
 * parse route records the text as the feed's error); anything else unexpected
 * stays a 500.
 */
export async function parseChannelResponse(
  client: any,
  payload: { channelUsername?: unknown; limit?: unknown; skipMedia?: unknown; messageIds?: unknown }
): Promise<ProxyResponse> {
  const { channelUsername, limit, skipMedia = false, messageIds } = payload
  if (!channelUsername || typeof channelUsername !== "string") {
    return { status: 400, body: "Missing channelUsername" }
  }
  // The body is caller input: bound what one request can make the session fetch.
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit as number, 1), 100) : 20
  const ids = Array.isArray(messageIds)
    ? (messageIds as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, 200)
    : undefined
  try {
    const items = await handleParseChannel(client, channelUsername, boundedLimit, skipMedia === true, ids)
    return { status: 200, body: { items } }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Worker] /telegram/parse-channel error: ${msg}`)
    return { status: err instanceof UnsupportedTelegramSourceError ? 422 : 500, body: msg }
  }
}

/** `/telegram/parse-channel` — the latest (or the given) messages of a channel. */
export async function handleParseChannel(
  client: any,
  channelUsername: string,
  limit: number,
  skipMedia: boolean,
  messageIds?: number[]
): Promise<ParsedChannelItem[]> {
  const startTime = Date.now()

  if (!channelUsername.trim()) throw new Error("Channel username cannot be empty")

  // Every read below goes through the verified `peer`, never the raw string (RAD-364).
  const { username, peer } = await resolveReadableChannel(client, channelUsername)

  console.log(
    `[Worker TG Proxy] Parsing "${username}", limit=${limit}, skipMedia=${skipMedia}` +
      (messageIds?.length ? `, ids=${messageIds.join(",")}` : "")
  )

  let messages: any[]
  if (messageIds?.length) {
    // Targeted re-mirror (the operator re-mirror script): fetch exact
    // messages, then complete any album an id falls into — a stored album
    // material carries the group's HIGHEST id, so the members are fetched
    // as the 10 messages at and below it (Telegram albums cap at 10).
    // Deleted/empty messages come back as `undefined` holes — drop them before
    // anything dereferences an id (the remirror script legitimately asks for
    // ids that may no longer exist).
    messages = ((await client.getMessages(peer, { ids: messageIds })) as any[]).filter(Boolean)
    const groups = new Map<string, any>()
    for (const message of messages) {
      if (message?.groupedId) {
        const groupId = message.groupedId.toString()
        const anchor = groups.get(groupId)
        if (!anchor || message.id > anchor.id) groups.set(groupId, message)
      }
    }
    const known = new Set(messages.map((m: any) => m.id))
    for (const [groupId, anchor] of groups) {
      const older = await client.getMessages(peer, { limit: 10, maxId: anchor.id + 1 })
      for (const message of older) {
        if (message.groupedId?.toString() === groupId && !known.has(message.id)) {
          known.add(message.id)
          messages.push(message)
        }
      }
    }
  } else {
    messages = await client.getMessages(peer, { limit })

    // A fetch boundary can cut an album in half — one extra fetch of older
    // messages completes it (an album holds at most 10). Only the cut album's
    // members are kept; a failed fetch keeps the partial album rather than the
    // whole parse.
    if (needsBoundaryFetch(messages)) {
      const oldest = messages[messages.length - 1]
      try {
        const older = await client.getMessages(peer, { limit: 10, maxId: oldest.id })
        messages.push(...boundaryAlbumMembers(messages, older))
      } catch (error) {
        console.warn(
          `[Worker TG Proxy] Boundary fetch below ${oldest.id} failed — keeping the partial album:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  console.log(`[Worker TG Proxy] Fetched ${messages.length} messages in ${Date.now() - startTime}ms`)

  // Wall-clock budget for media mirroring: the Telegram client times out at
  // 120s (lib/parsers/telegram.ts), so stop downloading well before then.
  const budget = createMediaBudget(MEDIA_BUDGET_MS, Date.now)

  /**
   * Mirror the parse's media inside the budget, as one batch so the
   * concurrency spans every post rather than one post at a time. The race is
   * the hard cap the deadline alone cannot give: a pathological download +
   * retry chain (60s timeout × up to 4 attempts per file) can outlive the
   * whole budget, and the worker must answer the 120s HTTP call before the
   * client gives up. Whatever finished by then is kept; in-flight downloads
   * are not abortable and finish in the background, their posts text-only
   * for this parse (a re-parse backfills them).
   */
  async function mirrorMedia(batchMessages: any[]): Promise<Array<MediaResult | null>> {
    const settled: Array<MediaResult | null> = batchMessages.map(() => null)
    if (skipMedia || !budget.hasTime()) return settled
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget.remainingMs())
    })
    try {
      await Promise.race([
        downloadMediaBatch(client, batchMessages, username, {
          concurrency: MEDIA_CONCURRENCY,
          deadline: budget.deadlineMs,
          onResult: (index, result) => {
            settled[index] = result
          },
        }),
        capped,
      ])
    } finally {
      clearTimeout(timer)
    }
    return settled.slice()
  }

  const units = splitMessages(messages).filter(
    (unit) => unit.kind === "album" || unit.message.message || unit.message.media
  )

  const items: ParsedChannelItem[] = []
  for (const { unit, results } of await mirrorUnits(units, mirrorMedia)) {
    items.push(
      unit.kind === "single"
        ? buildSingleItem(unit.message, username, results[0])
        : buildAlbumItem(unit.messages, username, results)
    )
  }

  console.log(`[Worker TG Proxy] Parsed ${items.length} items in ${Date.now() - startTime}ms`)
  return items
}
