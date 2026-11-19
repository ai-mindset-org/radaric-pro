/**
 * Telegram Deleter sweep — safety hardening (review round 2).
 *
 * The retry sweep deletes messages from a live Telegram channel, so every way
 * it could delete the WRONG message, or delete while the GramJS client is being
 * torn down, is pinned here:
 *
 *   F1. Channel binding — externalId is "<channelId>:<messageId>"; the sweep
 *       must only touch items that belong to the configured channel.
 *   F2. Never-deletable items (messageId 0, empty allMessageIds) are excluded
 *       in the query so they cannot fill the 20-item batch and starve real ones.
 *   F3. Abort on client teardown — optional `shouldAbort` dep.
 *   F4. Fresh re-read before delete — optional `db.inboxItem.findUnique` dep;
 *       an item that changed since the batch was read is not deleted.
 *
 * The new deps are optional: the frozen telegram-deleter.test.ts (no
 * shouldAbort, no findUnique) must keep passing unchanged.
 *
 * Every "skipped" case is paired with an eligible item AFTER it, so an
 * implementation that does nothing, or bails out of the whole loop, cannot pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  sweepUndeletedTelegramMessages,
  type InboxItemForDeletion,
  type GramJSClient,
  type SweepDeps,
} from "@/lib/story-aggregator/telegram-deleter"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = "-1001083211211"
const SWEEP_NOW = new Date("2026-11-15T12:00:00.000Z")

type Mock = ReturnType<typeof vi.fn>

function makeItem(overrides: Partial<InboxItemForDeletion> = {}): InboxItemForDeletion {
  return {
    id: "item-1",
    messageId: 15526,
    externalId: `${CHANNEL_ID}:15526`,
    allMessageIds: [15526],
    status: "PROCESSED",
    telegramDeletedAt: null,
    storyId: "story-A",
    ...overrides,
  }
}

function makeClient(overrides: Partial<GramJSClient> = {}): GramJSClient {
  return {
    getEntity: vi.fn().mockResolvedValue({ id: "entity-1" }),
    deleteMessages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

type SweepDepsWithOptionals = SweepDeps & {
  shouldAbort?: () => boolean
}

function makeDeps(
  items: InboxItemForDeletion[],
  overrides: Record<string, unknown> = {},
  extraInboxItem: Record<string, unknown> = {}
): SweepDepsWithOptionals {
  return {
    db: {
      inboxItem: {
        findMany: vi.fn().mockResolvedValue(items),
        update: vi.fn().mockResolvedValue(undefined),
        ...extraInboxItem,
      },
    },
    gramjsClient: makeClient(),
    channelId: CHANNEL_ID,
    userId: "user-1",
    autoDeleteEnabled: true,
    now: () => SWEEP_NOW,
    ...overrides,
  } as SweepDepsWithOptionals
}

function findManyWhere(deps: SweepDeps): Record<string, unknown> {
  const findMany = deps.db.inboxItem.findMany as unknown as Mock
  expect(findMany).toHaveBeenCalledTimes(1)
  return (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
}

/** The message-id arrays passed to deleteMessages, in call order. */
function deletedIdBatches(deps: SweepDeps): number[][] {
  const client = deps.gramjsClient as GramJSClient
  return (client.deleteMessages as unknown as Mock).mock.calls.map((call) => call[1] as number[])
}

function updatedIds(deps: SweepDeps): string[] {
  const update = deps.db.inboxItem.update as unknown as Mock
  return update.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id)
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// F1. Channel binding
// ---------------------------------------------------------------------------

