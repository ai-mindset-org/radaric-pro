/**
 * @vitest-environment jsdom
 */

/**
 * RAD-345 — the open-mode preference.
 *
 * The contract that matters: the first render is always the default (so the
 * markup matches SSR — this repo has already paid for a React #418 hydration
 * mismatch in this component tree), any stored value is applied after mount,
 * and anything that is not exactly "drawer" reads as the default.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import {
  DEFAULT_OPEN_MODE,
  OPEN_MODE_KEY,
  resolveOpenMode,
  useOpenMode,
} from "@/components/materials/use-open-mode"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe("resolveOpenMode", () => {
  it("accepts exactly the drawer value", () => {
    expect(resolveOpenMode("drawer")).toBe("drawer")
    expect(resolveOpenMode("page")).toBe("page")
  })

  it("falls back to the default for anything else", () => {
    expect(resolveOpenMode(null)).toBe(DEFAULT_OPEN_MODE)
    expect(resolveOpenMode(undefined)).toBe(DEFAULT_OPEN_MODE)
    expect(resolveOpenMode("")).toBe(DEFAULT_OPEN_MODE)
    expect(resolveOpenMode("DRAWER")).toBe(DEFAULT_OPEN_MODE)
    expect(resolveOpenMode("center")).toBe(DEFAULT_OPEN_MODE)
  })
})

describe("useOpenMode", () => {
  it("renders the default on the server, whatever storage holds", () => {
    localStorage.setItem(OPEN_MODE_KEY, "drawer")

    function Probe() {
      const [mode] = useOpenMode()
      return <span>{mode}</span>
    }

    expect(renderToString(<Probe />)).toContain("page")
  })

  it("applies a stored choice after mount", () => {
    localStorage.setItem(OPEN_MODE_KEY, "drawer")
    const { result } = renderHook(() => useOpenMode())
    expect(result.current[0]).toBe("drawer")
  })

  it("starts at the default with nothing stored", () => {
    const { result } = renderHook(() => useOpenMode())
    expect(result.current[0]).toBe("page")
  })

  it("persists a change", () => {
    const { result } = renderHook(() => useOpenMode())

    act(() => result.current[1]("drawer"))
    expect(result.current[0]).toBe("drawer")
    expect(localStorage.getItem(OPEN_MODE_KEY)).toBe("drawer")

    act(() => result.current[1]("page"))
    expect(localStorage.getItem(OPEN_MODE_KEY)).toBe("page")
  })
})
