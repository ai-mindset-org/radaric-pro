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
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  shouldDeleteTelegramMessages,
  deleteTelegramMessages,
  maybeDeleteTelegramMessage,
  type InboxItemForDeletion,
  type GramJSClient,
  type DeleteDeps,
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
