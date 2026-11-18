// @vitest-environment jsdom

/**
 * RAD-363 slice 6 — TypographyProvider / useTypography: optimistic apply,
 * PATCH persistence, serialized saves (one in flight, newest queued), revert-to-confirmed on failure.
 * Spec: .tdd/spec-typography-provider.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from "sonner"
import { TypographyProvider, useTypography } from "@/components/providers/typography-provider"
import { buildTypographyCss } from "@/lib/typography/css"
import { DEFAULT_TYPOGRAPHY, parseTypographyPrefs, type TypographyPrefs } from "@/lib/typography/prefs"

const PREFS_A: TypographyPrefs = { heading: "martian-grotesk", text: "inter", counter: "inter", tag: "inter" }
const PREFS_B: TypographyPrefs = { heading: "inter", text: "pt-root-ui", counter: "inter", tag: "inter" }
const PREFS_C: TypographyPrefs = { heading: "inter", text: "inter", counter: "martian-mono", tag: "pt-root-ui" }

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  signal: AbortSignal | undefined
  init: RequestInit | undefined
}

/** A fetch mock whose every call returns a promise the test settles by hand. */
function installControlledFetch(): { fetchMock: ReturnType<typeof vi.fn>; calls: Deferred[] } {
  const calls: Deferred[] = []
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    calls.push({ promise, resolve, reject, signal: init?.signal ?? undefined, init })
    return promise
  })
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, calls }
}

function Consumer() {
  const { prefs, setPrefs } = useTypography()
  return (
    <div>
      <output data-testid="prefs">{JSON.stringify(prefs)}</output>
      <button onClick={() => setPrefs(PREFS_A)}>set-a</button>
      <button onClick={() => setPrefs(PREFS_B)}>set-b</button>
      <button onClick={() => setPrefs(PREFS_C)}>set-c</button>
      <button onClick={() => setPrefs(null)}>reset</button>
    </div>
  )
}

function renderProvider(initialPrefs: TypographyPrefs) {
  return render(
    <TypographyProvider initialPrefs={initialPrefs}>
      <Consumer />
    </TypographyProvider>,
  )
}

function styleText(): string | null {
  return document.querySelector("style[data-radaric-typography]")?.textContent ?? null
}

function shownPrefs(): unknown {
  return JSON.parse(screen.getByTestId("prefs").textContent ?? "null")
}

