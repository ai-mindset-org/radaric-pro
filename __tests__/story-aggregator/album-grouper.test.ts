import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  AlbumGrouper,
  type TelegramMessage,
  type GroupedMessage,
} from "@/lib/story-aggregator/album-grouper"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    messageId: 1,
    groupedId: null,
    text: "Hello world",
    mediaUrl: null,
    date: 1700000000,
    telegramPostUrl: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Non-grouped messages (groupedId is null)
//    Per spec section 2.5 item 4: non-grouped messages bypass the debounce
//    window and are processed immediately.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — non-grouped messages (groupedId: null)", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves immediately without advancing timers (no debounce for non-album messages)", async () => {
    const msg = makeMessage({ messageId: 1, groupedId: null, text: "standalone post" })

    // The promise must settle synchronously — we flush microtasks only, no timers
    const result = await grouper.add(msg)

    expect(result).toBeDefined()
  })

  it("returns a GroupedMessage with a single messageId matching the input", async () => {
    const msg = makeMessage({ messageId: 42, groupedId: null })

    const result = await grouper.add(msg)

    expect(result).not.toBeNull()
    expect(result!.messageIds).toEqual([42])
    expect(result!.primaryMessageId).toBe(42)
  })

  it("preserves text and mediaUrl from the input message", async () => {
    const msg = makeMessage({
      messageId: 10,
      groupedId: null,
      text: "Some text",
      mediaUrl: "https://example.com/photo.jpg",
    })

    const result = await grouper.add(msg)

    expect(result).not.toBeNull()
    expect(result!.text).toBe("Some text")
    expect(result!.mediaUrls).toEqual(["https://example.com/photo.jpg"])
  })

  it("pendingCount stays 0 throughout the lifecycle of a non-grouped message", async () => {
    const msg = makeMessage({ messageId: 5, groupedId: null })

    expect(grouper.pendingCount).toBe(0)
    await grouper.add(msg)
    expect(grouper.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Album messages (same groupedId)
//    Per spec section 4.1: messages sharing a grouped_id are debounced and
//    merged into a single GroupedMessage after the 10s window closes.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — album messages (shared groupedId)", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("two messages with the same groupedId merge into a single GroupedMessage (first resolver only)", async () => {
    const gid = "album-001"
    const msg1 = makeMessage({ messageId: 100, groupedId: gid, text: "Caption here", mediaUrl: "https://example.com/1.jpg", date: 1700000000 })
    const msg2 = makeMessage({ messageId: 101, groupedId: gid, text: null, mediaUrl: "https://example.com/2.jpg", date: 1700000001 })

    const promise1 = grouper.add(msg1)
    const promise2 = grouper.add(msg2)

    // Advance past the debounce window to trigger resolution
    await vi.advanceTimersByTimeAsync(10001)

    const [result1, result2] = await Promise.all([promise1, promise2])

    // First resolver gets the merged group
    expect(result1).not.toBeNull()
    expect(result1!.messageIds).toContain(100)
    expect(result1!.messageIds).toContain(101)
    // Second resolver gets null (album already handled by first)
    expect(result2).toBeNull()
  })

  it("combined GroupedMessage contains all mediaUrls from album messages", async () => {
    const gid = "album-002"
    const msg1 = makeMessage({ messageId: 200, groupedId: gid, mediaUrl: "https://example.com/a.jpg" })
    const msg2 = makeMessage({ messageId: 201, groupedId: gid, mediaUrl: "https://example.com/b.jpg" })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)

    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1

    expect(result).not.toBeNull()
    expect(result!.mediaUrls).toContain("https://example.com/a.jpg")
    expect(result!.mediaUrls).toContain("https://example.com/b.jpg")
    expect(result!.mediaUrls).toHaveLength(2)

    // Second resolver gets null
    expect(await p2).toBeNull()
  })

  it("text is taken from the message that has text (first in album has it)", async () => {
    const gid = "album-003"
    const msg1 = makeMessage({ messageId: 300, groupedId: gid, text: "Album caption", mediaUrl: "https://example.com/1.jpg" })
    const msg2 = makeMessage({ messageId: 301, groupedId: gid, text: null, mediaUrl: "https://example.com/2.jpg" })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)

    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1

    expect(result).not.toBeNull()
    expect(result!.text).toBe("Album caption")

    // Second resolver gets null
    expect(await p2).toBeNull()
  })

  it("primaryMessageId is the first message added to the group", async () => {
    const gid = "album-004"
    const msg1 = makeMessage({ messageId: 400, groupedId: gid, date: 1700000000 })
    const msg2 = makeMessage({ messageId: 401, groupedId: gid, date: 1700000001 })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)

    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1

    expect(result).not.toBeNull()
    expect(result!.primaryMessageId).toBe(400)

    expect(await p2).toBeNull()
  })

  it("date is taken from the first message added to the group", async () => {
    const gid = "album-005"
    const msg1 = makeMessage({ messageId: 500, groupedId: gid, date: 1700000000 })
    const msg2 = makeMessage({ messageId: 501, groupedId: gid, date: 1700000099 })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)

    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1

    expect(result).not.toBeNull()
    expect(result!.date).toBe(1700000000)

    expect(await p2).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Debounce timing
//    Per spec section 4.1: 10-second window; adding a new message resets it.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — debounce timing", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("album promise does NOT resolve before the debounce window expires", async () => {
    const gid = "timing-001"
    const msg = makeMessage({ messageId: 1, groupedId: gid })

    let resolved = false
    grouper.add(msg).then(() => { resolved = true })

    // Advance to just before the window closes
    await vi.advanceTimersByTimeAsync(9999)
    expect(resolved).toBe(false)
  })

  it("album promise resolves AFTER the debounce window expires (10001ms)", async () => {
    const gid = "timing-002"
    const msg = makeMessage({ messageId: 2, groupedId: gid })

    let resolved = false
    grouper.add(msg).then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(10001)
    expect(resolved).toBe(true)
  })

  it("adding a new message to an existing group resets the debounce timer", async () => {
    const gid = "timing-003"
    const msg1 = makeMessage({ messageId: 10, groupedId: gid })
    const msg2 = makeMessage({ messageId: 11, groupedId: gid })

    let resolved = false
    const p1 = grouper.add(msg1)
    p1.then((r) => { if (r) resolved = true })

    // Advance to 9s (close but not past the window)
    await vi.advanceTimersByTimeAsync(9000)
    expect(resolved).toBe(false)

    // Add second message — must reset the timer
    const p2 = grouper.add(msg2)

    // Advance 9s more (total 18s from start, but only 9s since last message)
    await vi.advanceTimersByTimeAsync(9000)
    // Should still be pending because timer was reset
    expect(resolved).toBe(false)

    // Now advance past the window from the second message
    await vi.advanceTimersByTimeAsync(1001)
    expect(resolved).toBe(true)

    await Promise.all([p1, p2])
  })

  it("default debounce is 10000ms (10 seconds) per spec section 4.1", async () => {
    // Use the no-arg constructor to test the default
    const defaultGrouper = new AlbumGrouper()
    const gid = "timing-004"
    const msg = makeMessage({ messageId: 20, groupedId: gid })

    let resolved = false
    defaultGrouper.add(msg).then(() => { resolved = true })

    // Just before 10s: should not resolve
    await vi.advanceTimersByTimeAsync(9999)
    expect(resolved).toBe(false)

    // Just after 10s: should resolve
    await vi.advanceTimersByTimeAsync(2)
    expect(resolved).toBe(true)
  })

  it("custom debounce can be set via the constructor", async () => {
    const fastGrouper = new AlbumGrouper(500)
    const gid = "timing-005"
    const msg = makeMessage({ messageId: 30, groupedId: gid })

    let resolved = false
    fastGrouper.add(msg).then(() => { resolved = true })

    // Before custom window
    await vi.advanceTimersByTimeAsync(499)
    expect(resolved).toBe(false)

    // After custom window
    await vi.advanceTimersByTimeAsync(2)
    expect(resolved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Mixed messages
//    Non-grouped and different groupedIds can coexist.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — mixed messages", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("non-grouped message resolves immediately even while an album group is pending", async () => {
    const albumMsg = makeMessage({ messageId: 1, groupedId: "album-pending" })
    const standaloneMsg = makeMessage({ messageId: 2, groupedId: null, text: "standalone" })

    const albumPromise = grouper.add(albumMsg)

    let albumResolved = false
    albumPromise.then(() => { albumResolved = true })

    // Add standalone — it should resolve without advancing timers
    const standaloneResult = await grouper.add(standaloneMsg)

    // Album must still be pending
    expect(albumResolved).toBe(false)
    // Standalone must have resolved with its own data
    expect(standaloneResult).not.toBeNull()
    expect(standaloneResult!.messageIds).toEqual([2])

    // Cleanup: flush the pending album
    await vi.advanceTimersByTimeAsync(10001)
    await albumPromise
  })

  it("two different groupedIds create two separate GroupedMessages", async () => {
    const msg1 = makeMessage({ messageId: 100, groupedId: "group-A", mediaUrl: "https://example.com/a1.jpg" })
    const msg2 = makeMessage({ messageId: 200, groupedId: "group-B", mediaUrl: "https://example.com/b1.jpg" })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)

    await vi.advanceTimersByTimeAsync(10001)

    const [result1, result2] = await Promise.all([p1, p2])

    // Each group has one message — each is the first (and only) resolver, so both get results
    expect(result1).not.toBeNull()
    expect(result2).not.toBeNull()
    expect(result1!.groupedId).toBe("group-A")
    expect(result2!.groupedId).toBe("group-B")
    expect(result1!.messageIds).not.toContain(200)
    expect(result2!.messageIds).not.toContain(100)
  })
})

