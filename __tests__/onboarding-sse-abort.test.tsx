// @vitest-environment jsdom

/**
 * BUG-4: AbortController for SSE stream
 *
 * Tests that the ImportFeedsPage uses an AbortController so that:
 *   AC-1  fetch is called with an AbortSignal
 *   AC-2  clicking "Skip, I'll add later" aborts the in-flight signal
 *   AC-3  AbortError in catch block is suppressed (no error shown to user)
 *   EC-1  with no parse in flight, Skip routes a first-time user to preferences without error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// userEvent is set up with `delay: null` throughout this file. By default
// userEvent awaits a real macrotask between keystrokes, so typing an n-character
// string costs n trips through a contended event loop — the dominant cost in
// these tests and the reason they timed out when the machine was busy while
// passing in isolation. Nothing here depends on time passing between keystrokes.
import React from "react"

// ─── next/navigation mock ────────────────────────────────────────────────────

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

// ─── persistFeeds mock (not under test here) ─────────────────────────────────

vi.mock("@/lib/onboarding-persist", () => ({
  persistFeeds: vi.fn().mockResolvedValue(undefined),
}))

// ─── sessionStorage stub ─────────────────────────────────────────────────────

Object.defineProperty(globalThis, "sessionStorage", {
  value: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
  writable: true,
})

// ─── Import page after mocks ─────────────────────────────────────────────────

import ImportFeedsPage from "@/app/onboarding/feeds/page"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a fetch mock that:
 * - Captures the AbortSignal passed by the caller
 * - Returns a never-resolving SSE-like ReadableStream body (simulates in-flight parsing)
 * - Records the signal so tests can inspect it
 */
function makeNeverResolvingFetchMock() {
  let capturedSignal: AbortSignal | undefined

  const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    capturedSignal = opts?.signal as AbortSignal | undefined

    const stream = new ReadableStream({
      start() {
        // Intentionally never enqueues or closes — simulates SSE streaming in progress
      },
    })

    return Promise.resolve(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    )
  })

  return { fetchMock, getCapturedSignal: () => capturedSignal }
}

// The page reads /api/user-settings on mount to tell a returning user from a
// first-time one (RAD-168). Every case here is a first-time user; the stub
// answers that call itself so `fetchMock` records only the parse request.
function stubFetch(parseFetch: (url: string, opts?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", (url: string, opts?: RequestInit) =>
    url === "/api/user-settings"
      ? Promise.resolve(new Response(JSON.stringify({ onboardingCompleted: false }), { status: 200 }))
      : parseFetch(url, opts),
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ImportFeedsPage — AbortController for SSE stream (BUG-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPush.mockReset()
  })

  it("AC-1: fetch is called with an options object containing a signal property", async () => {
    const { fetchMock } = makeNeverResolvingFetchMock()
    stubFetch(fetchMock)

    const user = userEvent.setup({ delay: null })
    render(<ImportFeedsPage />)

    // Type something so the Submit button is enabled
    const textarea = screen.getByRole("textbox")
    await user.type(textarea, "https://example.com/feed.xml")

    const submitButton = screen.getByRole("button", { name: /find feeds/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(opts).toHaveProperty("signal")
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it("AC-2: clicking Skip while fetch is in-flight aborts the captured signal", async () => {
    let capturedSignal: AbortSignal | undefined
    // The fetch never resolves — page stays in isLoading=true (input state), Skip button remains visible
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      capturedSignal = opts?.signal as AbortSignal | undefined
      return new Promise<Response>(() => { /* never resolves */ })
    })
    stubFetch(fetchMock)

    const user = userEvent.setup({ delay: null })
    render(<ImportFeedsPage />)

    const textarea = screen.getByRole("textbox")
    await user.type(textarea, "https://example.com/feed.xml")

    const submitButton = screen.getByRole("button", { name: /find feeds/i })
    // Click submit — fetch hangs, page stays in input state with loading spinner
    await user.click(submitButton)

    // Wait for fetch to be called (so the signal is captured)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    // Skip button is still in the DOM (input state, isLoading=true)
    const skipButton = screen.getByRole("button", { name: /skip/i })
    await user.click(skipButton)

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(true)
  })

  it("AC-3: AbortError from fetch does not show an error message to the user", async () => {
    // Fetch immediately rejects with an AbortError (simulates signal fired mid-stream)
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            const err = new DOMException("The operation was aborted.", "AbortError")
            reject(err)
          })
        }
        // If no signal, reject immediately to make the test determinate
        setTimeout(() => {
          const err = new DOMException("The operation was aborted.", "AbortError")
          reject(err)
        }, 50)
      })
    })
    stubFetch(fetchMock)

    const user = userEvent.setup({ delay: null })
    render(<ImportFeedsPage />)

    const textarea = screen.getByRole("textbox")
    await user.type(textarea, "https://example.com/feed.xml")

    const submitButton = screen.getByRole("button", { name: /find feeds/i })
    await user.click(submitButton)

    // Wait for the AbortError to propagate
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    // Give the catch block time to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 100))
    })

    // No error message should be visible
    const errorEl = screen.queryByText(/error/i)
    expect(errorEl).toBeNull()
  })

  it("EC-1: clicking Skip with no parse in flight routes a first-time user to /onboarding/preferences without error", async () => {
    // Only the settings read runs (answered by stubFetch); the parse fetch is never called in this path.
    stubFetch(vi.fn())

    const user = userEvent.setup({ delay: null })
    render(<ImportFeedsPage />)

    const skipButton = screen.getByRole("button", { name: /skip/i })
    await user.click(skipButton)

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/onboarding/preferences"))

    // No error text should be visible
    const errorEl = screen.queryByText(/error/i)
    expect(errorEl).toBeNull()
  })
})
