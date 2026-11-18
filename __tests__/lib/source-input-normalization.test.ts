/**
 * Input normalization for the legacy source types (Telegram / Twitter / RSS) —
 * any paste format (full URL, protocol-less URL, @handle, bare handle) must
 * canonicalize. Pure functions, no mocks. Follow-up to RAD-268.
 */

import { describe, it, expect } from "vitest"
import {
  extractTwitterUsername,
  normalizeTelegramInput,
  normalizeFeedUrlInput,
  isTelegramInviteLink,
  vetTelegramFeedInput,
} from "@/lib/validations/feed"
import { buildTwitterSourceUrl } from "@/lib/parsers/twitter"

describe("normalizeTelegramInput", () => {
  it("normalizes every public-channel paste format to https://t.me/<channel>", () => {
    for (const input of [
      "@durov",
      "durov",
      "t.me/durov",
      "https://t.me/durov",
      "http://www.t.me/durov/",
      "telegram.me/durov",
      "https://telegram.me/durov",
      "https://t.me/s/durov",
      "t.me/durov/123",
      "tg://resolve?domain=durov",
      "  @durov  ",
    ]) {
      expect(normalizeTelegramInput(input), `input: ${input}`).toBe("https://t.me/durov")
    }
  })

  it("returns null for private invite links (not public channels)", () => {
    expect(normalizeTelegramInput("https://t.me/+AbCdEfGh123")).toBeNull()
    expect(normalizeTelegramInput("t.me/joinchat/AbCdEfGh123")).toBeNull()
  })

  it("rejects reserved t.me paths, including behind the /s/ web-preview form", () => {
    expect(normalizeTelegramInput("t.me/share/url")).toBeNull()
    expect(normalizeTelegramInput("t.me/proxy")).toBeNull()
    expect(normalizeTelegramInput("t.me/s/joinchat")).toBeNull()
  })

  it("returns null for non-telegram URLs and garbage", () => {
    expect(normalizeTelegramInput("https://example.com/feed")).toBeNull()
    expect(normalizeTelegramInput("example.com")).toBeNull()
    expect(normalizeTelegramInput("not valid!!")).toBeNull()
    expect(normalizeTelegramInput("")).toBeNull()
  })

  it("rejects usernames outside Telegram's charset/length", () => {
    expect(normalizeTelegramInput("@ab")).toBeNull()
    expect(normalizeTelegramInput("@has-dash")).toBeNull()
  })

  it("rejects what GramJS resolves against the session's own account (RAD-364)", () => {
    // "self"/"this" pass the charset regex, and GramJS maps them to the
    // operator's Saved Messages; an all-digit string is read as a peer id.
    for (const input of ["self", "@this", "https://t.me/SELF", "tg://resolve?domain=this", "79991234567", "t.me/1234"]) {
      expect(normalizeTelegramInput(input), `input: ${input}`).toBeNull()
    }
    // Digits inside a real handle are fine.
    expect(normalizeTelegramInput("@ab12")).toBe("https://t.me/ab12")
  })

  it("follows Telegram's username grammar, not a looser one (RAD-364)", () => {
    // A leading digit, "__", a trailing "_" — GramJS never sends these to
    // Telegram, so they could only resolve through the worker's cache.
    for (const input of ["@9gag_news", "@my__channel", "@chan_", "@_chan", "@abc"]) {
      expect(normalizeTelegramInput(input), `input: ${input}`).toBeNull()
    }
    for (const input of ["@ab12", "@durov", "@a_b_c", "@x".padEnd(33, "y")]) {
      expect(normalizeTelegramInput(input), `input: ${input}`).not.toBeNull()
    }
    expect(normalizeTelegramInput("@x".padEnd(34, "y"))).toBeNull()
  })
})

describe("isTelegramInviteLink / vetTelegramFeedInput (RAD-364)", () => {
  it("recognizes private invite links, not phone links", () => {
    expect(isTelegramInviteLink("https://t.me/+AbCdEfGh123")).toBe(true)
    expect(isTelegramInviteLink("t.me/joinchat/AbCdEfGh123")).toBe(true)
    expect(isTelegramInviteLink("https://t.me/+79991234567")).toBe(false)
    expect(isTelegramInviteLink("https://t.me/durov")).toBe(false)
    expect(isTelegramInviteLink("+AbCdEfGh123")).toBe(false)
  })

  it("stores a public channel canonical and refuses everything else, invites with their own code", () => {
    expect(vetTelegramFeedInput("@durov")).toEqual({ ok: true, url: "https://t.me/durov" })
    expect(vetTelegramFeedInput(" https://t.me/+AbCdEfGh123 ")).toEqual({ ok: false, code: "TELEGRAM_PRIVATE_INVITE" })
    expect(vetTelegramFeedInput("t.me/joinchat/AbCdEfGh123")).toEqual({ ok: false, code: "TELEGRAM_PRIVATE_INVITE" })
    for (const input of ["me", "self", "this", "+79991234567", "https://t.me/+79991234567", "-1001234567", "https://t.me/c/123/4"]) {
      expect(vetTelegramFeedInput(input), `input: ${input}`).toEqual({ ok: false, code: "TELEGRAM_INVALID_INPUT" })
    }
  })
})

describe("extractTwitterUsername (paste-format matrix)", () => {
  it("extracts the username from every format", () => {
    for (const input of [
      "durov",
      "@durov",
      "x.com/durov",
      "twitter.com/durov",
      "https://x.com/durov",
      "https://www.twitter.com/durov/",
      "https://x.com/durov?ref=home",
      "mobile.twitter.com/durov",
      "https://mobile.twitter.com/durov",
    ]) {
      expect(extractTwitterUsername(input), `input: ${input}`).toBe("durov")
    }
  })

  it("does not treat lookalike domains as twitter", () => {
    expect(extractTwitterUsername("eviltwitter.com/durov")).not.toBe("durov")
  })
})

describe("buildTwitterSourceUrl", () => {
  it("builds the canonical x.com URL from a bare or @ username", () => {
    expect(buildTwitterSourceUrl({ type: "ACCOUNT", value: "durov" })).toBe("https://x.com/durov")
    expect(buildTwitterSourceUrl({ type: "ACCOUNT", value: "@durov" })).toBe("https://x.com/durov")
  })

  it("normalizes a pasted profile URL instead of nesting it (regression)", () => {
    expect(buildTwitterSourceUrl({ type: "ACCOUNT", value: "https://x.com/durov" })).toBe(
      "https://x.com/durov"
    )
    expect(buildTwitterSourceUrl({ type: "ACCOUNT", value: "twitter.com/durov" })).toBe(
      "https://x.com/durov"
    )
  })

  it("throws on input with no extractable username (defense-in-depth)", () => {
    expect(() => buildTwitterSourceUrl({ type: "ACCOUNT", value: "https://x.com/" })).toThrow()
  })
})

describe("normalizeFeedUrlInput (RSS)", () => {
  it("passes full URLs through unchanged", () => {
    expect(normalizeFeedUrlInput("https://example.com/feed.xml")).toBe(
      "https://example.com/feed.xml"
    )
  })

  it("prefixes https:// on protocol-less URLs", () => {
    expect(normalizeFeedUrlInput("example.com/feed")).toBe("https://example.com/feed")
    expect(normalizeFeedUrlInput("blog.example.com")).toBe("https://blog.example.com")
  })

  it("returns null for non-URL input", () => {
    expect(normalizeFeedUrlInput("@durov")).toBeNull()
    expect(normalizeFeedUrlInput("not a url")).toBeNull()
    expect(normalizeFeedUrlInput("")).toBeNull()
  })
})
