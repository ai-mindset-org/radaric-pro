/** @vitest-environment jsdom */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import { SourceFreshness } from "@/components/materials/source-freshness"
import { MANUAL_CHECK_NOTE, type FreshnessProps } from "@/lib/materials/source-freshness"

const NOW = new Date("2026-11-03T12:00:00Z")
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

const base: FreshnessProps = {
  checkedAt: null,
  inactiveCheckedAt: null,
  activeCount: 3,
  neverCount: 0,
  failedCount: 0,
  pausedCount: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const line = () => screen.getByTestId("source-freshness")

describe("SourceFreshness", () => {
  it("says not checked yet when no active source was ever parsed", () => {
    render(<SourceFreshness freshness={{ ...base, neverCount: 3 }} />)
    expect(line()).toHaveTextContent("Not checked yet: run parsing to check your sources")
  })

  it("shows the oldest checked time, and how many are still unchecked", () => {
    render(<SourceFreshness freshness={{ ...base, checkedAt: minutesAgo(12), neverCount: 1 }} />)
    expect(line()).toHaveTextContent("Checked 12 min ago · 1 not checked yet")
  })

  it("says just now right after a check, with the absolute time in a <time> element", () => {
    render(<SourceFreshness freshness={{ ...base, checkedAt: NOW.toISOString() }} />)
    expect(line()).toHaveTextContent("Checked just now")
    const time = line().querySelector("time")!
    expect(time).toHaveAttribute("dateTime", NOW.toISOString())
    // A tooltip on hover; no extra tab stop for a title that never shows on focus.
    expect(time).not.toHaveAttribute("tabindex")
    expect(time.getAttribute("title")).toContain(MANUAL_CHECK_NOTE)
  })

  it("headlines the last run with no new posts, then lets a newer server value win", () => {
    const { rerender } = render(
      <SourceFreshness
        freshness={{ ...base, checkedAt: minutesAgo(3) }}
        lastRun={{ at: minutesAgo(3), newPosts: 0 }}
      />
    )
    expect(line()).toHaveTextContent("No new posts · checked 3 min ago")

    // Another device parsed 20 minutes after this device's last run.
    rerender(
      <SourceFreshness
        freshness={{ ...base, checkedAt: minutesAgo(1) }}
        lastRun={{ at: minutesAgo(30), newPosts: 4 }}
      />
    )
    expect(line()).toHaveTextContent("Checked 1 min ago")
    expect(line()).not.toHaveTextContent("new post")
  })

  it("ignores a stored run far newer than the server value (it covered only part of the scope)", () => {
    render(
      <SourceFreshness
        freshness={{ ...base, checkedAt: minutesAgo(60) }}
        lastRun={{ at: minutesAgo(1), newPosts: 9 }}
      />
    )
    expect(line()).toHaveTextContent("Checked 1 h ago")
    expect(line()).not.toHaveTextContent("new post")
  })

  it("keeps the unchecked and failed counts beside the run headline", () => {
    render(
      <SourceFreshness
        freshness={{ ...base, checkedAt: minutesAgo(3), neverCount: 1, failedCount: 2 }}
        lastRun={{ at: minutesAgo(3), newPosts: 0 }}
      />
    )
    expect(line()).toHaveTextContent("No new posts · checked 3 min ago · 1 not checked yet · 2 failed")
  })

  it("counts the last run's new posts, singular and plural", () => {
    const fresh = { ...base, checkedAt: minutesAgo(3) }
    const { rerender } = render(<SourceFreshness freshness={fresh} lastRun={{ at: minutesAgo(3), newPosts: 1 }} />)
    expect(line()).toHaveTextContent("1 new post · checked 3 min ago")
    rerender(<SourceFreshness freshness={fresh} lastRun={{ at: minutesAgo(3), newPosts: 5 }} />)
    expect(line()).toHaveTextContent("5 new posts · checked 3 min ago")
  })

  it("appends the failed count", () => {
    const { rerender } = render(<SourceFreshness freshness={{ ...base, checkedAt: minutesAgo(5), failedCount: 2 }} />)
    expect(line()).toHaveTextContent("Checked 5 min ago · 2 failed")
    rerender(<SourceFreshness freshness={{ ...base, checkedAt: minutesAgo(5), failedCount: 1 }} />)
    expect(line()).toHaveTextContent("Checked 5 min ago · 1 failed")
  })

  it("does not mention paused sources", () => {
    render(<SourceFreshness freshness={{ ...base, checkedAt: minutesAgo(5), pausedCount: 2 }} />)
    expect(line()).not.toHaveTextContent(/paused/i)
  })

  it("reports a single errored feed as a failed last check", () => {
    render(
      <SourceFreshness
        freshness={{ ...base, activeCount: 0, failedCount: 1, inactiveCheckedAt: minutesAgo(90) }}
      />
    )
    expect(line()).toHaveTextContent("Last check failed · last success 1 h ago")
  })

  it("reports a single paused feed with its last check", () => {
    render(
      <SourceFreshness
        freshness={{ ...base, activeCount: 0, pausedCount: 1, inactiveCheckedAt: minutesAgo(180) }}
      />
    )
    expect(line()).toHaveTextContent("Paused · checked 3 h ago")
  })

  it("always carries the manual-checking sentence for assistive tech, and never implies polling", () => {
    render(<SourceFreshness freshness={{ ...base, neverCount: 3 }} />)
    expect(line().querySelector(".sr-only")).toHaveTextContent(MANUAL_CHECK_NOTE)
    expect(MANUAL_CHECK_NOTE).not.toMatch(/automatic|every|hour|background/i)
  })

  it("re-ticks every minute", () => {
    render(<SourceFreshness freshness={{ ...base, checkedAt: minutesAgo(0) }} />)
    expect(line()).toHaveTextContent("Checked just now")
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(line()).toHaveTextContent("Checked 5 min ago")
  })
})
