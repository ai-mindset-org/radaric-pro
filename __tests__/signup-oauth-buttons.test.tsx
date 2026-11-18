/**
 * @vitest-environment jsdom
 *
 * RAD-293 — the signup form renders exactly the providers the server resolved.
 * (The server wrapper reads the same env conditionals lib/auth.ts uses, so the
 * buttons are in the first paint and unconfigured ones are never offered.)
 */
import "@testing-library/jest-dom/vitest"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { SignupForm } from "@/components/auth/signup-form"

afterEach(() => {
  cleanup()
})

describe("signup form — OAuth buttons follow the server-resolved providers", () => {
  it("hides both buttons AND the divider when neither is configured", () => {
    render(<SignupForm oauth={{ google: false, apple: false }} />)

    expect(screen.queryByText(/Continue with Google/i)).toBeNull()
    expect(screen.queryByText(/Continue with Apple/i)).toBeNull()
    expect(screen.queryByText(/^or$/i)).toBeNull()
    // The email form is always there.
    expect(screen.getByLabelText(/Email or username/i)).toBeInTheDocument()
  })

  it("shows only the configured provider(s), keeping the divider", () => {
    render(<SignupForm oauth={{ google: true, apple: false }} />)

    expect(screen.getByText(/Continue with Google/i)).toBeInTheDocument()
    expect(screen.queryByText(/Continue with Apple/i)).toBeNull()
    expect(screen.getByText(/^or$/i)).toBeInTheDocument()
  })

  it("shows both when both are configured", () => {
    render(<SignupForm oauth={{ google: true, apple: true }} />)

    expect(screen.getByText(/Continue with Google/i)).toBeInTheDocument()
    expect(screen.getByText(/Continue with Apple/i)).toBeInTheDocument()
  })
})
