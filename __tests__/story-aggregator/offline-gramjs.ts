/**
 * An offline GramJS world for the worker's Telegram proxy (RAD-364).
 *
 * A REAL `StringSession` whose entity cache is filled through
 * `processEntities` (the path the worker's getDialogs warm-up takes) inside a
 * REAL `TelegramClient` that never connects. Only the network is stubbed:
 * `client.invoke` answers GetChannels / GetUsers / ResolveUsername with real
 * Api objects, and `getMessages` / `downloadProfilePhoto` are spies. The real
 * MemorySession resolution is what matters — its display-name fallback and its
 * stale username rows are what a lookup-table stub cannot model.
 */

import { vi } from "vitest"
import bigInt from "big-integer"
import { Api, TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"
import { RPCMessageToError } from "telegram/errors"

const id = (n: number) => bigInt(n) as never
const hash = (n: number) => bigInt(1000 + n) as never

// --- The operator's world -------------------------------------------------

export const OPERATOR = new Api.User({ id: id(1), accessHash: hash(1), self: true, firstName: "Operator", phone: "351900000000" } as never)
export const PERSON = new Api.User({ id: id(11), accessHash: hash(11), firstName: "Pavel", username: "pavel" } as never)
export const BOT = new Api.User({ id: id(12), accessHash: hash(12), bot: true, firstName: "Example", username: "example_bot" } as never)
export const BASIC_CHAT = new Api.Chat({ id: id(13), title: "oldgroup", participantsCount: 3, date: 0, version: 1 } as never)
export const DUROV = new Api.Channel({ id: id(20), accessHash: hash(20), title: "Durov", broadcast: true, username: "durov", photo: new Api.ChatPhotoEmpty(), date: 0 } as never)
export const PUBLIC_GROUP = new Api.Channel({ id: id(21), accessHash: hash(21), title: "Chat", megagroup: true, username: "publicchat", photo: new Api.ChatPhotoEmpty(), date: 0 } as never)
// H1(a): a private supergroup the operator is in, titled like a handle.
export const FAMILY = new Api.Channel({ id: id(22), accessHash: hash(22), title: "Family", megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0 } as never)
// H1(b): a member channel that USED to be public as @oldhandle…
export const WAS_PUBLIC = new Api.Channel({ id: id(23), accessHash: hash(23), title: "Went private", broadcast: true, username: "oldhandle", photo: new Api.ChatPhotoEmpty(), date: 0 } as never)
// …and its current state: same id, no username.
export const NOW_PRIVATE = new Api.Channel({ id: id(23), accessHash: hash(23), title: "Went private", broadcast: true, photo: new Api.ChatPhotoEmpty(), date: 0 } as never)
// A channel whose public handle is only in the collectible `usernames` list.
export const COLLECTIBLE = new Api.Channel({
  id: id(24),
  accessHash: hash(24),
  title: "Collectible",
  broadcast: true,
  usernames: [new Api.Username({ username: "Rarest", active: true }), new Api.Username({ username: "gonehandle", active: false })],
  photo: new Api.ChatPhotoEmpty(),
  date: 0,
} as never)

/** Current server-side state of every channel / user, by id. */
const CHANNELS = new Map([DUROV, PUBLIC_GROUP, FAMILY, NOW_PRIVATE, COLLECTIBLE].map((c) => [String(c.id), c]))
const USERS = new Map([OPERATOR, PERSON, BOT].map((u) => [String(u.id), u]))
/** What contacts.ResolveUsername answers today. "oldhandle" is free now. */
export const PUBLIC_HANDLES: Record<string, Api.Channel | Api.User> = {
  durov: DUROV,
  publicchat: PUBLIC_GROUP,
  pavel: PERSON,
  example_bot: BOT,
}

function notOccupied() {
  return RPCMessageToError({ errorMessage: "USERNAME_NOT_OCCUPIED", errorCode: 400 } as never, {
    className: "contacts.ResolveUsername",
  } as never)
}

/** Network stub: real request classes in, real Api answers out. */
async function network(request: unknown): Promise<unknown> {
  if (request instanceof Api.channels.GetChannels) {
    const chats = (request.id as Api.InputChannel[]).map((c) => CHANNELS.get(String(c.channelId)))
    return new Api.messages.Chats({ chats: chats.filter(Boolean) as Api.TypeChat[] })
  }
  if (request instanceof Api.users.GetUsers) {
    return (request.id as Api.InputUser[]).map((u) => USERS.get(String(u.userId)))
  }
  if (request instanceof Api.contacts.ResolveUsername) {
    const hit = PUBLIC_HANDLES[request.username.toLowerCase()]
    if (!hit) throw notOccupied()
    return hit instanceof Api.Channel
      ? new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: hit.id }), chats: [hit], users: [] })
      : new Api.contacts.ResolvedPeer({ peer: new Api.PeerUser({ userId: hit.id }), chats: [], users: [hit] })
  }
  throw new Error(`unexpected request in test: ${(request as { className?: string })?.className}`)
}

export function makeClient() {
  const session = new StringSession("")
  // Same cache the worker's getDialogs warm-up fills. Order matters for (b):
  // the stale @oldhandle row is added first, the username-less update after.
  session.processEntities({ users: [OPERATOR, PERSON, BOT], chats: [BASIC_CHAT, DUROV, PUBLIC_GROUP, FAMILY, WAS_PUBLIC] })
  session.processEntities({ chats: [NOW_PRIVATE] })
  const client = new TelegramClient(session, 1, "x", { connectionRetries: 0 })
  const invoke = vi.spyOn(client, "invoke").mockImplementation(network as never)
  const getMessages = vi.spyOn(client, "getMessages").mockImplementation((async (_peer: unknown, opts: { ids?: number[] }) =>
    opts?.ids
      ? opts.ids.map((n) => ({ id: n, message: `post ${n}`, date: 1_700_000_000 }))
      : [
          { id: 2, message: "second", date: 1_700_000_100 },
          { id: 1, message: "first", date: 1_700_000_000 },
        ]) as never)
  const downloadProfilePhoto = vi
    .spyOn(client, "downloadProfilePhoto")
    .mockImplementation((async () => Buffer.from([0xff, 0xd8, 0xff])) as never)
  return { client, invoke, getMessages, downloadProfilePhoto }
}

