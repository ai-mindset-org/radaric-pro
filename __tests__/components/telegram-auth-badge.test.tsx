/**
 * Telegram auth badge — RAD-328.
 *
 * The badge must tell the truth per state, with text (not colour alone), and
 * must never render an unreachable worker as authorized.
 */

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { TelegramAuthBadge, telegramAuthHint } from "@/components/settings/telegram-auth-badge"
import type { TelegramSessionState } from "@/lib/telegram-session-state"

const ALL_STATES: TelegramSessionState[] = ["active", "starting", "invalid", "unknown", "unconfigured"]

describe("TelegramAuthBadge (RAD-328)", () => {
  it("renders a distinct text label for every state", () => {
    const labels = ALL_STATES.map((state) => {
      const { unmount } = render(<TelegramAuthBadge state={state} phoneNumber="+351 900 000 000" />)
      const label = document.body.textContent?.trim() ?? ""
      unmount()
      return label
    })

    expect(labels[0]).toContain("Authorized: +351 900 000 000")
    expect(labels[1]).toMatch(/Connecting/)
    expect(labels[2]).toContain("Session expired")
    expect(labels[3]).toContain("Status unknown")
    expect(labels[4]).toContain("Not authorized")
    expect(new Set(labels).size).toBe(ALL_STATES.length)
  })

  it("shows a bare Authorized when the phone number is absent", () => {
    render(<TelegramAuthBadge state="active" phoneNumber={null} />)
    expect(screen.getByText("Authorized")).toBeInTheDocument()
  })

  it("never renders an unreachable worker as authorized", () => {
    render(<TelegramAuthBadge state="unknown" phoneNumber="+351 900 000 000" />)
    expect(screen.queryByText(/authorized/i)).not.toBeInTheDocument()
    expect(screen.getByText(/status unknown/i)).toBeInTheDocument()
  })
})

describe("telegramAuthHint (RAD-328)", () => {
  it("gives every state its own actionable sentence", () => {
    const hints = ALL_STATES.map((state) => telegramAuthHint(state))
    expect(new Set(hints).size).toBe(ALL_STATES.length)
    expect(telegramAuthHint("invalid")).toMatch(/sign in again/i)
    expect(telegramAuthHint("active")).toMatch(/can parse/i)
    expect(telegramAuthHint("unknown")).toMatch(/worker is not reachable/i)
  })
})
