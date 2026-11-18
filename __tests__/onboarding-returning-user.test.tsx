// @vitest-environment jsdom

/**
 * RAD-168 — the onboarding path for a returning user.
 *
 * The revisit gate sends a user who finished onboarding before back to
 * `/onboarding/feeds?revisit=1`. The `revisit` param is cosmetic: it picks the
 * welcome-back copy and hides the Preferences phase, so nothing flashes while
 * settings load. Where skip and save GO is decided by `onboardingCompleted`
 * from `GET /api/user-settings`, tri-state: known returning → /posts; known
 * first-time or unknown (failed / timed out) → /onboarding/preferences, whose
 * server guard bounces a returning user to /posts.
 *
 *   AC-1  ?revisit=1 → "Welcome back" heading + "Not now — go to dashboard", Preferences phase hidden,
 *         even while settings are still loading (no flash)
 *   AC-2  no param → first-time copy and phases, even for a user whose settings say returning
 *   AC-3  skip clicked BEFORE settings resolve waits for them: returning → /posts, first-time → preferences;
 *         the button is disabled while pending, so a double click pushes once
 *   AC-4  settings fetch fails → skip goes to /onboarding/preferences; the fetch carries a timeout signal
 *   AC-5  ?revisit=1 clears the stale onboardingState (PATCH { onboardingState: null }); no param → no PATCH
 *   AC-6  ?revisit=1 is carried to review and unresolved (stepper, Back, Skip links)
 *   AC-7  review save: returning → /posts; first-time → preferences; settings failed → preferences
 *   AC-8  review save that created nothing: X-only → "X feeds need Radaric Pro — N skipped", otherwise
 *         "No new feeds were added"; no navigation, Save re-enabled. Already-existing feeds still navigate.
 *   AC-9  review save that created some and skipped X feeds → informational toast, then navigates
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import React, { Suspense } from "react"

// One router object, as in Next: the review page's effect depends on it, and a
// fresh object per render would re-run the settings fetch on every render.
const { mockPush, router } = vi.hoisted(() => {
  const mockPush = vi.fn()
  return { mockPush, router: { push: mockPush } }
})
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

vi.mock("@/lib/onboarding-persist", () => ({
  persistFeeds: vi.fn().mockResolvedValue(undefined),
}))

// The discovery view is not under test; a button stands in for its onComplete.
vi.mock("@/components/onboarding/feed-discovery-progress", () => ({
  FeedDiscoveryProgress: ({ onComplete }: { onComplete: (feeds: unknown[]) => void }) => (
    <button onClick={() => onComplete([])}>discovery-done</button>
  ),
}))

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
)
vi.mock("sonner", () => ({ toast: toastMock }))

const storage = new Map<string, string>()
Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: vi.fn((k: string) => storage.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void storage.set(k, v)),
    removeItem: vi.fn((k: string) => void storage.delete(k)),
  },
  writable: true,
})

import ImportFeedsPage from "@/app/onboarding/feeds/page"
import ReviewFeedsPage from "@/app/onboarding/review/page"
import UnresolvedFeedsPage from "@/app/onboarding/unresolved/page"
import type { ExtractedFeed } from "@/lib/onboarding-types"

const FEEDS: ExtractedFeed[] = [
  { url: "https://example.com/feed.xml", name: "Example Blog", type: "RSS", status: "found", feedUrl: "https://example.com/feed.xml" },
  { url: "https://t.me/s/techcabal", name: "TechCabal", type: "TELEGRAM", status: "found" },
]

type Page = (props: { searchParams?: Promise<Record<string, string>> }) => React.ReactNode

// A page given searchParams suspends on use() until the promise settles; React 19
// only resumes a suspended tree inside an awaited act().
async function renderPage(Page: unknown, params?: Record<string, string>) {
  const P = Page as Page
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <P searchParams={params ? Promise.resolve(params) : undefined} />
      </Suspense>,
    )
  })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

type Calls = Array<[string, RequestInit | undefined]>

/**
 * Routes the onboarding fetches. `settings` is a factory (a Response body reads
 * once, and the mocked router re-runs effects), or a promise to control timing.
 */