function click(label: string) {
  act(() => {
    fireEvent.click(screen.getByText(label))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TypographyProvider", () => {
  it("AC-4: renders exactly one typography <style> — empty for the default, buildTypographyCss otherwise", () => {
    installControlledFetch()
    const first = renderProvider({ ...DEFAULT_TYPOGRAPHY })
    expect(document.querySelectorAll("style[data-radaric-typography]")).toHaveLength(1)
    expect(styleText()).toBe("")
    first.unmount()

    renderProvider(PREFS_A)
    expect(document.querySelectorAll("style[data-radaric-typography]")).toHaveLength(1)
    const expected = buildTypographyCss(PREFS_A)
    expect(expected.startsWith(":root{")).toBe(true)
    expect(styleText()).toBe(expected)
  })

  it("AC-5: setPrefs applies optimistically before the fetch settles and PATCHes /api/user-settings", () => {
    const { fetchMock } = installControlledFetch()
    renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-b")

    expect(styleText()).toBe(buildTypographyCss(PREFS_B))
    expect(shownPrefs()).toEqual(PREFS_B)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/user-settings")
    expect(init.method).toBe("PATCH")
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ typography: PREFS_B }))
    expect(init.keepalive).toBe(true)
    expect(init.signal).toBeUndefined()
  })

  it("AC-5b: the body carries the applied (parsed) prefs, not the raw argument", () => {
    const { fetchMock } = installControlledFetch()
    function Extra() {
      const { setPrefs } = useTypography()
      return <button onClick={() => setPrefs({ ...PREFS_B, extra: "x" } as unknown as TypographyPrefs)}>set-extra</button>
    }
    render(
      <TypographyProvider initialPrefs={{ ...DEFAULT_TYPOGRAPHY }}>
        <Extra />
      </TypographyProvider>,
    )

    click("set-extra")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify({ typography: PREFS_B }))
  })

  it("AC-6: setPrefs(null) sends {\"typography\":null} and resets to the default", () => {
    const { fetchMock } = installControlledFetch()
    renderProvider(PREFS_A)
    expect(styleText()).toBe(buildTypographyCss(PREFS_A))

    click("reset")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe('{"typography":null}')
    expect(shownPrefs()).toEqual({ heading: "inter", text: "inter", counter: "inter", tag: "inter" })
    expect(styleText()).toBe("")
  })

  it("AC-7: a save made while one is in flight is queued and sent after it settles — nothing is aborted", async () => {
    const { fetchMock, calls } = installControlledFetch()
    renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-a")
    click("set-b")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].init?.body).toBe(JSON.stringify({ typography: PREFS_A }))
    expect(shownPrefs()).toEqual(PREFS_B)
    expect(styleText()).toBe(buildTypographyCss(PREFS_B))

    await act(async () => {
      calls[0].resolve({ ok: true, status: 200 })
      await calls[0].promise
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls[1].init?.body).toBe(JSON.stringify({ typography: PREFS_B }))
    expect(calls.map((c) => c.signal)).toEqual([undefined, undefined])
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(0)
  })

  it("AC-7b: only the newest queued value is sent — A, B, C while A is in flight sends A then C", async () => {
    const { fetchMock, calls } = installControlledFetch()
    renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-a")
    click("set-b")
    click("set-c")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(shownPrefs()).toEqual(PREFS_C)

    await act(async () => {
      calls[0].resolve({ ok: true, status: 200 })
      await calls[0].promise
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls[1].init?.body).toBe(JSON.stringify({ typography: PREFS_C }))

    await act(async () => {
      calls[1].resolve({ ok: true, status: 200 })
      await calls[1].promise
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(shownPrefs()).toEqual(PREFS_C)
  })

  it.each([
    ["a 500", (d: Deferred) => d.resolve({ ok: false, status: 500 })],
    ["a network error", (d: Deferred) => d.reject(new TypeError("Failed to fetch"))],
  ])("AC-7c: when the in-flight save fails with %s while a newer value is queued, nothing reverts or toasts and the newer value is sent", async (_label, settle) => {
    const { fetchMock, calls } = installControlledFetch()
    renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-a")
    click("set-b")

    await act(async () => {
      settle(calls[0])
      await calls[0].promise.catch(() => {})
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls[1].init?.body).toBe(JSON.stringify({ typography: PREFS_B }))
    expect(shownPrefs()).toEqual(PREFS_B)
    expect(styleText()).toBe(buildTypographyCss(PREFS_B))
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(0)
  })

  it("AC-8: a non-2xx latest save reverts to the confirmed prefs and toasts once", async () => {
    const { calls } = installControlledFetch()
    renderProvider(PREFS_A)

    click("set-b")
    expect(shownPrefs()).toEqual(PREFS_B)

    await act(async () => {
      calls[0].resolve({ ok: false, status: 400 })
      await calls[0].promise
    })

    await waitFor(() => expect(shownPrefs()).toEqual(PREFS_A))
    expect(styleText()).toBe(buildTypographyCss(PREFS_A))
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Failed to save font choice")
  })

  it("AC-9: a successful save moves confirmation forward — a later failure reverts to it, not to initialPrefs", async () => {
    const { calls } = installControlledFetch()
    renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-b")
    await act(async () => {
      calls[0].resolve({ ok: true, status: 200 })
      await calls[0].promise
    })
    expect(shownPrefs()).toEqual(PREFS_B)

    click("set-c")
    expect(shownPrefs()).toEqual(PREFS_C)
    await act(async () => {
      calls[1].resolve({ ok: false, status: 400 })
      await calls[1].promise
    })

    await waitFor(() => expect(shownPrefs()).toEqual(PREFS_B))
    expect(styleText()).toBe(buildTypographyCss(PREFS_B))
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
  })

  it("EC-1: a network error on the latest save reverts and toasts like a non-2xx response", async () => {
    const { calls } = installControlledFetch()
    renderProvider(PREFS_A)

    click("set-c")
    expect(shownPrefs()).toEqual(PREFS_C)

    await act(async () => {
      calls[0].reject(new TypeError("Failed to fetch"))
      await calls[0].promise.catch(() => {})
    })

    await waitFor(() => expect(shownPrefs()).toEqual(PREFS_A))
    expect(styleText()).toBe(buildTypographyCss(PREFS_A))
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Failed to save font choice")
  })

  it("EC-2: invalid initialPrefs render the parsed prefs, never the raw value", () => {
    installControlledFetch()
    const poisoned = { heading: "</style>" } as unknown as TypographyPrefs

    renderProvider(poisoned)

    const expected = buildTypographyCss(parseTypographyPrefs(poisoned))
    expect(expected).toBe("")
    expect(styleText()).toBe(expected)
    expect(document.querySelectorAll("style[data-radaric-typography]")).toHaveLength(1)
    expect(shownPrefs()).toEqual({ heading: "inter", text: "inter", counter: "inter", tag: "inter" })
  })

  it("EC-3: unmounting aborts nothing — the queued value is still sent, and a later failure neither reverts nor toasts", async () => {
    const { fetchMock, calls } = installControlledFetch()
    const view = renderProvider({ ...DEFAULT_TYPOGRAPHY })

    click("set-a")
    click("set-b")
    view.unmount()

    await act(async () => {
      calls[0].resolve({ ok: true, status: 200 })
      await calls[0].promise
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls[1].init?.body).toBe(JSON.stringify({ typography: PREFS_B }))
    expect(calls.map((c) => c.signal)).toEqual([undefined, undefined])

    await act(async () => {
      calls[1].resolve({ ok: false, status: 500 })
      await calls[1].promise
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(0)
  })

  it("ERR-1: useTypography() outside a provider throws an Error naming TypographyProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    function Orphan() {
      useTypography()
      return null
    }

    expect(() => render(<Orphan />)).toThrow(/TypographyProvider/)
  })
})