// ---------------------------------------------------------------------------
// 5. flushAll()
//    Per spec section 2.5 item 2: graceful shutdown must flush in-progress items.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — flushAll()", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("flushAll() returns all pending groups immediately without waiting for debounce", async () => {
    const msg1 = makeMessage({ messageId: 1, groupedId: "grp-1" })
    const msg2 = makeMessage({ messageId: 2, groupedId: "grp-2" })

    grouper.add(msg1)
    grouper.add(msg2)

    // Do NOT advance timers — flush immediately
    const flushed = grouper.flushAll()

    expect(flushed).toHaveLength(2)
  })

  it("flushAll() causes pending group promises to resolve", async () => {
    const msg = makeMessage({ messageId: 10, groupedId: "grp-flush" })
    const promise = grouper.add(msg)

    grouper.flushAll()

    // Promise must now be settled (first resolver gets the result)
    const result = await promise
    expect(result).not.toBeNull()
    expect(result!.messageIds).toContain(10)
  })

  it("pendingCount becomes 0 after flushAll()", () => {
    const msg1 = makeMessage({ messageId: 1, groupedId: "g1" })
    const msg2 = makeMessage({ messageId: 2, groupedId: "g2" })

    grouper.add(msg1)
    grouper.add(msg2)

    expect(grouper.pendingCount).toBe(2)

    grouper.flushAll()

    expect(grouper.pendingCount).toBe(0)
  })

  it("flushAll() returns empty array when there are no pending groups", () => {
    const result = grouper.flushAll()
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe("AlbumGrouper — edge cases", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("album message with text=null (media-only) still produces a valid GroupedMessage", async () => {
    const gid = "edge-001"
    const msg = makeMessage({ messageId: 1, groupedId: gid, text: null, mediaUrl: "https://example.com/img.jpg" })

    const p = grouper.add(msg)
    await vi.advanceTimersByTimeAsync(10001)
    const result = await p

    expect(result).not.toBeNull()
    expect(result!.text).toBeNull()
    expect(result!.mediaUrls).toEqual(["https://example.com/img.jpg"])
  })

  it("only the message with text contributes text when others are null", async () => {
    const gid = "edge-002"
    const msgNoText = makeMessage({ messageId: 1, groupedId: gid, text: null, mediaUrl: "https://example.com/a.jpg" })
    const msgWithText = makeMessage({ messageId: 2, groupedId: gid, text: "The only caption", mediaUrl: "https://example.com/b.jpg" })
    const msgNoText2 = makeMessage({ messageId: 3, groupedId: gid, text: null, mediaUrl: "https://example.com/c.jpg" })

    const p1 = grouper.add(msgNoText)
    const p2 = grouper.add(msgWithText)
    const p3 = grouper.add(msgNoText2)

    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1

    expect(result).not.toBeNull()
    expect(result!.text).toBe("The only caption")
    expect(result!.mediaUrls).toHaveLength(3)

    // Non-primary resolvers get null
    expect(await p2).toBeNull()
    expect(await p3).toBeNull()
  })

  it("album with 3+ messages merges all messageIds and mediaUrls (only first resolver gets result)", async () => {
    const gid = "edge-003"
    const messages = [
      makeMessage({ messageId: 10, groupedId: gid, mediaUrl: "https://example.com/1.jpg", date: 1700000000 }),
      makeMessage({ messageId: 11, groupedId: gid, mediaUrl: "https://example.com/2.jpg", date: 1700000001 }),
      makeMessage({ messageId: 12, groupedId: gid, mediaUrl: "https://example.com/3.jpg", date: 1700000002 }),
      makeMessage({ messageId: 13, groupedId: gid, text: "Caption for 4th", mediaUrl: "https://example.com/4.jpg", date: 1700000003 }),
    ]

    const promises = messages.map((m) => grouper.add(m))

    await vi.advanceTimersByTimeAsync(10001)
    const results = await Promise.all(promises)

    // Only the first resolver gets the full merged result
    const result = results[0]
    expect(result).not.toBeNull()
    expect(result!.messageIds).toHaveLength(4)
    expect(result!.messageIds).toEqual(expect.arrayContaining([10, 11, 12, 13]))
    expect(result!.mediaUrls).toHaveLength(4)
    expect(result!.primaryMessageId).toBe(10)

    // All other resolvers get null
    expect(results[1]).toBeNull()
    expect(results[2]).toBeNull()
    expect(results[3]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. telegramPostUrl propagation
// ---------------------------------------------------------------------------

describe("AlbumGrouper — telegramPostUrl propagation", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("passes telegramPostUrl through for a non-album message", async () => {
    const msg = makeMessage({
      messageId: 1,
      groupedId: null,
      telegramPostUrl: "https://t.me/someChannel/42",
    })
    const result = await grouper.add(msg)
    expect(result).not.toBeNull()
    expect(result!.telegramPostUrl).toBe("https://t.me/someChannel/42")
  })

  it("picks telegramPostUrl from first message with one in an album", async () => {
    const gid = "tgurl-001"
    const msg1 = makeMessage({ messageId: 10, groupedId: gid, telegramPostUrl: "https://t.me/ch/99", mediaUrl: "https://example.com/1.jpg" })
    const msg2 = makeMessage({ messageId: 11, groupedId: gid, telegramPostUrl: null, mediaUrl: "https://example.com/2.jpg" })

    const p1 = grouper.add(msg1)
    const p2 = grouper.add(msg2)
    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1
    expect(result).not.toBeNull()
    expect(result!.telegramPostUrl).toBe("https://t.me/ch/99")
    expect(await p2).toBeNull()
  })

  it("sets telegramPostUrl to null when no message in album has one", async () => {
    const gid = "tgurl-002"
    const msg1 = makeMessage({ messageId: 20, groupedId: gid, telegramPostUrl: null })
    const msg2 = makeMessage({ messageId: 21, groupedId: gid, telegramPostUrl: null })

    const p1 = grouper.add(msg1)
    grouper.add(msg2)
    await vi.advanceTimersByTimeAsync(10001)
    const result = await p1
    expect(result).not.toBeNull()
    expect(result!.telegramPostUrl).toBeNull()
  })

  it("returns null telegramPostUrl for a non-album direct message", async () => {
    const msg = makeMessage({
      messageId: 5,
      groupedId: null,
      telegramPostUrl: null,
    })
    const result = await grouper.add(msg)
    expect(result).not.toBeNull()
    expect(result!.telegramPostUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 8. Message ordering — messages must be sorted by messageId before field
//    extraction so that out-of-order delivery (due to variable download times)
//    produces deterministic, stable output.
// ---------------------------------------------------------------------------

describe("AlbumGrouper — message ordering (sort by messageId)", () => {
  let grouper: AlbumGrouper

  beforeEach(() => {
    vi.useFakeTimers()
    grouper = new AlbumGrouper(10000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("out-of-order album messages produce mediaUrls sorted by messageId", async () => {
    // Messages arrive in order [103, 101, 102] but should be sorted so that
    // mediaUrls reflect messageId order: a.jpg (101), b.jpg (102), c.jpg (103)
    const gid = "order-001"
    const p103 = grouper.add(makeMessage({ messageId: 103, groupedId: gid, mediaUrl: "c.jpg" }))
    const p101 = grouper.add(makeMessage({ messageId: 101, groupedId: gid, mediaUrl: "a.jpg" }))
    const p102 = grouper.add(makeMessage({ messageId: 102, groupedId: gid, mediaUrl: "b.jpg" }))

    await vi.advanceTimersByTimeAsync(10001)

    const result = await p103
    expect(result).not.toBeNull()
    expect(result!.mediaUrls).toEqual(["a.jpg", "b.jpg", "c.jpg"])

    expect(await p101).toBeNull()
    expect(await p102).toBeNull()
  })

  it("out-of-order album messages: primaryMessageId is the lowest messageId", async () => {
    // Messages arrive with ids [103, 101, 102]; lowest is 101
    const gid = "order-002"
    const p103 = grouper.add(makeMessage({ messageId: 103, groupedId: gid, mediaUrl: "c.jpg" }))
    const p101 = grouper.add(makeMessage({ messageId: 101, groupedId: gid, mediaUrl: "a.jpg" }))
    const p102 = grouper.add(makeMessage({ messageId: 102, groupedId: gid, mediaUrl: "b.jpg" }))

    await vi.advanceTimersByTimeAsync(10001)

    const result = await p103
    expect(result).not.toBeNull()
    expect(result!.primaryMessageId).toBe(101)

    expect(await p101).toBeNull()
    expect(await p102).toBeNull()
  })

  it("out-of-order album messages: messageIds are returned in ascending order", async () => {
    // Messages arrive with ids [103, 101, 102]; result should be [101, 102, 103]
    const gid = "order-003"
    const p103 = grouper.add(makeMessage({ messageId: 103, groupedId: gid, mediaUrl: "c.jpg" }))
    const p101 = grouper.add(makeMessage({ messageId: 101, groupedId: gid, mediaUrl: "a.jpg" }))
    const p102 = grouper.add(makeMessage({ messageId: 102, groupedId: gid, mediaUrl: "b.jpg" }))

    await vi.advanceTimersByTimeAsync(10001)

    const result = await p103
    expect(result).not.toBeNull()
    expect(result!.messageIds).toEqual([101, 102, 103])

    expect(await p101).toBeNull()
    expect(await p102).toBeNull()
  })

  it("out-of-order album messages: text comes from the message with the lowest messageId that has text", async () => {
    // Messages arrive with ids [102, 101, 103].
    // Message 102 (inserted first) has text "Wrong caption".
    // Message 101 (inserted second, but lower id) has text "Caption here".
    // Without sort: find() picks 102 → "Wrong caption".
    // With sort by messageId: find() picks 101 → "Caption here".
    const gid = "order-004"
    const p102 = grouper.add(makeMessage({ messageId: 102, groupedId: gid, text: "Wrong caption", mediaUrl: "b.jpg" }))
    const p101 = grouper.add(makeMessage({ messageId: 101, groupedId: gid, text: "Caption here", mediaUrl: "a.jpg" }))
    const p103 = grouper.add(makeMessage({ messageId: 103, groupedId: gid, text: null, mediaUrl: "c.jpg" }))

    await vi.advanceTimersByTimeAsync(10001)

    const result = await p102
    expect(result).not.toBeNull()
    // After sorting by messageId, message 101 (lowest id with text) appears first
    expect(result!.text).toBe("Caption here")

    expect(await p101).toBeNull()
    expect(await p103).toBeNull()
  })
})
