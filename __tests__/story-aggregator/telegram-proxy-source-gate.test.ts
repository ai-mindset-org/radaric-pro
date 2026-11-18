/**
 * RAD-364 — the worker's Telegram proxy must only ever read a PUBLIC channel
 * that owns the handle it was asked for.
 *
 * The worker's GramJS client is the operator's own Telegram account. A feed URL
 * is user input, so every path that reads Telegram on a feed's behalf has to
 * resolve the reference and refuse anything that isn't a public channel or
 * supergroup before a single message or profile photo is fetched.
 *
 * These tests run the REAL GramJS resolution over an offline client (see
 * ./offline-gramjs.ts): a real StringSession cache, a real TelegramClient, only
 * the network stubbed. A lookup-table stub cannot model what made review
 * round 1 fail: MemorySession.getInputEntity falls back to an EXACT
 * DISPLAY-NAME match, and it keeps stale username rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Api } from "telegram"

vi.mock("@/lib/blob-storage", () => ({
  uploadBufferToR2: vi.fn(async (key: string) => `https://cdn.example/${key}`),
  uploadTelegramMedia: vi.fn(),
  uploadTelegramThumb: vi.fn(),
}))

import { uploadBufferToR2 } from "@/lib/blob-storage"
import { channelInfo, parseChannelResponse } from "@/lib/story-aggregator/telegram-proxy"
import { makeClient, PUBLIC_HANDLES, COLLECTIBLE } from "./offline-gramjs"

let t: ReturnType<typeof makeClient>
beforeEach(() => {
  vi.clearAllMocks()
  t = makeClient()
})

const parse = (channelUsername: string, extra: Record<string, unknown> = {}) =>
  parseChannelResponse(t.client, { channelUsername, limit: 20, skipMedia: true, ...extra })

/** Nothing about the operator's account may have been read. */
function expectNothingRead() {
  expect(t.getMessages).not.toHaveBeenCalled()
  expect(t.downloadProfilePhoto).not.toHaveBeenCalled()
  expect(uploadBufferToR2).not.toHaveBeenCalled()
}

/** The peer every read went through, as a marked id. */
function readPeerIds() {
  return t.getMessages.mock.calls.map(([peer]) => String((peer as Api.InputPeerChannel).channelId))
}

// --- H1: the cache is not proof of a public handle ---------------------------

describe("H1 — a cached entity must publicly own the handle it was reached by", () => {
  it("(a) a private supergroup reached by its DISPLAY NAME is refused", async () => {
    // MemorySession.getInputEntity("Family"): no username row, no id → exact
    // display-name match → InputPeerChannel of the private group.
    const answer = await parse("https://t.me/Family")
    expect(answer.status).toBe(422)
    expectNothingRead()
  })

  it("(a) …and channel-info won't describe it either", async () => {
    const answer = await channelInfo(t.client, "Family", true)
    expect(answer.status).toBe(422)
    expectNothingRead()
  })

  it("(b) a channel that went private is refused under its old handle", async () => {
    // _entities is a Set: the username-less update ADDED a row, and the
    // username lookup still finds the stale @oldhandle one.
    const answer = await parse("https://t.me/oldhandle")
    expect(answer.status).toBe(422)
    expectNothingRead()
  })

  it("(b) …on the messageIds re-mirror branch too", async () => {
    const answer = await parse("https://t.me/oldhandle", { messageIds: [1, 2] })
    expect(answer.status).toBe(422)
    expectNothingRead()
  })

  it("(c) a public channel that owns the handle is read — through the verified peer", async () => {
    const answer = await parse("https://t.me/durov")
    expect(answer.status).toBe(200)
    expect((answer.body as { items: Array<{ url: string }> }).items.map((i) => i.url)).toEqual([
      "https://t.me/durov/2",
      "https://t.me/durov/1",
    ])
    expect(readPeerIds()).toEqual(["20"])
    expect(t.getMessages.mock.calls[0][0]).toBeInstanceOf(Api.InputPeerChannel)
  })

  it("(c) the handle match is case-insensitive and honours the active collectible usernames", async () => {
    expect((await parse("https://t.me/Durov")).status).toBe(200)
    // @Rarest is not cached: ResolveUsername finds it, GetChannels confirms it
    // owns "rarest" through the collectible list (its `username` is empty).
    PUBLIC_HANDLES.rarest = COLLECTIBLE
    try {
      expect((await parse("https://t.me/rarest")).status).toBe(200)
      expect(readPeerIds().at(-1)).toBe("24")
    } finally {
      delete PUBLIC_HANDLES.rarest
    }
    // An inactive username is not ownership, even if a lookup lands on the channel.
    t.getMessages.mockClear()
    PUBLIC_HANDLES.gonehandle = COLLECTIBLE
    try {
      expect((await parse("https://t.me/gonehandle")).status).toBe(422)
    } finally {
      delete PUBLIC_HANDLES.gonehandle
    }
    expect(t.getMessages).not.toHaveBeenCalled()
  })

  it("a public supergroup that owns its handle is still readable", async () => {
    const answer = await parse("https://t.me/publicchat")
    expect(answer.status).toBe(200)
    expect(readPeerIds()).toEqual(["21"])
  })

  it("a handle neither the cache nor Telegram knows fails without a read", async () => {
    const answer = await parse("https://t.me/durov2")
    expect(answer.status).toBe(500)
    expectNothingRead()
  })
})

// --- Everything that is not a channel ---------------------------------------

