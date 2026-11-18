/**
 * Gap Scan tests — TDD RED phase
 *
 * These tests import from lib/story-aggregator/gap-scan.ts, which does NOT exist yet.
 * All tests are expected to FAIL until the implementation is written.
 *
 * Spec reference: v3.7.0 Periodic Gap Scan
 *
 * GapScanDeps interface (injected into runGapScan):
 *   getMessages(limit) => Promise<TelegramMessage[]>
 *   findExistingExternalIds(externalIds) => Promise<Set<string>>
 *   downloadMedia(messages, channelUsername) => Promise<MediaResult[]>
 *   resolveTelegramPostUrls(messages) => Promise<(string | null)[]>
 *   ingestMessage(grouped, userId, channelId) => Promise<string | null>
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  runGapScan,
  groupByAlbum,
  type GapScanDeps,
  type GapScanResult,
} from "../../lib/story-aggregator/gap-scan"
import type { TelegramMessage, GroupedMessage } from "../../lib/story-aggregator/album-grouper"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL_ID = "-1001234567890"
const CHANNEL_USERNAME = "designweekly"
const USER_ID = "clx_user_001"

function makeMsg(messageId: number, groupedId: string | null = null): TelegramMessage {
  return {
    messageId,
    groupedId,
    text: `Message ${messageId}`,
    mediaUrl: null,
    date: 1772500000 + messageId, // 2026-03-03 — after GAP_SCAN_CUTOFF_TS
    telegramPostUrl: `https://t.me/${CHANNEL_USERNAME}/${messageId}`,
  }
}

function makeMediaResult(url: string | null = "https://r2.example.com/photo.jpg") {
  return { url }
}

// ---------------------------------------------------------------------------
// Factory: build a fully-mocked GapScanDeps object
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<GapScanDeps> = {}): GapScanDeps {
  return {
    getMessages: vi.fn().mockResolvedValue([makeMsg(1), makeMsg(2), makeMsg(3)]),
    findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
    downloadMedia: vi.fn().mockResolvedValue([makeMediaResult(null)]),
    resolveTelegramPostUrls: vi.fn().mockResolvedValue([null]),
    ingestMessage: vi.fn().mockResolvedValue("clx_inbox_001"),
    ...overrides,
  }
}

// ===========================================================================
// 1. runGapScan — core behavior
// ===========================================================================

describe("runGapScan", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("AC-1: fetches exactly 100 messages from Telegram and ingests missing ones", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeMsg(i + 1))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue(messages.map(() => makeMediaResult(null))),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue(messages.map(() => null)),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_new"),
    })

    const result: GapScanResult = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    // Must request exactly 100 messages, no minId constraint
    expect(deps.getMessages).toHaveBeenCalledWith(100)
    // All 5 messages were new — all ingested
    expect(result.found).toBe(5)
    expect(result.ingested).toBe(5)
  })

  it("AC-1: checks existing externalIds before downloading media", async () => {
    const messages = [makeMsg(10), makeMsg(11), makeMsg(12)]
    // messageId 11 already exists in DB
    const existingExternalId = `${CHANNEL_ID}:11`
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set([existingExternalId])),
      downloadMedia: vi.fn().mockResolvedValue([makeMediaResult(null), makeMediaResult(null)]),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue([null, null]),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    // downloadMedia should only receive the 2 missing messages (not the existing one)
    const downloadCall = (deps.downloadMedia as ReturnType<typeof vi.fn>).mock.calls[0]
    const downloadedMessages: TelegramMessage[] = downloadCall[0]
    const downloadedIds = downloadedMessages.map((m) => m.messageId)
    expect(downloadedIds).not.toContain(11)
    expect(downloadedIds).toContain(10)
    expect(downloadedIds).toContain(12)
  })

  it("AC-2: groups album messages synchronously by groupedId before ingesting", async () => {
    // Two messages share the same groupedId — they form an album
    const albumGroupId = "group_abc"
    const msg1 = { ...makeMsg(20), groupedId: albumGroupId }
    const msg2 = { ...makeMsg(21), groupedId: albumGroupId }
    const msg3 = makeMsg(22) // standalone

    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue([msg1, msg2, msg3]),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue([
        makeMediaResult("https://r2.example.com/photo1.jpg"),
        makeMediaResult("https://r2.example.com/photo2.jpg"),
        makeMediaResult(null),
      ]),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue([null, null, null]),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_album"),
    })

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    // Album (2 messages) + standalone (1 message) = 2 ingestMessage calls
    expect(deps.ingestMessage).toHaveBeenCalledTimes(2)
    // Total ingested = 2 (one album group + one standalone)
    expect(result.ingested).toBe(2)
  })

  it("AC-3: skips execution and returns early when isReconnecting is true", async () => {
    const deps = buildDeps()

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps, {
      isReconnecting: true,
      gramjsClient: {},
    })

    expect(deps.getMessages).not.toHaveBeenCalled()
    expect(result.found).toBe(0)
    expect(result.ingested).toBe(0)
  })

  it("AC-3: skips execution and returns early when gramjsClient is null", async () => {
    const deps = buildDeps()

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps, {
      isReconnecting: false,
      gramjsClient: null,
    })

    expect(deps.getMessages).not.toHaveBeenCalled()
    expect(result.found).toBe(0)
    expect(result.ingested).toBe(0)
  })

  it("AC-4: does NOT call any function that would modify storyLastMessageId", async () => {
    // GapScanDeps has no updateLastMessageId — the interface itself enforces this.
    // We verify that no dep with a name suggesting lastMessageId update is called.
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue([makeMsg(30)]),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue([makeMediaResult(null)]),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue([null]),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_new"),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    // Verify the result object does not contain any lastMessageId-style field
    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)
    expect(result).not.toHaveProperty("lastMessageId")
    expect(result).not.toHaveProperty("storyLastMessageId")
    // GapScanResult only has: found, ingested, capped
    expect(Object.keys(result).sort()).toEqual(["capped", "found", "ingested"])
  })

  it("AC-5: logs count of missing messages found and ingested", async () => {
    const messages = [makeMsg(40), makeMsg(41)]
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue(messages.map(() => makeMediaResult(null))),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue(messages.map(() => null)),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_new"),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    // Must log found/ingested counts
    const allLogs = consoleSpy.mock.calls.map((args) => String(args[0]))
    const hasCountLog = allLogs.some(
      (msg) => msg.includes("2") && (msg.toLowerCase().includes("gap") || msg.toLowerCase().includes("missing") || msg.toLowerCase().includes("found"))
    )
    expect(hasCountLog).toBe(true)
  })

  it("AC-5: logs 'No gaps detected' when all messages already exist in DB", async () => {
    const messages = [makeMsg(50), makeMsg(51)]
    const existingIds = new Set(messages.map((m) => `${CHANNEL_ID}:${m.messageId}`))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(existingIds),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    const allLogs = consoleSpy.mock.calls.map((args) => String(args[0]))
    const hasNoGapsLog = allLogs.some((msg) =>
      msg.toLowerCase().includes("no gap")
    )
    expect(hasNoGapsLog).toBe(true)
  })

  it("AC-6: catches and logs errors from getMessages without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error")
    const deps = buildDeps({
      getMessages: vi.fn().mockRejectedValue(new Error("Telegram API timeout")),
    })

    // Must not throw
    await expect(
      runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)
    ).resolves.not.toThrow()

    // Must log the error
    const errorLogs = errorSpy.mock.calls.map((args) => String(args[0]))
    const hasErrorLog = errorLogs.some((msg) =>
      msg.toLowerCase().includes("gap") || msg.toLowerCase().includes("error") || msg.toLowerCase().includes("scan")
    )
    expect(hasErrorLog).toBe(true)
  })

  it("AC-7: caps ingestion at 20 items per run", async () => {
    // 25 new messages — only 20 should be ingested
    const messages = Array.from({ length: 25 }, (_, i) => makeMsg(i + 100))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue(messages.slice(0, 20).map(() => makeMediaResult(null))),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue(messages.slice(0, 20).map(() => null)),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_new"),
    })

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    expect(result.ingested).toBeLessThanOrEqual(20)
    expect(result.capped).toBe(true)
  })

  it("AC-7: logs a message when the ingestion cap is hit", async () => {
    const messages = Array.from({ length: 25 }, (_, i) => makeMsg(i + 200))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue(messages.slice(0, 20).map(() => makeMediaResult(null))),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue(messages.slice(0, 20).map(() => null)),
      ingestMessage: vi.fn().mockResolvedValue("clx_inbox_new"),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    const allLogs = consoleSpy.mock.calls.map((args) => String(args[0]))
    const hasCapLog = allLogs.some((msg) =>
      msg.toLowerCase().includes("cap") || msg.toLowerCase().includes("limit") || msg.toLowerCase().includes("max")
    )
    expect(hasCapLog).toBe(true)
  })

  it("AC-8: treats unique constraint violation from ingestMessage as a dedup hit, not an error", async () => {
    const uniqueConstraintError = Object.assign(new Error("Unique constraint failed on the fields: (`externalId`)"), {
      code: "P2002",
    })
    const messages = [makeMsg(300), makeMsg(301)]
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      downloadMedia: vi.fn().mockResolvedValue(messages.map(() => makeMediaResult(null))),
      resolveTelegramPostUrls: vi.fn().mockResolvedValue(messages.map(() => null)),
      // First call throws unique constraint; second succeeds
      ingestMessage: vi.fn()
        .mockRejectedValueOnce(uniqueConstraintError)
        .mockResolvedValue("clx_inbox_302"),
    })

    const errorSpy = vi.spyOn(console, "error")

    // Must not throw
    await expect(
      runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)
    ).resolves.not.toThrow()

    // The unique constraint hit should NOT be logged as a hard error
    const errorLogs = errorSpy.mock.calls.map((args) => args.join(" "))
    const hasConstraintError = errorLogs.some((msg) =>
      msg.toLowerCase().includes("unique constraint") || msg.toLowerCase().includes("p2002")
    )
    expect(hasConstraintError).toBe(false)

    // The second message is still ingested
    expect(deps.ingestMessage).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  it("EC-1: returns without error when Telegram returns 0 messages", async () => {
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue([]),
    })

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    expect(result.found).toBe(0)
    expect(result.ingested).toBe(0)
    expect(result.capped).toBe(false)
    expect(deps.ingestMessage).not.toHaveBeenCalled()
  })

  it("EC-2: second run ingests 0 when all messages are now in DB", async () => {
    const messages = [makeMsg(400), makeMsg(401)]
    // After first run, all externalIds exist
    const existingIds = new Set(messages.map((m) => `${CHANNEL_ID}:${m.messageId}`))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(existingIds),
    })

    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    expect(result.found).toBe(0)
    expect(result.ingested).toBe(0)
    expect(deps.ingestMessage).not.toHaveBeenCalled()
  })

  it("EC-3: skips media download and ingest when all 100 messages already exist in DB", async () => {
    const messages = Array.from({ length: 100 }, (_, i) => makeMsg(i + 500))
    const existingIds = new Set(messages.map((m) => `${CHANNEL_ID}:${m.messageId}`))
    const deps = buildDeps({
      getMessages: vi.fn().mockResolvedValue(messages),
      findExistingExternalIds: vi.fn().mockResolvedValue(existingIds),
    })

    await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    expect(deps.downloadMedia).not.toHaveBeenCalled()
    expect(deps.ingestMessage).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Error Cases
  // -------------------------------------------------------------------------

  it("ERR-1: getMessages failure — logs error and does not throw", async () => {
    const errorSpy = vi.spyOn(console, "error")
    const deps = buildDeps({
      getMessages: vi.fn().mockRejectedValue(new Error("FloodWaitError 42")),
    })

    // Must not throw — resolves to a valid result
    const result = await runGapScan(CHANNEL_ID, CHANNEL_USERNAME, USER_ID, deps)

    expect(result).toBeDefined()
    expect(result.found).toBe(0)
    expect(result.ingested).toBe(0)

    // Error is logged
    expect(errorSpy).toHaveBeenCalled()
  })
})

// ===========================================================================
// 2. groupByAlbum — pure function
// ===========================================================================

describe("groupByAlbum", () => {
  it("groups messages with the same groupedId into a single GroupedMessage", () => {
    const albumGroupId = "grp_001"
    const messages: TelegramMessage[] = [
      { messageId: 1, groupedId: albumGroupId, text: "Album caption", mediaUrl: null, date: 1000, telegramPostUrl: "https://t.me/ch/1" },
      { messageId: 2, groupedId: albumGroupId, text: null, mediaUrl: null, date: 1001, telegramPostUrl: "https://t.me/ch/2" },
    ]
    const mediaResults = [
      { url: "https://r2.example.com/photo1.jpg" },
      { url: "https://r2.example.com/photo2.jpg" },
    ]
    const telegramPostUrls: (string | null)[] = ["https://t.me/ch/1", "https://t.me/ch/2"]

    const grouped = groupByAlbum(messages, mediaResults, telegramPostUrls)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].messageIds).toContain(1)
    expect(grouped[0].messageIds).toContain(2)
    expect(grouped[0].mediaUrls).toEqual([
      "https://r2.example.com/photo1.jpg",
      "https://r2.example.com/photo2.jpg",
    ])
    expect(grouped[0].groupedId).toBe(albumGroupId)
  })

  it("keeps standalone messages (no groupedId) as separate GroupedMessages", () => {
    const messages: TelegramMessage[] = [
      { messageId: 10, groupedId: null, text: "Solo post A", mediaUrl: null, date: 2000, telegramPostUrl: null },
      { messageId: 11, groupedId: null, text: "Solo post B", mediaUrl: null, date: 2001, telegramPostUrl: null },
    ]
    const mediaResults = [{ url: null }, { url: null }]
    const telegramPostUrls: (string | null)[] = [null, null]

    const grouped = groupByAlbum(messages, mediaResults, telegramPostUrls)

    expect(grouped).toHaveLength(2)
    expect(grouped.map((g) => g.primaryMessageId)).toContain(10)
    expect(grouped.map((g) => g.primaryMessageId)).toContain(11)
  })

  it("mixes albums and standalone messages correctly", () => {
    const albumGroupId = "grp_002"
    const messages: TelegramMessage[] = [
      { messageId: 20, groupedId: albumGroupId, text: "Album text", mediaUrl: null, date: 3000, telegramPostUrl: null },
      { messageId: 21, groupedId: albumGroupId, text: null, mediaUrl: null, date: 3001, telegramPostUrl: null },
      { messageId: 22, groupedId: null, text: "Standalone", mediaUrl: null, date: 3002, telegramPostUrl: null },
    ]
    const mediaResults = [
      { url: "https://r2.example.com/a.jpg" },
      { url: "https://r2.example.com/b.jpg" },
      { url: null },
    ]
    const telegramPostUrls: (string | null)[] = [null, null, null]

    const grouped = groupByAlbum(messages, mediaResults, telegramPostUrls)

    expect(grouped).toHaveLength(2)
    const album = grouped.find((g) => g.groupedId === albumGroupId)
    expect(album).toBeDefined()
    expect(album!.messageIds).toHaveLength(2)
    expect(album!.mediaUrls).toHaveLength(2)

    const standalone = grouped.find((g) => g.groupedId === null)
    expect(standalone).toBeDefined()
    expect(standalone!.primaryMessageId).toBe(22)
  })

  it("preserves text from the first message with non-null text in an album", () => {
    const albumGroupId = "grp_003"
    const messages: TelegramMessage[] = [
      { messageId: 30, groupedId: albumGroupId, text: null, mediaUrl: null, date: 4000, telegramPostUrl: null },
      { messageId: 31, groupedId: albumGroupId, text: "The caption here", mediaUrl: null, date: 4001, telegramPostUrl: null },
    ]
    const mediaResults = [{ url: "https://r2.example.com/img.jpg" }, { url: null }]
    const telegramPostUrls: (string | null)[] = [null, null]

    const grouped = groupByAlbum(messages, mediaResults, telegramPostUrls)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].text).toBe("The caption here")
  })

  it("returns empty array when given empty inputs", () => {
    const grouped = groupByAlbum([], [], [])
    expect(grouped).toEqual([])
  })

  it("excludes null mediaUrls from grouped mediaUrls array", () => {
    const messages: TelegramMessage[] = [
      { messageId: 40, groupedId: null, text: "Text only", mediaUrl: null, date: 5000, telegramPostUrl: null },
    ]
    const mediaResults = [{ url: null }]
    const telegramPostUrls: (string | null)[] = [null]

    const grouped = groupByAlbum(messages, mediaResults, telegramPostUrls)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].mediaUrls).toEqual([])
  })
})
