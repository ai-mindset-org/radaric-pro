/**
 * Telegram Deleter — auto-deletion of inbox messages after Notion save.
 *
 * Safety invariant: NEVER delete unless Notion save is 100% confirmed.
 *
 * Test groups:
 *   1. shouldDeleteTelegramMessages — pure guard function (5 tests)
 *   2. deleteTelegramMessages — GramJS wrapper (7 tests)
 *   3. maybeDeleteTelegramMessage — full orchestration (8 tests)
 *   4. Safety tests — status guards (5 tests)
 *   5. sweepUndeletedTelegramMessages — retry sweep for PROCESSED items whose
 *      single post-save deletion attempt failed (telegramDeletedAt still null)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  shouldDeleteTelegramMessages,
  deleteTelegramMessages,
  maybeDeleteTelegramMessage,
  sweepUndeletedTelegramMessages,
  type InboxItemForDeletion,
  type GramJSClient,
  type DeleteDeps,
  type SweepDeps,
} from "@/lib/story-aggregator/telegram-deleter"

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

function makeMockItem(overrides: Partial<InboxItemForDeletion> = {}): InboxItemForDeletion {
  return {
    id: "item-1",
    messageId: 123,
    externalId: "-1001234567890:123",
    allMessageIds: [123],
    status: "PROCESSED",
    telegramDeletedAt: null,
    ...overrides,
  }
}

function makeMockGramjsClient(overrides: Partial<GramJSClient> = {}): GramJSClient {
  return {
    getEntity: vi.fn().mockResolvedValue({ id: "entity-1" }),
    deleteMessages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeMockDeps(overrides: Partial<DeleteDeps> = {}): DeleteDeps {
  const item = makeMockItem()
  return {
    db: {
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(item),
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
    gramjsClient: makeMockGramjsClient(),
    channelId: "-1001234567890",
    autoDeleteEnabled: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. shouldDeleteTelegramMessages — pure guard function
// ---------------------------------------------------------------------------

describe("shouldDeleteTelegramMessages — pure guard", () => {
  it("returns true for a valid Telegram item", () => {
    const item = makeMockItem()
    expect(shouldDeleteTelegramMessages(item)).toBe(true)
  })

  it("returns false when telegramDeletedAt is already set (idempotency)", () => {
    const item = makeMockItem({ telegramDeletedAt: new Date() })
    expect(shouldDeleteTelegramMessages(item)).toBe(false)
  })

  it("returns false when messageId === 0 (Send to Stories items)", () => {
    const item = makeMockItem({ messageId: 0 })
    expect(shouldDeleteTelegramMessages(item)).toBe(false)
  })

  it('returns false when externalId starts with "material:" (web UI items)', () => {
    const item = makeMockItem({ externalId: "material:abc123" })
    expect(shouldDeleteTelegramMessages(item)).toBe(false)
  })

  it("returns false when allMessageIds is empty (legacy items)", () => {
    const item = makeMockItem({ allMessageIds: [] })
    expect(shouldDeleteTelegramMessages(item)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. deleteTelegramMessages — GramJS wrapper
// ---------------------------------------------------------------------------

describe("deleteTelegramMessages — GramJS wrapper", () => {
  it("calls deleteMessages with correct entity and IDs", async () => {
    const client = makeMockGramjsClient()
    const result = await deleteTelegramMessages([100, 101, 102], {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    expect(result).toBe(true)
    expect(client.getEntity).toHaveBeenCalledWith(BigInt("-1001234567890"))
    expect(client.deleteMessages).toHaveBeenCalledWith(
      { id: "entity-1" },
      [100, 101, 102],
      { revoke: true }
    )
  })

  it("returns false and warns when entity resolution fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = makeMockGramjsClient({
      getEntity: vi.fn().mockRejectedValue(new Error("Entity not found")),
    })

    const result = await deleteTelegramMessages([100], {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    expect(result).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete messages")
    )
    warnSpy.mockRestore()
  })

  it("returns false and warns when deleteMessages throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = makeMockGramjsClient({
      deleteMessages: vi.fn().mockRejectedValue(new Error("API error")),
    })

    const result = await deleteTelegramMessages([100], {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    expect(result).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("batches >100 IDs into multiple calls", async () => {
    const client = makeMockGramjsClient()
    const ids = Array.from({ length: 150 }, (_, i) => i + 1)

    await deleteTelegramMessages(ids, {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    // Should be called twice: first 100, then remaining 50
    expect(client.deleteMessages).toHaveBeenCalledTimes(2)
    const firstBatch = (client.deleteMessages as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const secondBatch = (client.deleteMessages as ReturnType<typeof vi.fn>).mock.calls[1][1]
    expect(firstBatch).toHaveLength(100)
    expect(secondBatch).toHaveLength(50)
  })

  it("returns true for empty array without API call", async () => {
    const client = makeMockGramjsClient()
    const result = await deleteTelegramMessages([], {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    expect(result).toBe(true)
    expect(client.getEntity).not.toHaveBeenCalled()
    expect(client.deleteMessages).not.toHaveBeenCalled()
  })

  it("logs success message with count", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const client = makeMockGramjsClient()

    await deleteTelegramMessages([100, 101], {
      gramjsClient: client,
      channelId: "-1001234567890",
    })

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 2 message(s)")
    )
    logSpy.mockRestore()
  })

  it("never throws (always catches)", async () => {
    const client = makeMockGramjsClient({
      getEntity: vi.fn().mockRejectedValue(new Error("boom")),
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    // Should not throw, just return false
    await expect(
      deleteTelegramMessages([100], { gramjsClient: client, channelId: "-100" })
    ).resolves.toBe(false)

    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// 3. maybeDeleteTelegramMessage — full orchestration
// ---------------------------------------------------------------------------

describe("maybeDeleteTelegramMessage — orchestration", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it("skips when autoDeleteEnabled === false", async () => {
    const deps = makeMockDeps({ autoDeleteEnabled: false })

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.db.inboxItem.findUnique).not.toHaveBeenCalled()
  })

  it("skips when GramJS client is null", async () => {
    const deps = makeMockDeps({ gramjsClient: null })

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.db.inboxItem.findUnique).not.toHaveBeenCalled()
  })

  it("skips when item status is not PROCESSED", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockItem({ status: "ERROR" })
    )

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
  })

  it("skips when shouldDeleteTelegramMessages returns false", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockItem({ allMessageIds: [] }) // triggers guard
    )

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
  })

  it("calls deleteTelegramMessages and sets telegramDeletedAt on success", async () => {
    const deps = makeMockDeps()

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalled()
    expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "item-1" },
        data: expect.objectContaining({
          telegramDeletedAt: expect.any(Date),
        }),
      })
    )
  })

  it("forwards all album message IDs through the orchestration", async () => {
    const albumItem = makeMockItem({ allMessageIds: [100, 101, 102, 103] })
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(albumItem)

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledWith(
      expect.anything(),
      [100, 101, 102, 103],
      { revoke: true }
    )
  })

  it("does NOT set telegramDeletedAt when deletion returns false", async () => {
    const deps = makeMockDeps({
      gramjsClient: makeMockGramjsClient({
        deleteMessages: vi.fn().mockRejectedValue(new Error("API error")),
      }),
    })

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("never throws on any error", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB connection failed")
    )

    // Should not throw
    await expect(
      maybeDeleteTelegramMessage("item-1", deps)
    ).resolves.toBeUndefined()
  })

  it("skips when channelId is empty", async () => {
    const deps = makeMockDeps({ channelId: "" })

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.db.inboxItem.findUnique).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Safety tests — status guards
// ---------------------------------------------------------------------------

describe("Safety tests — non-PROCESSED statuses are never deleted", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it("item in ERROR status is never deleted", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockItem({ status: "ERROR" })
    )

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
  })

  it("item in MATCHED status is never deleted", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockItem({ status: "MATCHED" })
    )

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
  })

  it("item in PENDING status is never deleted", async () => {
    const deps = makeMockDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockItem({ status: "PENDING" })
    )

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
  })

  it("concurrent calls: second sees telegramDeletedAt and skips", async () => {
    const deps = makeMockDeps()
    const alreadyDeleted = makeMockItem({ telegramDeletedAt: new Date() })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(alreadyDeleted)

    await maybeDeleteTelegramMessage("item-1", deps)

    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("deletion failure does not change item status from PROCESSED", async () => {
    const deps = makeMockDeps({
      gramjsClient: makeMockGramjsClient({
        deleteMessages: vi.fn().mockRejectedValue(new Error("Network error")),
      }),
    })

    await maybeDeleteTelegramMessage("item-1", deps)

    // update should NOT be called (no telegramDeletedAt set, no status change)
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. sweepUndeletedTelegramMessages — retry sweep
//
// Bug: a Notion-saved post stays in the Telegram channel forever when the one
// post-save deletion attempt fails (item stays PROCESSED, telegramDeletedAt
// null, and the retry daemon only retries ERROR items). The sweep re-attempts
// deletion for such items, bounded to the last 7 days.
// ---------------------------------------------------------------------------

const SWEEP_NOW = new Date("2026-11-15T12:00:00.000Z")
const SEVEN_DAYS_BEFORE_SWEEP_NOW = new Date("2026-11-08T12:00:00.000Z")

function makeSweepDeps(
  items: InboxItemForDeletion[],
  overrides: Partial<SweepDeps> = {}
): SweepDeps {
  return {
    db: {
      inboxItem: {
        findMany: vi.fn().mockResolvedValue(items),
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
    gramjsClient: makeMockGramjsClient(),
    channelId: "-1001234567890",
    userId: "user-1",
    autoDeleteEnabled: true,
    now: () => SWEEP_NOW,
    ...overrides,
  }
}

function findManyArgs(deps: SweepDeps): Record<string, unknown> {
  const findMany = deps.db.inboxItem.findMany as ReturnType<typeof vi.fn>
  expect(findMany).toHaveBeenCalledTimes(1)
  return findMany.mock.calls[0][0] as Record<string, unknown>
}

function updatedIds(deps: SweepDeps): string[] {
  const update = deps.db.inboxItem.update as ReturnType<typeof vi.fn>
  return update.mock.calls
    .map((call) => (call[0] as { where: { id: string } }).where.id)
    .sort()
}

describe("sweepUndeletedTelegramMessages — retry sweep", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  // --- guards: nothing is queried or deleted ---------------------------------

  it("returns 0 and never queries or deletes when autoDeleteEnabled is false", async () => {
    const deps = makeSweepDeps([makeMockItem()], { autoDeleteEnabled: false })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(0)
    expect(deps.db.inboxItem.findMany).not.toHaveBeenCalled()
    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("returns 0 and never queries when gramjsClient is null", async () => {
    const deps = makeSweepDeps([makeMockItem()], { gramjsClient: null })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(0)
    expect(deps.db.inboxItem.findMany).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("returns 0 and never queries or deletes when channelId is empty", async () => {
    const deps = makeSweepDeps([makeMockItem()], { channelId: "" })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(0)
    expect(deps.db.inboxItem.findMany).not.toHaveBeenCalled()
    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  // --- query shape: what the sweep is allowed to touch -----------------------

  it("queries only this user's PROCESSED, undeleted items with a confirmed Notion save", async () => {
    const deps = makeSweepDeps([])

    await sweepUndeletedTelegramMessages(deps)

    expect(findManyArgs(deps)).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          status: "PROCESSED",
          telegramDeletedAt: null,
          story: { notionPageId: { not: null } },
        }),
      })
    )
  })

  it.each([
    {
      label: "15 Nov 2026 12:00 UTC -> 8 Nov 2026 12:00 UTC",
      now: SWEEP_NOW,
      cutoff: SEVEN_DAYS_BEFORE_SWEEP_NOW,
    },
    {
      label: "1 Dec 2026 00:00 UTC -> 24 Nov 2026 00:00 UTC",
      now: new Date("2026-12-01T00:00:00.000Z"),
      cutoff: new Date("2026-11-24T00:00:00.000Z"),
    },
  ])(
    "never touches history older than 7 days of the injected clock ($label)",
    async ({ now, cutoff }) => {
      const deps = makeSweepDeps([], { now: () => now })

      await sweepUndeletedTelegramMessages(deps)

      expect(findManyArgs(deps)).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: cutoff },
          }),
        })
      )
    }
  )

  it("bounds each run to 20 items, oldest first", async () => {
    const deps = makeSweepDeps([])

    await sweepUndeletedTelegramMessages(deps)

    expect(findManyArgs(deps)).toEqual(
      expect.objectContaining({
        take: 20,
        orderBy: { createdAt: "asc" },
      })
    )
  })

  // --- happy path -------------------------------------------------------------

  it("deletes each eligible item's messages with revoke and stamps telegramDeletedAt, returning the count", async () => {
    const single = makeMockItem({ id: "item-1", messageId: 100, allMessageIds: [100] })
    const album = makeMockItem({
      id: "item-2",
      messageId: 200,
      externalId: "-1001234567890:200",
      allMessageIds: [200, 201, 202],
    })
    const deps = makeSweepDeps([single, album])

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(2)
    expect(deps.gramjsClient!.getEntity).toHaveBeenCalledWith(BigInt("-1001234567890"))
    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledTimes(2)
    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledWith(
      { id: "entity-1" },
      [100],
      { revoke: true }
    )
    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledWith(
      { id: "entity-1" },
      [200, 201, 202],
      { revoke: true }
    )
    expect(deps.db.inboxItem.update).toHaveBeenCalledTimes(2)
    for (const id of ["item-1", "item-2"]) {
      expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id },
          data: expect.objectContaining({ telegramDeletedAt: expect.any(Date) }),
        })
      )
    }
  })

  it("returns 0 and issues no deletion when the query finds nothing", async () => {
    const deps = makeSweepDeps([])

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(0)
    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  // --- items rejected by shouldDeleteTelegramMessages ------------------------
  // Each case rides next to one eligible item so a sweep that skips everything
  // cannot pass vacuously.

  it.each([
    { reason: "messageId is 0 (Send to Stories)", overrides: { messageId: 0 } },
    {
      reason: 'externalId starts with "material:" (web UI item)',
      overrides: { externalId: "material:abc123" },
    },
    { reason: "allMessageIds is empty (legacy item)", overrides: { allMessageIds: [] } },
    {
      reason: "telegramDeletedAt is already set",
      overrides: { telegramDeletedAt: new Date("2026-11-14T08:00:00.000Z") },
    },
  ])("skips an item whose $reason, but still deletes the eligible one", async ({ overrides }) => {
    const rejected = makeMockItem({ id: "rejected", allMessageIds: [900], ...overrides })
    const eligible = makeMockItem({
      id: "eligible",
      messageId: 500,
      externalId: "-1001234567890:500",
      allMessageIds: [500],
    })
    // The rejected item comes first so a short-circuiting sweep is also caught.
    const deps = makeSweepDeps([rejected, eligible])

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(1)
    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledTimes(1)
    expect(deps.gramjsClient!.deleteMessages).toHaveBeenCalledWith(
      { id: "entity-1" },
      [500],
      { revoke: true }
    )
    expect(updatedIds(deps)).toEqual(["eligible"])
  })

  // --- failure isolation ------------------------------------------------------

  it("a failed deletion for one item does not stop the others or stamp that item", async () => {
    const deleteMessages = vi.fn(async (_entity: unknown, ids: number[]) => {
      if (ids.includes(200)) {
        throw new Error("FLOOD_WAIT_30")
      }
      return undefined
    })
    const items = [
      makeMockItem({ id: "item-1", messageId: 100, allMessageIds: [100] }),
      makeMockItem({ id: "item-2", messageId: 200, allMessageIds: [200] }),
      makeMockItem({ id: "item-3", messageId: 300, allMessageIds: [300] }),
    ]
    const deps = makeSweepDeps(items, {
      gramjsClient: makeMockGramjsClient({ deleteMessages }),
    })

    const result = await sweepUndeletedTelegramMessages(deps)

    expect(result).toBe(2)
    expect(deleteMessages).toHaveBeenCalledTimes(3)
    expect(updatedIds(deps)).toEqual(["item-1", "item-3"])
  })

  it("never throws when every deletion fails and returns 0 without stamping anything", async () => {
    const deps = makeSweepDeps(
      [
        makeMockItem({ id: "item-1", messageId: 100, allMessageIds: [100] }),
        makeMockItem({ id: "item-2", messageId: 200, allMessageIds: [200] }),
      ],
      {
        gramjsClient: makeMockGramjsClient({
          deleteMessages: vi.fn().mockRejectedValue(new Error("API error")),
        }),
      }
    )

    await expect(sweepUndeletedTelegramMessages(deps)).resolves.toBe(0)
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })

  it("never throws when the query rejects and returns 0 without deleting", async () => {
    const deps = makeSweepDeps([makeMockItem()])
    ;(deps.db.inboxItem.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB connection failed")
    )

    await expect(sweepUndeletedTelegramMessages(deps)).resolves.toBe(0)
    expect(deps.gramjsClient!.deleteMessages).not.toHaveBeenCalled()
    expect(deps.db.inboxItem.update).not.toHaveBeenCalled()
  })
})
