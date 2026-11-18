/**
 * RAD-363 slice 7 — pure helpers behind Settings → Appearance → Typography:
 * `fontPreviewStyle` (css.ts) and `appleFontSupport` (platform.ts).
 * Spec: .tdd/spec-typography-settings.md
 */
import { describe, it, expect } from "vitest"
import { FONT_IDS } from "@/lib/typography/fonts"
import { fontPreviewStyle } from "@/lib/typography/css"
import { appleFontSupport } from "@/lib/typography/platform"

const UA = {
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
} as const

describe("fontPreviewStyle", () => {
  it("AC-1: returns exactly the five text-role font variables for each of the eleven registry ids", () => {
    expect(FONT_IDS).toHaveLength(11)
    for (const id of FONT_IDS) {
      expect(fontPreviewStyle(id)).toStrictEqual({
        fontFamily: `var(--f-${id}-text-family)`,
        fontStretch: `var(--f-${id}-text-stretch)`,
        fontSizeAdjust: `var(--f-${id}-text-size-adjust)`,
        fontFeatureSettings: `var(--f-${id}-text-features)`,
        fontWeight: `calc(400 * var(--f-${id}-text-wa) + var(--f-${id}-text-wb))`,
      })
    }
  })

  it.each(["comic-sans", "__proto__", "constructor"])(
    "ERR-1: throws for the unregistered id %j with a message containing the id",
    (id) => {
      expect(() => fontPreviewStyle(id)).toThrow(id)
    },
  )
})

describe("appleFontSupport", () => {
  it.each([
    ["macOS Safari", UA.macSafari, { sf: true, rounded: true }],
    ["macOS Chrome", UA.macChrome, { sf: true, rounded: false }],
    ["iPhone Chrome", UA.iphoneChrome, { sf: true, rounded: true }],
    ["Windows Chrome", UA.windowsChrome, { sf: false, rounded: false }],
    ["Android Chrome", UA.androidChrome, { sf: false, rounded: false }],
  ] as const)("AC-10: %s", (_name, userAgent, expected) => {
    expect(appleFontSupport(userAgent)).toStrictEqual(expected)
  })

  it("AC-10: an iPad in desktop mode (a Macintosh UA with touch points) is WebKit, so ui-rounded resolves", () => {
    expect(appleFontSupport(UA.macChrome, 5)).toStrictEqual({ sf: true, rounded: true })
    expect(appleFontSupport(UA.macChrome, 0)).toStrictEqual({ sf: true, rounded: false })
  })
})