const REFUSED: Array<[string, string]> = [
  ["me", "the operator's Saved Messages"],
  ["self", "the operator's Saved Messages"],
  ["this", "the operator's Saved Messages"],
  ["https://t.me/me", "Saved Messages, URL form"],
  ["https://t.me/self", "Saved Messages, URL form"],
  ["https://t.me/THIS", "Saved Messages, case-folded by GramJS"],
  ["+351900000000", "a phone number — resolved against the operator's contacts"],
  ["https://t.me/+351900000000", "a phone link"],
  ["351900000000", "a bare number — a peer id to GramJS"],
  ["-13", "a marked peer id"],
  ["https://t.me/pavel", "a person the operator may have a DM with"],
  ["@pavel", "a person, @ form"],
  ["https://t.me/example_bot", "a bot"],
  ["https://t.me/oldgroup", "a basic group, reached by display name"],
  ["https://t.me/+AbCdEfGhIjKlMnOp", "a private invite link"],
]

describe("parse-channel refuses everything that is not a public channel", () => {
  it.each(REFUSED)("%s (%s) → 422", async (raw) => {
    const answer = await parse(raw)
    expect(answer.status).toBe(422)
    expectNothingRead()
  })

  it.each(REFUSED)("%s is refused on the messageIds branch too", async (raw) => {
    expect((await parse(raw, { messageIds: [1, 2] })).status).toBe(422)
    expectNothingRead()
  })
})

describe("channel-info refuses everything that is not a public channel", () => {
  it.each(REFUSED)("%s (%s) → 422, no photo read", async (raw) => {
    const answer = await channelInfo(t.client, raw, true)
    expect(answer.status).toBe(422)
    expect(answer.body).toMatchObject({ error: "UNSUPPORTED_TELEGRAM_SOURCE" })
    expectNothingRead()
  })

  it.each([
    ["pavel", "user"],
    ["example_bot", "bot"],
    ["oldgroup", "group"],
  ])("a resolvable %s is refused with its kind, so the probe can still say why", async (username, kind) => {
    const answer = await channelInfo(t.client, username, true)
    expect(answer).toMatchObject({ status: 422, body: { error: "UNSUPPORTED_TELEGRAM_SOURCE", kind } })
    expect(answer.body).not.toHaveProperty("name")
    expect(answer.body).not.toHaveProperty("photoUrl")
    expectNothingRead()
  })

  it("a public channel still answers 200 with its cover", async () => {
    const answer = await channelInfo(t.client, "durov", true)
    expect(answer).toEqual({
      status: 200,
      body: {
        name: "Durov",
        description: undefined,
        kind: "channel",
        photoUrl: "https://cdn.example/source-covers/telegram/durov.jpg",
      },
    })
    expect(t.downloadProfilePhoto.mock.calls[0][0]).toBeInstanceOf(Api.InputPeerChannel)
  })

  it("a public supergroup still answers 200", async () => {
    expect(await channelInfo(t.client, "publicchat", false)).toMatchObject({
      status: 200,
      body: { kind: "megagroup", name: "Chat" },
    })
  })

  it("a username Telegram doesn't know keeps its marked 404", async () => {
    expect(await channelInfo(t.client, "ghost_nosuch", false)).toMatchObject({
      status: 404,
      body: { error: "USERNAME_NOT_FOUND" },
    })
  })
})

// --- Album paths and body validation ----------------------------------------

describe("every read goes through the verified peer", () => {
  it("the messageIds branch and its album completion fetch", async () => {
    t.getMessages.mockImplementation((async (_peer: unknown, opts: { ids?: number[] }) =>
      opts.ids
        ? [{ id: 7, message: "album", groupedId: 99n, media: { className: "MessageMediaPhoto" }, date: 1 }]
        : [{ id: 6, message: "", groupedId: 99n, media: { className: "MessageMediaPhoto" }, date: 1 }]) as never)
    expect((await parse("https://t.me/durov", { messageIds: [7] })).status).toBe(200)
    expect(readPeerIds()).toEqual(["20", "20"])
  })

  it("the album boundary fetch", async () => {
    t.getMessages
      .mockResolvedValueOnce([{ id: 5, message: "cut album", groupedId: 42n, date: 1 }] as never)
      .mockResolvedValueOnce([{ id: 4, message: "", groupedId: 42n, date: 1 }] as never)
    expect((await parse("https://t.me/durov", { limit: 1 })).status).toBe(200)
    expect(readPeerIds()).toEqual(["20", "20"])
  })
})

describe("parse-channel body validation", () => {
  it.each([
    [5, 5],
    [0, 1],
    [-3, 1],
    [10_000, 100],
    [2.5, 20],
    ["50", 20],
    [undefined, 20],
  ])("limit %s is read as %s", async (limit, expected) => {
    await parse("https://t.me/durov", { limit })
    expect((t.getMessages.mock.calls[0][1] as { limit: number }).limit).toBe(expected)
  })

  it("messageIds keeps only positive integers, at most 200", async () => {
    const many = Array.from({ length: 250 }, (_, i) => i + 1)
    await parse("https://t.me/durov", { messageIds: [0, -1, 1.5, "3", 4, ...many] })
    const ids = (t.getMessages.mock.calls[0][1] as { ids: number[] }).ids
    expect(ids).toHaveLength(200)
    expect(ids.slice(0, 2)).toEqual([4, 1])
    expect(ids.every((n) => Number.isInteger(n) && n > 0)).toBe(true)
  })
})
