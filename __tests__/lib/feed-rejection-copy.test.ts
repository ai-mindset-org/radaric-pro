/**
 * The prose a rejected source shows the user.
 *
 * The rule these enforce: every rejection must say what to do INSTEAD. A user
 * who added a bot wanted the channel it publishes to; "invalid source" sends
 * them away, which is the outcome the whole feature exists to avoid.
 */

import { describe, it, expect } from "vitest"
import { rejectionCopy } from "@/lib/feed-rejection-copy"

describe("rejectionCopy", () => {
  it("names the bot's handle and points at the channel instead", () => {
    const c = rejectionCopy("TELEGRAM_IS_BOT", "https://t.me/example_bot")
    expect(c).toContain("@example_bot")
    expect(c).toContain("add that channel's link instead")
  })

  it("explains what Radaric can read when given a personal account", () => {
    expect(rejectionCopy("TELEGRAM_IS_USER")).toContain("channels and public groups")
  })

  it("suggests the spelling fix for a dead handle", () => {
    const c = rejectionCopy("TELEGRAM_NOT_FOUND", "https://t.me/nosuchchannel")
    expect(c).toContain("@nosuchchannel")
    expect(c).toContain("t.me/channelname")
  })

  it("suggests where a feed usually lives when the URL isn't one", () => {
    const c = rejectionCopy("NOT_A_FEED", "https://www.example.com/page")
    // www stripped — the host is shown to be read, not to be exact.
    expect(c).toContain("example.com/feed")
    expect(c).toContain("example.com/rss.xml")
  })

  it("names the domain that doesn't resolve", () => {
    const c = rejectionCopy("DNS_NOT_FOUND", "https://exmaple.cmo/feed")
    expect(c).toContain("exmaple.cmo")
    expect(c).toContain("typo")
  })

  it("degrades gracefully rather than printing 'undefined' at the user", () => {
    expect(rejectionCopy("TELEGRAM_IS_BOT", "not a url")).toContain("That is a bot")
    // No host to name: the suggestion must stay readable prose, not splice a
    // placeholder into a URL ("often that page/feed").
    const c = rejectionCopy("NOT_A_FEED", undefined)!
    expect(c).not.toMatch(/undefined|null|that page\//)
    expect(c).toContain("/feed")
    expect(rejectionCopy("DNS_NOT_FOUND", "not a url")).not.toMatch(/undefined|null/)
  })

  it("returns nothing for a code it doesn't own, so the caller can fall back", () => {
    // DUPLICATE_FEED / TWITTER_NOT_IN_PLAN are handled elsewhere; claiming them
    // here would replace their specific copy with silence.
    expect(rejectionCopy("DUPLICATE_FEED")).toBeUndefined()
    expect(rejectionCopy(undefined)).toBeUndefined()
  })
})