describe("sweep safety — F1 channel binding", () => {
  it.each([
    { channelId: "-1001083211211", prefix: "-1001083211211:" },
    { channelId: "-1001234567890", prefix: "-1001234567890:" },
  ])(
    "F1: the query only selects externalIds starting with the configured channel ($channelId)",
    async ({ channelId, prefix }) => {
      const deps = makeDeps([], { channelId })

      await sweepUndeletedTelegramMessages(deps)

      expect(findManyWhere(deps)).toEqual(
        expect.objectContaining({ externalId: { startsWith: prefix } })
      )
    }
  )

  it.each([
    { label: "a different channel", externalId: "-1009999999999:15526" },
    {
      label: "a channel whose id merely starts with ours (no colon boundary)",
      externalId: `${CHANNEL_ID}0:15526`,
    },
  ])(
    "F1: an item findMany returns from $label is not deleted and not stamped",
    async ({ externalId }) => {
      const foreign = makeItem({ id: "foreign", externalId, messageId: 15526, allMessageIds: [15526] })
      const eligible = makeItem({
        id: "ours",
        externalId: `${CHANNEL_ID}:15527`,
        messageId: 15527,
        allMessageIds: [15527],
      })
      const deps = makeDeps([foreign, eligible])

      const result = await sweepUndeletedTelegramMessages(deps)

      expect(deletedIdBatches(deps)).toEqual([[15527]])
      expect(updatedIds(deps)).toEqual(["ours"])
      expect(result).toBe(1)
    }
  )
})

// ---------------------------------------------------------------------------
// F2. Never-deletable items are excluded in the query
// ---------------------------------------------------------------------------

describe("sweep safety — F2 never-deletable items cannot fill the batch", () => {
  it("F2: the query excludes items with messageId 0 (Send to Stories)", async () => {
    const deps = makeDeps([])

    await sweepUndeletedTelegramMessages(deps)

    expect(findManyWhere(deps)).toEqual(expect.objectContaining({ messageId: { not: 0 } }))
  })

  it("F2: the query excludes items with an empty allMessageIds (legacy, not backfilled)", async () => {
    const deps = makeDeps([])

    await sweepUndeletedTelegramMessages(deps)

    expect(findManyWhere(deps)).toEqual(
      expect.objectContaining({ allMessageIds: { isEmpty: false } })
    )
  })
})

// ---------------------------------------------------------------------------
// F3. Abort on client teardown
// ---------------------------------------------------------------------------

