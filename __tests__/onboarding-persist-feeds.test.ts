// @vitest-environment jsdom

/**
 * persistFeeds() — retry + toast warning on failure
 *
 * Tests the NEW behavior of persistFeeds() (not yet implemented):
 *   - On first failure, retries once with a 3s AbortController timeout
 *   - After both failures, shows toast.warning with a reassuring message
 *   - Does NOT throw — resolves normally after warning
 *   - On success (first or retry), no toast shown
 *
 * Spec criteria covered:
 *   AC-1: On first fetch failure, a retry attempt is made (fetch called twice total)
 *   AC-2: Retry has a 3s timeout (AbortController with 3000ms signal)
 *   AC-3: After both attempts fail, toast.warning() is shown with reassuring message
 *   AC-4: On success (first attempt), fetch is called only once and no toast is shown
 *   EC-1: First attempt fails, retry succeeds — fetch called twice, no toast shown
 *   EC-2: First attempt succeeds — no retry, no toast
 *   ERR-1: Both attempts fail with network error — toast.warning shown, no throw
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import { toast } from "sonner"
import { persistFeeds } from "@/lib/onboarding-persist"
import type { ExtractedFeed } from "@/lib/onboarding-types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_FEEDS: ExtractedFeed[] = [
  { url: "https://example.com/rss", name: "Example Blog", type: "RSS", status: "found" },
  { url: "https://other.com/feed", name: "Other Feed", type: "RSS", status: "found" },
]

const OK_RESPONSE = new Response(JSON.stringify({ ok: true }), { status: 200 })
const FAIL_RESPONSE = new Response(JSON.stringify({ error: "Server Error" }), { status: 500 })

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", vi.fn())
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistFeeds() — retry and toast warning (BUG-3)", () => {
  it("AC-4: on first attempt success, fetch is called exactly once and no toast is shown", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(OK_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("EC-2: first attempt succeeds — no retry, no toast (same as AC-4, explicit EC coverage)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(OK_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("AC-1: on first fetch failure, a retry attempt is made (fetch called twice total)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FAIL_RESPONSE)
      .mockResolvedValueOnce(FAIL_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("AC-2: retry attempt uses an AbortController signal with a 3s timeout", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FAIL_RESPONSE)
      .mockResolvedValueOnce(FAIL_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    // The second (retry) call must include a signal
    const retryCalls = vi.mocked(fetch).mock.calls
    expect(retryCalls.length).toBe(2)

    const retryCallOptions = retryCalls[1][1] as RequestInit
    expect(retryCallOptions).toBeDefined()
    expect(retryCallOptions.signal).toBeDefined()
    expect(retryCallOptions.signal).toBeInstanceOf(AbortSignal)
  })

  it("AC-3: after both attempts fail, toast.warning() is shown with a reassuring message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FAIL_RESPONSE)
      .mockResolvedValueOnce(FAIL_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const warningMessage = vi.mocked(toast.warning).mock.calls[0][0] as string
    expect(warningMessage).toContain("Couldn't save your progress to the server")
  })

  it("EC-1: first attempt fails, retry succeeds — fetch called twice, no toast shown", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FAIL_RESPONSE)
      .mockResolvedValueOnce(OK_RESPONSE)

    await persistFeeds(SAMPLE_FEEDS)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("ERR-1: both attempts fail with network error — toast.warning shown, function does NOT throw", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))

    // Must resolve normally — no throw
    await expect(persistFeeds(SAMPLE_FEEDS)).resolves.toBeUndefined()

    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})
