/**
 * Source Error Utility — Informative Parsing Error Messages
 *
 * Tests for lib/feed-error.ts.
 *
 * Spec coverage:
 *   AC-2: formatSourceError() produces "[TYPE] Name: reason" string
 *   EC-1: truncateErrorMessage() caps at 500 chars with "..." appended
 *   EC-2: successful parse clears errorMessage (formatSourceError is not called — null is used directly)
 *   ERR-1: formatSourceError() uses String(error) when error has no .message property
 */

import { describe, it, expect } from "vitest"
import {
  formatSourceError,
  truncateErrorMessage,
} from "@/lib/feed-error"

// ---------------------------------------------------------------------------
// AC-2: formatSourceError — formats error with type, name, and reason
// ---------------------------------------------------------------------------

describe("formatSourceError — AC-2: formats error with type, name, and reason", () => {
  it("AC-2: produces [TYPE] Name: reason format for a standard Error", () => {
    const result = formatSourceError("RSS", "TechCrunch Feed", new Error("connection timeout"))
    expect(result).toBe("[RSS] TechCrunch Feed: connection timeout")
  })

  it("AC-2: preserves the type casing as passed", () => {
    const result = formatSourceError("telegram", "My Channel", new Error("flood wait"))
    expect(result).toBe("[telegram] My Channel: flood wait")
  })

  it("AC-2: includes the full source name including special characters", () => {
    const result = formatSourceError("RSS", "Feed #1 — Breaking News", new Error("404 Not Found"))
    expect(result).toBe("[RSS] Feed #1 — Breaking News: 404 Not Found")
  })
})

// ---------------------------------------------------------------------------
// ERR-1: formatSourceError — non-Error throw (no .message property)
// ---------------------------------------------------------------------------

describe("formatSourceError — ERR-1: handles non-Error thrown values", () => {
  it("ERR-1: uses String(error) when a plain string is thrown", () => {
    const result = formatSourceError("RSS", "Some Feed", "network unreachable")
    expect(result).toBe("[RSS] Some Feed: network unreachable")
  })

  it("ERR-1: uses String(error) when a number is thrown", () => {
    const result = formatSourceError("TELEGRAM", "Channel X", 503)
    expect(result).toBe("[TELEGRAM] Channel X: 503")
  })

  it("ERR-1: uses String(error) when a plain object without .message is thrown", () => {
    const result = formatSourceError("RSS", "Feed", { code: "ECONNREFUSED" })
    // String({ code: "ECONNREFUSED" }) === "[object Object]"
    expect(result).toBe("[RSS] Feed: [object Object]")
  })
})

// ---------------------------------------------------------------------------
// EC-1: truncateErrorMessage — caps at 500 characters
// ---------------------------------------------------------------------------

describe("truncateErrorMessage — EC-1: truncates long messages to 500 chars", () => {
  it("EC-1: returns message unchanged when it is exactly 500 characters", () => {
    const msg = "x".repeat(500)
    const result = truncateErrorMessage(msg)
    expect(result).toBe(msg)
    expect(result.length).toBe(500)
  })

  it("EC-1: truncates to 500 chars and appends '...' when message exceeds 500 characters", () => {
    const msg = "a".repeat(600)
    const result = truncateErrorMessage(msg)
    expect(result.length).toBe(503)
    expect(result).toBe("a".repeat(500) + "...")
  })

  it("EC-1: short messages are returned unchanged", () => {
    const msg = "short error"
    const result = truncateErrorMessage(msg)
    expect(result).toBe("short error")
  })
})