describe("sweep safety — F3 shouldAbort", () => {
  it("F3: returns 0 and never queries or deletes when shouldAbort is already true", async () => {
    const deps = makeDeps([makeItem()], { shouldAbort: () => true })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(0)
    expect(deps.db.inboxItem.findMany).not.toHaveBeenCalled()
    expect(deletedIdBatches(deps)).toEqual([])
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("F3: checks shouldAbort before querying, and deletes every item while it stays false", async () => {
    const order: string[] = []
    const items = [
      makeItem({ id: "item-1", externalId: `${CHANNEL_ID}:100`, messageId: 100, allMessageIds: [100] }),
      makeItem({ id: "item-2", externalId: `${CHANNEL_ID}:200`, messageId: 200, allMessageIds: [200] }),
      makeItem({ id: "item-3", externalId: `${CHANNEL_ID}:300`, messageId: 300, allMessageIds: [300] }),
    ]
    const deps = makeDeps(items, {
      shouldAbort: () => {
        order.push("abort-check")
        return false
      },
    })
    ;(deps.db.inboxItem.findMany as unknown as Mock).mockImplementation(async () => {
      order.push("query")
      return items
    })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(order.slice(0, 2)).toEqual(["abort-check", "query"])
    expect(deletedIdBatches(deps)).toEqual([[100], [200], [300]])
    expect(result).toBe(3)
  })

  it("F3: once shouldAbort flips true after the first item, the remaining items are not deleted", async () => {
    const items = [
      makeItem({ id: "item-1", externalId: `${CHANNEL_ID}:100`, messageId: 100, allMessageIds: [100] }),
      makeItem({ id: "item-2", externalId: `${CHANNEL_ID}:200`, messageId: 200, allMessageIds: [200] }),
      makeItem({ id: "item-3", externalId: `${CHANNEL_ID}:300`, messageId: 300, allMessageIds: [300] }),
    ]
    const client = makeClient()
    // false before the query and before item 1; true from item 2 on (the client
    // "tears down" once the first delete has gone through).
    const deps = makeDeps(items, {
      gramjsClient: client,
      shouldAbort: () => (client.deleteMessages as unknown as Mock).mock.calls.length >= 1,
    })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(deletedIdBatches(deps)).toEqual([[100]])
    // The first delete was confirmed, so it is still stamped.
    expect(updatedIds(deps)).toEqual(["item-1"])
    expect(result).toBe(1)
  })

  it("F3: if shouldAbort flips true between the query and the first item, nothing is deleted", async () => {
    const items = [
      makeItem({ id: "item-1", externalId: `${CHANNEL_ID}:100`, messageId: 100, allMessageIds: [100] }),
      makeItem({ id: "item-2", externalId: `${CHANNEL_ID}:200`, messageId: 200, allMessageIds: [200] }),
    ]
    const deps = makeDeps(items, {})
    const findMany = deps.db.inboxItem.findMany as unknown as Mock
    deps.shouldAbort = () => findMany.mock.calls.length >= 1

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(deletedIdBatches(deps)).toEqual([])
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
    expect(result).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// F4. Fresh re-read before delete
// ---------------------------------------------------------------------------

describe("sweep safety — F4 re-read before delete", () => {
  it("F4: re-reads each item by id immediately before deleting it, then deletes and stamps", async () => {
    const order: string[] = []
    const first = makeItem({
      id: "item-1",
      externalId: `${CHANNEL_ID}:100`,
      messageId: 100,
      allMessageIds: [100],
    })
    const second = makeItem({
      id: "item-2",
      externalId: `${CHANNEL_ID}:200`,
      messageId: 200,
      allMessageIds: [200, 201],
    })
    const client = makeClient({
      deleteMessages: vi.fn(async (_entity: unknown, ids: number[]) => {
        order.push(`delete:${ids.join(",")}`)
      }),
    })
    const findUnique = vi.fn(async (args: { where: { id: string } }) => {
      order.push(`reread:${args.where.id}`)
      return args.where.id === "item-1" ? { ...first } : { ...second }
    })
    const deps = makeDeps([first, second], { gramjsClient: client }, { findUnique })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(order).toEqual(["reread:item-1", "delete:100", "reread:item-2", "delete:200,201"])
    expect(findUnique.mock.calls.map((call) => call[0])).toEqual([
      { where: { id: "item-1" } },
      { where: { id: "item-2" } },
    ])
    expect(updatedIds(deps)).toEqual(["item-1", "item-2"])
    expect(result).toBe(2)
  })

  it.each<{ reason: string; fresh: Partial<InboxItemForDeletion> | null }>([
    { reason: "the row no longer exists", fresh: null },
    { reason: "its status is no longer PROCESSED", fresh: { status: "ERROR" } },
    {
      reason: "it was already deleted since the batch was read",
      fresh: { telegramDeletedAt: new Date("2026-11-15T11:59:00.000Z") },
    },
    { reason: "it was re-attached to a different story", fresh: { storyId: "story-B" } },
    { reason: "it was detached from its story", fresh: { storyId: null } },
  ])(
    "F4: skips an item whose fresh row changed — $reason — without deleting or stamping it",
    async ({ fresh }) => {
      const stale = makeItem({
        id: "stale",
        externalId: `${CHANNEL_ID}:900`,
        messageId: 900,
        allMessageIds: [900],
        storyId: "story-A",
      })
      const eligible = makeItem({
        id: "ok",
        externalId: `${CHANNEL_ID}:901`,
        messageId: 901,
        allMessageIds: [901],
        storyId: "story-A",
      })
      const findUnique = vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === "stale") {
          return fresh === null ? null : { ...stale, ...fresh }
        }
        return { ...eligible }
      })
      const deps = makeDeps([stale, eligible], {}, { findUnique })

      const result = await sweepUndeletedTelegramMessages(deps)

      expect(deletedIdBatches(deps)).toEqual([[901]])
      expect(updatedIds(deps)).toEqual(["ok"])
      expect(result).toBe(1)
    }
  )
})
