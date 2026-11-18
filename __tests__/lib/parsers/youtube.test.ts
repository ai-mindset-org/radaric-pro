import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseYouTubeChannel } from "@/lib/parsers/youtube"

const UC = "UCBJycsmduvYEL83R_U4JriQ"
const CHANNEL_URL = `https://www.youtube.com/channel/${UC}`

// ---------------------------------------------------------------------------
// Mock youtube-transcript-plus (transcripts keyed per videoId in each test)
// ---------------------------------------------------------------------------

vi.mock("youtube-transcript-plus", () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
}))

async function getTranscriptMock() {
  const { YoutubeTranscript } = await import("youtube-transcript-plus")
  return vi.mocked(YoutubeTranscript.fetchTranscript)
}

// ---------------------------------------------------------------------------
// Fixture: channel Atom feed XML (mirrors the real videos.xml structure)
// ---------------------------------------------------------------------------

interface FixtureEntry {
  videoId: string
  title: string
  description?: string
  published?: string
}

function feedXml(entries: FixtureEntry[], channelTitle = "Test Channel"): string {
  const entryXml = entries
    .map(
      (e) => `
 <entry>
  <id>yt:video:${e.videoId}</id>
  <yt:videoId>${e.videoId}</yt:videoId>
  <yt:channelId>${UC}</yt:channelId>
  <title>${e.title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${e.videoId}"/>
  <author><name>${channelTitle}</name></author>
  <published>${e.published ?? "2026-07-02T20:42:45+00:00"}</published>
  <updated>2026-07-03T08:45:33+00:00</updated>
  <media:group>
   <media:title>${e.title}</media:title>
   <media:thumbnail url="https://i4.ytimg.com/vi/${e.videoId}/hqdefault.jpg" width="480" height="360"/>
   <media:description>${e.description ?? ""}</media:description>
  </media:group>
 </entry>`
    )
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${UC}"/>
 <id>yt:channel:${UC.slice(2)}</id>
 <yt:channelId>${UC.slice(2)}</yt:channelId>
 <title>${channelTitle}</title>
 <link rel="alternate" href="${CHANNEL_URL}"/>
${entryXml}
</feed>`
}

function segments(text: string) {
  return text.split(" ").map((word) => ({ text: word }))
}

// Video ids must be exactly 11 chars [A-Za-z0-9_-]
const VID = (n: number) => `vid${String(n).padStart(8, "0")}`

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  const transcript = await getTranscriptMock()
  transcript.mockReset()
})

function mockFeedResponse(xml: string) {
  fetchMock.mockResolvedValue({ ok: true, text: async () => xml })
}

describe("parseYouTubeChannel", () => {
  it("maps feed entries to ParsedItems (externalId, url, title, date, thumbnail)", async () => {
    mockFeedResponse(feedXml([{ videoId: VID(1), title: "First Video", description: "About things" }]))
    const transcript = await getTranscriptMock()
    transcript.mockResolvedValue(segments("hello world transcript"))

    const items = await parseYouTubeChannel(CHANNEL_URL)

    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.externalId).toBe(`youtube:${VID(1)}`)
    expect(item.url).toBe(`https://www.youtube.com/watch?v=${VID(1)}`)
    expect(item.title).toBe("First Video")
    expect(item.publishedAt).toEqual(new Date("2026-07-02T20:42:45+00:00"))
    expect(item.thumbnailUrl).toBe(`https://i4.ytimg.com/vi/${VID(1)}/hqdefault.jpg`)
    expect(item.mediaUrls).toEqual([`https://i4.ytimg.com/vi/${VID(1)}/hqdefault.jpg`])
    // Feed XML is fetched from the derived videos.xml URL
    expect(String(fetchMock.mock.calls[0][0])).toContain(`feeds/videos.xml?channel_id=${UC}`)
  })

  it("assembles content as header + description + transcript", async () => {
    mockFeedResponse(
      feedXml([{ videoId: VID(2), title: "Deep Dive", description: "A look at the thing." }], "My Channel")
    )
    const transcript = await getTranscriptMock()
    transcript.mockResolvedValue(segments("welcome to the video"))

    const [item] = await parseYouTubeChannel(CHANNEL_URL)

    expect(item.content).toContain("Video: Deep Dive")
    expect(item.content).toContain("Channel: My Channel")
    expect(item.content).toContain("A look at the thing.")
    expect(item.content).toContain("Transcript:\nwelcome to the video")
    // Header comes first so the 3k eval slice sees title/channel/description
    expect(item.content.indexOf("Video:")).toBeLessThan(item.content.indexOf("Transcript:"))
    expect(item.content.indexOf("A look at the thing.")).toBeLessThan(item.content.indexOf("Transcript:"))
  })

  it("falls back to title + description when the transcript is unavailable", async () => {
    mockFeedResponse(feedXml([{ videoId: VID(3), title: "No Captions", description: "Still useful." }]))
    const transcript = await getTranscriptMock()
    transcript.mockRejectedValue(new Error("Transcript is disabled"))

    const [item] = await parseYouTubeChannel(CHANNEL_URL)

    expect(item.content).toContain("Video: No Captions")
    expect(item.content).toContain("Still useful.")
    expect(item.content).not.toContain("Transcript:")
  })

  it("A1: one failing transcript degrades only that video — the rest keep theirs", async () => {
    const entries = [1, 2, 3, 4].map((n) => ({
      videoId: VID(n),
      title: `Video ${n}`,
      description: `Description ${n}`,
    }))
    mockFeedResponse(feedXml(entries))
    const transcript = await getTranscriptMock()
    transcript.mockImplementation(async (videoId: string) => {
      if (videoId === VID(2)) throw new Error("boom")
      return segments(`transcript for ${videoId}`)
    })

    const items = await parseYouTubeChannel(CHANNEL_URL)

    expect(items).toHaveLength(4)
    const failed = items.find((i) => i.externalId === `youtube:${VID(2)}`)!
    const ok = items.filter((i) => i.externalId !== `youtube:${VID(2)}`)
    expect(failed.content).not.toContain("Transcript:")
    expect(failed.content).toContain("Description 2")
    for (const item of ok) {
      expect(item.content).toContain("Transcript:")
    }
  })

  it("A1: a hung transcript fetch is timed out and degrades only that video", async () => {
    mockFeedResponse(
      feedXml([
        { videoId: VID(5), title: "Hangs" },
        { videoId: VID(6), title: "Fine" },
      ])
    )
    const transcript = await getTranscriptMock()
    transcript.mockImplementation(async (videoId: string) => {
      if (videoId === VID(5)) return new Promise(() => {}) // never settles
      return segments("quick transcript")
    })

    const items = await parseYouTubeChannel(CHANNEL_URL, { transcriptTimeoutMs: 50 })

    expect(items).toHaveLength(2)
    const hung = items.find((i) => i.externalId === `youtube:${VID(5)}`)!
    const fine = items.find((i) => i.externalId === `youtube:${VID(6)}`)!
    expect(hung.content).not.toContain("Transcript:")
    expect(fine.content).toContain("Transcript:")
  })

  it("A2: skips transcript fetch for known external ids (one-way door pinned)", async () => {
    mockFeedResponse(
      feedXml([
        { videoId: VID(7), title: "Known", description: "Old" },
        { videoId: VID(8), title: "New", description: "Fresh" },
      ])
    )
    const transcript = await getTranscriptMock()
    transcript.mockResolvedValue(segments("some words"))

    const items = await parseYouTubeChannel(CHANNEL_URL, {
      knownExternalIds: new Set([`youtube:${VID(7)}`]),
    })

    // Known item is still returned (route-level dedup drops it) but got no transcript call
    expect(items).toHaveLength(2)
    expect(transcript).toHaveBeenCalledTimes(1)
    expect(transcript).toHaveBeenCalledWith(VID(8))
    const known = items.find((i) => i.externalId === `youtube:${VID(7)}`)!
    expect(known.content).not.toContain("Transcript:")
  })

  it("A4: retains up to ~12k chars of transcript (not the 3k eval slice)", async () => {
    mockFeedResponse(feedXml([{ videoId: VID(9), title: "Long" }]))
    const transcript = await getTranscriptMock()
    // ~17.5k chars of transcript
    transcript.mockResolvedValue(segments(Array.from({ length: 3500 }, (_, i) => `word${i}`).join(" ")))

    const [item] = await parseYouTubeChannel(CHANNEL_URL)

    const transcriptPart = item.content.slice(item.content.indexOf("Transcript:"))
    expect(transcriptPart.length).toBeGreaterThan(11_000)
    expect(transcriptPart.length).toBeLessThanOrEqual(12_100)
  })

  it("throws when the feed fetch fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await expect(parseYouTubeChannel(CHANNEL_URL)).rejects.toThrow(/404/)
  })

  it("resolves a non-canonical URL that slipped through before fetching the feed", async () => {
    // 1st fetch: channel page (resolution), 2nd: feed XML
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `<html><head><meta property="og:url" content="${CHANNEL_URL}"></head></html>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => feedXml([{ videoId: VID(10), title: "Resolved" }]),
      })
    const transcript = await getTranscriptMock()
    transcript.mockResolvedValue(segments("ok"))

    const items = await parseYouTubeChannel("https://www.youtube.com/@somehandle")

    expect(items).toHaveLength(1)
    expect(items[0].externalId).toBe(`youtube:${VID(10)}`)
  })
})
