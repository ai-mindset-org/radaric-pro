/**
 * Inter 4 (RAD-363) — the self-hosted house face, loaded through next/font so
 * the latin file is preloaded and Arial gets a metric-matched fallback.
 *
 * The upstream variable font is split into three files by
 * scripts/typography/subset-inter.py (no code point lives in two files). The
 * three calls declare ONE family, each with its file's exact cmap as
 * `unicode-range`, so the browser downloads only the files a page's text
 * needs and never renders a Cyrillic letter in the Latin file's Arial
 * fallback. next/font needs literal arguments, so the ranges are written out
 * here; __tests__/typography-fonts.test.ts pins them to font-metrics.json.
 * Every call names the family "interLatin" — the latin call's const name,
 * which its className and `--font-inter` variable reference.
 */
import localFont from "next/font/local"

export const interLatin = localFont({
  src: "./inter/InterVariable-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  variable: "--font-inter",
  declarations: [
    { prop: "font-family", value: "interLatin" },
    { prop: "unicode-range", value: "U+0000,U+0020-007E,U+00A0-00AC,U+00AE-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0301,U+0304,U+0308,U+2000-200B,U+2010-2027,U+202F-2055,U+2057,U+205F,U+20AC,U+20BD,U+2122,U+2190-2199,U+21A9,U+21E7,U+2212,U+2248,U+2260,U+2264-2265,U+2303,U+2318,U+2325,U+232B,U+238B,U+23CE,U+FEFF" },
  ],
})

export const interCyrillic = localFont({
  src: "./inter/InterVariable-cyrillic.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  // Unused: its only job is to keep this call's @font-face in the build.
  variable: "--font-inter-cyrillic",
  declarations: [
    { prop: "font-family", value: "interLatin" },
    { prop: "unicode-range", value: "U+0400-0479,U+0480-049D,U+04A0-04FF,U+052F,U+2116,U+2DFF,U+A69F" },
  ],
})

export const interExt = localFont({
  src: "./inter/InterVariable-ext.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  // Unused: its only job is to keep this call's @font-face in the build.
  variable: "--font-inter-ext",
  declarations: [
    { prop: "font-family", value: "interLatin" },
    { prop: "unicode-range", value: "U+0100-0130,U+0132-0148,U+014A-0151,U+0154-01C3,U+01C5-024F,U+0259,U+02B0-02BA,U+02BD-02C5,U+02C7-02D9,U+02DB,U+02DD-0300,U+0302-0303,U+0306-0307,U+0309-030A,U+030C,U+030F,U+0313,U+0315,U+031B,U+0323,U+0326-0328,U+032C,U+0337-0338,U+0342-0343,U+0346-036F,U+0374-0376,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03D7,U+03DC-03DD,U+03F0-03F6,U+03F9-03FA,U+03FC-03FF,U+1E00-1E9B,U+1E9D-1F15,U+1F18-1F1D,U+1F20-1F45,U+1F48-1F4D,U+1F50-1F57,U+1F59,U+1F5B,U+1F5D,U+1F5F-1F7D,U+1F80-1FB4,U+1FB6-1FC4,U+1FC6-1FD3,U+1FD6-1FDB,U+1FDD-1FEF,U+1FF2-1FF4,U+1FF6-1FFE,U+2070-2071,U+2074-208E,U+2090-209C,U+20A0-20AB,U+20AD-20AF,U+20B1-20B5,U+20B8-20BA,U+20BC,U+20BE-20C0,U+2100-2101,U+2103,U+2105-2106,U+2109,U+2113,U+2117,U+211E-2121,U+2126,U+212A-212B,U+212E,U+2132,U+213B,U+214D,U+2150-217F,U+2183-2186,U+2189,U+21AA,U+21B0-21B1,U+21B3-21B5,U+21BA-21BB,U+21D0,U+21D2,U+21D4,U+21DE-21DF,U+21E4-21E5,U+21EA,U+2202,U+2205-2206,U+220F,U+2211,U+221A,U+221E,U+222B,U+2236,U+2295-2298,U+2304-2305,U+2326-2327,U+2380,U+2387,U+23CF,U+2460-2468,U+24B6-24CF,U+24EA,U+25A0-25A2,U+25AA,U+25B2-25B3,U+25B6-25B7,U+25BA-25BD,U+25C0-25C1,U+25C4-25C7,U+25CA-25CB,U+25CF,U+25E6,U+25EF,U+A7FF" },
  ],
})
