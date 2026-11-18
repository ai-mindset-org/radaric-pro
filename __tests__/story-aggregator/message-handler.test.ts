/**
 * Tests for Story Aggregator message handler.
 * Spec: the Story Aggregator specification, sections 4.1, 2.5
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  parseMessageToInboxData,
  ingestMessage,
  catchUpMessages,
  type RawTelegramMessage,
  type MessageHandlerDeps,
} from "@/lib/story-aggregator/message-handler"

const USER_ID = "user-abc-123"
const CHANNEL_ID = "-1009999999999"

function makeMessage(overrides: Partial<RawTelegramMessage> = {}): RawTelegramMessage {
  return {
    id: 12345,
    message: "Check out this article https://example.com/design",
    entities: [],
    media: null,
    groupedId: null,
    fwdFrom: null,
    peerId: { channelId: CHANNEL_ID },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

function buildDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    db: {
      inboxItem: {
        create: vi.fn().mockResolvedValue({ id: "item-new-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue({
          userId: USER_ID,
          storyInboxChannelId: CHANNEL_ID,
          storyLastMessageId: 12300,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    processItem: vi.fn().mockResolvedValue({ success: true }),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("parseMessageToInboxData", () => {
  it("extracts text from message.message field", () => {
    const msg = makeMessage({ message: "Hello world" })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.rawText).toBe("Hello world")
  })

  it("builds externalId from channelId:messageId format", () => {
    const msg = makeMessage({ id: 42 })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.externalId).toBe(`${CHANNEL_ID}:42`)
  })

  it("sets messageId from msg.id", () => {
    const msg = makeMessage({ id: 999 })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.messageId).toBe(999)
  })

  it("sets userId from the provided userId parameter", () => {
    const msg = makeMessage()
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.userId).toBe(USER_ID)
  })

  it("extracts URL from message text using simple URL pattern", () => {
    const msg = makeMessage({
      message: "Look at this: https://nngroup.com/articles/design-system very cool",
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.extractedUrl).toBe("https://nngroup.com/articles/design-system")
  })

  it("extracts URL from entities with className MessageEntityUrl", () => {
    const msg = makeMessage({
      message: "Check example.com/design",
      entities: [{ className: "MessageEntityUrl", offset: 6, length: 18 }],
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.extractedUrl).toBeTruthy()
  })

  it("extracts URL from entities with className MessageEntityTextUrl (hyperlinks)", () => {
    const msg = makeMessage({
      message: "Click here for details",
      entities: [
        { className: "MessageEntityTextUrl", offset: 0, length: 10, url: "https://hidden-url.com/article" },
      ],
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.extractedUrl).toBe("https://hidden-url.com/article")
  })

  it("extracts forwarded channel name from fwdFrom", () => {
    const msg = makeMessage({
      fwdFrom: {
        fromId: { channelId: "1234567890" },
        channelName: "Design Channel",
      },
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.sourceChannel).toBe("Design Channel")
    expect(data.forwardedFromId).toBe("1234567890")
  })

  it("returns null sourceChannel when not forwarded", () => {
    const msg = makeMessage({ fwdFrom: null })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.sourceChannel).toBeNull()
    expect(data.forwardedFromId).toBeNull()
  })

  it("extracts mediaUrls from media.photo", () => {
    const msg = makeMessage({
      media: { photoUrl: "https://r2.example.com/photo1.jpg" },
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.mediaUrls).toContain("https://r2.example.com/photo1.jpg")
  })

  it("handles messages with no text (media-only)", () => {
    const msg = makeMessage({
      message: "",
      media: { photoUrl: "https://r2.example.com/photo.jpg" },
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.rawText).toBe("")
    expect(data.mediaUrls.length).toBeGreaterThan(0)
  })

  it("extracts URL from webpage media", () => {
    const msg = makeMessage({
      message: "",
      media: { webpageUrl: "https://article.com/post" },
    })
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.extractedUrl).toBe("https://article.com/post")
  })

  it("defaults status to PENDING", () => {
    const msg = makeMessage()
    const data = parseMessageToInboxData(msg, CHANNEL_ID, USER_ID)
    expect(data.status).toBe("PENDING")
  })
})

describe("ingestMessage", () => {
  it("creates InboxItem in DB and returns its ID", async () => {
    const deps = buildDeps()
    const msg = makeMessage()
    const result = await ingestMessage(msg, CHANNEL_ID, USER_ID, deps)
    expect(deps.db.inboxItem.create).toHaveBeenCalledOnce()
    expect(result).toEqual({ id: "item-new-1", duplicate: false })
  })

  it("skips duplicate messages (same externalId already exists)", async () => {
    const deps = buildDeps({
      db: {
        inboxItem: {
          create: vi.fn(),
          findFirst: vi.fn().mockResolvedValue({ id: "existing-item" }),
        },
        userSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      },
    })
    const msg = makeMessage()
    const result = await ingestMessage(msg, CHANNEL_ID, USER_ID, deps)
    expect(deps.db.inboxItem.create).not.toHaveBeenCalled()
    expect(result).toEqual({ id: "existing-item", duplicate: true })
  })

  it("updates storyLastMessageId in user settings", async () => {
    const deps = buildDeps()
    const msg = makeMessage({ id: 500 })
    await ingestMessage(msg, CHANNEL_ID, USER_ID, deps)
    expect(deps.db.userSettings.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { storyLastMessageId: 500 },
    })
  })

  it("triggers pipeline processing for the new item", async () => {
    const deps = buildDeps()
    const msg = makeMessage()
    await ingestMessage(msg, CHANNEL_ID, USER_ID, deps)
    expect(deps.processItem).toHaveBeenCalledWith("item-new-1")
  })

  it("does not trigger pipeline for duplicate items", async () => {
    const deps = buildDeps({
      db: {
        inboxItem: {
          create: vi.fn(),
          findFirst: vi.fn().mockResolvedValue({ id: "existing-item" }),
        },
        userSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      },
    })
    const msg = makeMessage()
    await ingestMessage(msg, CHANNEL_ID, USER_ID, deps)
    expect(deps.processItem).not.toHaveBeenCalled()
  })
})

describe("catchUpMessages", () => {
  it("fetches messages after lastMessageId and processes each", async () => {
    const msgs = [makeMessage({ id: 12301 }), makeMessage({ id: 12302 })]
    const deps = buildDeps({
      getChannelMessages: vi.fn().mockResolvedValue(msgs),
    })
    const result = await catchUpMessages(CHANNEL_ID, USER_ID, 12300, deps)
    expect(deps.getChannelMessages).toHaveBeenCalledWith(CHANNEL_ID, 12300, 200)
    expect(result.processed).toBe(2)
  })

  it("caps fetch at 200 messages", async () => {
    const deps = buildDeps({
      getChannelMessages: vi.fn().mockResolvedValue([]),
    })
    await catchUpMessages(CHANNEL_ID, USER_ID, 0, deps)
    expect(deps.getChannelMessages).toHaveBeenCalledWith(CHANNEL_ID, 0, 200)
  })

  it("returns zero processed when no messages to catch up", async () => {
    const deps = buildDeps({
      getChannelMessages: vi.fn().mockResolvedValue([]),
    })
    const result = await catchUpMessages(CHANNEL_ID, USER_ID, 12300, deps)
    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
  })

  it("continues processing even if one message fails", async () => {
    const msgs = [makeMessage({ id: 12301 }), makeMessage({ id: 12302 }), makeMessage({ id: 12303 })]
    const createMock = vi.fn()
      .mockResolvedValueOnce({ id: "item-1" })
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce({ id: "item-3" })
    const deps = buildDeps({
      getChannelMessages: vi.fn().mockResolvedValue(msgs),
      db: {
        inboxItem: {
          create: createMock,
          findFirst: vi.fn().mockResolvedValue(null),
        },
        userSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      },
    })
    const result = await catchUpMessages(CHANNEL_ID, USER_ID, 12300, deps)
    expect(result.processed).toBe(2)
    expect(result.errors).toBe(1)
  })

  it("updates storyLastMessageId to the highest message ID", async () => {
    const msgs = [makeMessage({ id: 12305 }), makeMessage({ id: 12302 })]
    const deps = buildDeps({
      getChannelMessages: vi.fn().mockResolvedValue(msgs),
    })
    await catchUpMessages(CHANNEL_ID, USER_ID, 12300, deps)
    expect(deps.db.userSettings.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { storyLastMessageId: 12305 },
    })
  })
})