function stubFetch(opts: {
  settings?: () => Response | Promise<Response>
  save?: Record<string, number>
  parse?: () => Promise<Response>
}) {
  const calls: Calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init])
    if (url === "/api/user-settings" && init?.method === "PATCH") return json({})
    if (url === "/api/user-settings") {
      return opts.settings ? opts.settings() : json({ onboardingCompleted: false })
    }
    if (url === "/api/onboarding/save-feeds") return json(opts.save ?? { created: 2, skipped: 0, twitterSkipped: 0 }, 201)
    if (url === "/api/onboarding/parse-feeds" && opts.parse) return opts.parse()
    throw new Error(`unexpected fetch ${url}`)
  }))
  return calls
}

function settings(onboardingCompleted: boolean, extra: Record<string, unknown> = {}) {
  return json({ onboardingCompleted, onboardingState: { version: 1, step: "review", extractedFeeds: FEEDS }, ...extra })
}

function deferred() {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => { resolve = r })
  return { promise, resolve }
}

function phases() {
  return screen.getByRole("navigation", { name: "Onboarding progress" })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPush.mockReset()
  storage.clear()
})

describe("/onboarding/feeds — copy comes from ?revisit=1", () => {
  it("AC-1: ?revisit=1 shows the welcome-back copy and hides Preferences, while settings are still loading", async () => {
    stubFetch({ settings: () => new Promise<Response>(() => {}) })
    await renderPage(ImportFeedsPage, { revisit: "1" })

    expect(await screen.findByRole("heading", { name: "Welcome back — add your first feed" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Not now — go to dashboard" })).toBeInTheDocument()
    expect(phases()).not.toHaveTextContent("Preferences")
    expect(screen.queryByText("Add your feeds")).toBeNull()
  })

  it("AC-2: without the param the first-time copy shows, even when settings say returning", async () => {
    const calls = stubFetch({ settings: () => settings(true) })
    await renderPage(ImportFeedsPage)

    await waitFor(() => expect(calls.some(([u]) => u === "/api/user-settings")).toBe(true))
    expect(screen.getByRole("heading", { name: "Add your feeds" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /skip, i.ll add later/i })).toBeInTheDocument()
    expect(phases()).toHaveTextContent("Preferences")
  })
})

describe("/onboarding/feeds — skip destination comes from settings", () => {
  it.each([
    [true, "/posts"],
    [false, "/onboarding/preferences"],
  ])("AC-3: skip clicked before settings resolve waits for them (onboardingCompleted=%s → %s)", async (completed, target) => {
    const d = deferred()
    stubFetch({ settings: () => d.promise })
    const user = userEvent.setup({ delay: null })
    await renderPage(ImportFeedsPage, { revisit: "1" })

    const skip = await screen.findByRole("button", { name: "Not now — go to dashboard" })
    await user.click(skip)
    expect(mockPush).not.toHaveBeenCalled()
    expect(skip).toBeDisabled()

    await act(async () => d.resolve(settings(completed)))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(target))
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it("AC-3: a double click while pending pushes once", async () => {
    const d = deferred()
    stubFetch({ settings: () => d.promise })
    const user = userEvent.setup({ delay: null })
    await renderPage(ImportFeedsPage)

    const skip = await screen.findByRole("button", { name: /skip/i })
    await user.click(skip)
    await user.click(skip)
    await act(async () => d.resolve(settings(false)))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/onboarding/preferences"))
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it("AC-4: when the settings fetch fails, skip goes to /onboarding/preferences (the server guard handles a returning user)", async () => {
    const calls = stubFetch({ settings: () => Promise.reject(new TypeError("network down")) })
    const user = userEvent.setup({ delay: null })
    await renderPage(ImportFeedsPage, { revisit: "1" })

    await user.click(await screen.findByRole("button", { name: "Not now — go to dashboard" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/onboarding/preferences"))
    const read = calls.find(([u, i]) => u === "/api/user-settings" && i?.method !== "PATCH")
    expect(read?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("/onboarding/feeds — revisit housekeeping", () => {
  it("AC-5: ?revisit=1 clears the stale onboardingState", async () => {
    const calls = stubFetch({ settings: () => settings(true) })
    await renderPage(ImportFeedsPage, { revisit: "1" })

    await waitFor(() => {
      const patch = calls.find(([u, i]) => u === "/api/user-settings" && i?.method === "PATCH")
      expect(patch).toBeDefined()
      expect(JSON.parse(String(patch![1]!.body))).toEqual({ onboardingState: null })
    })
  })

  it("AC-5: without the param nothing is cleared", async () => {
    const calls = stubFetch({ settings: () => settings(false) })
    await renderPage(ImportFeedsPage)

    await waitFor(() => expect(calls.some(([u]) => u === "/api/user-settings")).toBe(true))
    expect(calls.some(([, i]) => i?.method === "PATCH")).toBe(false)
  })

  it("AC-6: discovery carries ?revisit=1 on to review", async () => {
    stubFetch({ settings: () => settings(true), parse: async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }) })
    const user = userEvent.setup({ delay: null })
    await renderPage(ImportFeedsPage, { revisit: "1" })

    await user.type(await screen.findByRole("textbox"), "https://example.com/feed.xml")
    await user.click(screen.getByRole("button", { name: /find feeds/i }))
    await user.click(await screen.findByRole("button", { name: "discovery-done" }))

    expect(mockPush).toHaveBeenCalledWith("/onboarding/review?revisit=1")
  })
})

describe("/onboarding/unresolved — RAD-168", () => {
  it("AC-6: ?revisit=1 hides Preferences and Skip keeps the param", async () => {
    storage.set("onboarding:feeds", JSON.stringify([{ url: "https://site.example", name: "Site", type: "WEBSITE", status: "not_found" }]))
    stubFetch({})
    const user = userEvent.setup({ delay: null })
    await renderPage(UnresolvedFeedsPage, { revisit: "1" })

    await user.click(await screen.findByRole("button", { name: /skip these feeds/i }))
    expect(phases()).not.toHaveTextContent("Preferences")
    expect(mockPush).toHaveBeenCalledWith("/onboarding/review?revisit=1")
  })
})

describe("/onboarding/review — RAD-168", () => {
  it("AC-6: ?revisit=1 hides Preferences and Back keeps the param", async () => {
    stubFetch({ settings: () => settings(true) })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage, { revisit: "1" })

    await screen.findByRole("button", { name: "Save 2 feeds" })
    expect(phases()).not.toHaveTextContent("Preferences")
    await user.click(screen.getByRole("button", { name: /back/i }))
    expect(mockPush).toHaveBeenCalledWith("/onboarding/feeds?revisit=1")
  })

  it.each([
    ["returning", "/posts", () => settings(true)],
    ["first-time", "/onboarding/preferences", () => settings(false)],
  ])("AC-7: a %s user saving feeds goes to %s", async (_who, target, s) => {
    stubFetch({ settings: s })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage)

    await user.click(await screen.findByRole("button", { name: "Save 2 feeds" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(target))
  })

  it("AC-7: when the settings fetch failed, saving goes to /onboarding/preferences", async () => {
    storage.set("onboarding:feeds", JSON.stringify(FEEDS))
    stubFetch({ settings: () => Promise.reject(new TypeError("network down")) })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage)

    await user.click(await screen.findByRole("button", { name: "Save 2 feeds" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/onboarding/preferences"))
  })

  it.each([
    [{ created: 0, skipped: 0, twitterSkipped: 2 }, "X feeds need Radaric Pro — 2 skipped"],
    [{ created: 0, skipped: 0, twitterSkipped: 0, telegramSkipped: 2 }, "No new feeds were added"],
  ])("AC-8: a save that created nothing stays put and says why (%o)", async (save, message) => {
    stubFetch({ settings: () => settings(true), save })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage)

    const button = await screen.findByRole("button", { name: "Save 2 feeds" })
    await user.click(button)

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(message))
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save 2 feeds" })).toBeEnabled()
  })

  it("AC-8: feeds that already exist are not an error — the save still navigates", async () => {
    stubFetch({ settings: () => settings(true), save: { created: 0, skipped: 2, twitterSkipped: 0 } })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage)

    await user.click(await screen.findByRole("button", { name: "Save 2 feeds" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/posts"))
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("AC-9: some created and some X feeds skipped → an informational toast, then navigation", async () => {
    stubFetch({ settings: () => settings(true), save: { created: 1, skipped: 0, twitterSkipped: 1 } })
    const user = userEvent.setup({ delay: null })
    await renderPage(ReviewFeedsPage)

    await user.click(await screen.findByRole("button", { name: "Save 2 feeds" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/posts"))
    expect(toastMock).toHaveBeenCalledWith("X feeds need Radaric Pro — 1 skipped")
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
