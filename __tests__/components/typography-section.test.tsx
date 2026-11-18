// @vitest-environment jsdom

/**
 * RAD-363 slice 7 — Settings → Appearance → Typography card (`TypographySection`)
 * and the live specimen (`TypographySpecimen`), driven through the real
 * TypographyProvider. Spec: .tdd/spec-typography-settings.md
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, within, cleanup, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderToString } from "react-dom/server"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { TypographyProvider } from "@/components/providers/typography-provider"
import { TypographySection } from "@/components/settings/typography-section"
import { TypographySpecimen } from "@/components/settings/typography-specimen"
import { FONT_IDS, FONTS } from "@/lib/typography/fonts"
import { PRESETS } from "@/lib/typography/presets"
import { DEFAULT_TYPOGRAPHY, type TypographyPrefs } from "@/lib/typography/prefs"

// Radix Select relies on DOM APIs jsdom lacks. Polyfilled here, not in shared setup.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.setPointerCapture = () => {}
})

const UA = {
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
} as const

const NOTE_MONO = "Monospaced text sets about 25% wider, so long reading is slower."
const NOTE_NO_SF = "SF fonts are only on Apple devices — this device shows Inter instead."
const NOTE_NO_SF_MONO = "SF Mono is only on Apple devices — this device shows its own monospace font instead."
const NOTE_NO_SF_BOTH =
  "SF fonts are only on Apple devices — this device shows Inter instead, and its own monospace font for SF Mono."
const NOTE_NO_ROUNDED = "SF Pro Rounded appears in Safari and on iOS — this browser shows SF Pro instead."
const DEVICE_NOTES = [NOTE_NO_SF, NOTE_NO_SF_MONO, NOTE_NO_SF_BOTH, NOTE_NO_ROUNDED]

const ROLE_NAMES = ["Headings", "Text", "Counters", "Tags"] as const
const ROLE_DESCRIPTIONS = [
  "Page, card and dialog titles",
  "Body, buttons, menus and forms",
  "Counts, percentages and other numbers",
  "Badges, chips and small labels",
] as const
const CHIP_NAMES = ["Inter", "Martian", "Apple", "PT Root", "Plex"] as const

const presetPrefs = (id: string): TypographyPrefs => {
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`no preset ${id}`)
  return { ...preset.prefs }
}
const CUSTOM: TypographyPrefs = { heading: "martian-grotesk", text: "inter", counter: "inter", tag: "inter" }

/** Serialised exactly as the provider PATCHes it, roles in registry order. */
const body = (prefs: TypographyPrefs | null) =>
  JSON.stringify({
    typography: prefs && { heading: prefs.heading, text: prefs.text, counter: prefs.counter, tag: prefs.tag },
  })

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void; init: RequestInit | undefined }

function stubFetchOk() {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function stubFetchControlled() {
  const calls: Deferred[] = []
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject, init })
      }),
  )
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, calls }
}

const bodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.body)

function renderSection(initialPrefs: TypographyPrefs = { ...DEFAULT_TYPOGRAPHY }) {
  return render(
    <TypographyProvider initialPrefs={initialPrefs}>
      <TypographySection />
    </TypographyProvider>,
  )
}

const trigger = (role: (typeof ROLE_NAMES)[number]) => screen.getByRole("combobox", { name: role })
const triggerText = (role: (typeof ROLE_NAMES)[number]) => trigger(role).textContent?.trim()
const chip = (name: (typeof CHIP_NAMES)[number]) => screen.getByRole("button", { name })
const pressed = () =>
  CHIP_NAMES.filter((name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true")
const styleText = () => document.querySelector("style[data-radaric-typography]")?.textContent ?? ""

function setup() {
  return userEvent.setup({ delay: null })
}

async function choose(user: ReturnType<typeof setup>, role: (typeof ROLE_NAMES)[number], label: string) {
  await user.click(trigger(role))
  const option = screen
    .getAllByRole("option")
    .find((o) => o.textContent?.trim().startsWith(label) && !o.textContent.trim().startsWith(`${label} Rounded`))
  if (!option) throw new Error(`option ${label} not found`)
  await user.click(option)
}

/** The element inside `root` whose text is exactly `label` and that carries an inline font-family. */
function styledLabel(root: HTMLElement, label: string): HTMLElement | null {
  const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
  return (
    candidates.find((el) => el.textContent?.trim() === label && el.style.fontFamily !== "") ?? null
  )
}

function stubUserAgent(ua: string, maxTouchPoints = 0) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua)
  // jsdom's navigator has no maxTouchPoints at all — define it for the test.
  Object.defineProperty(window.navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  delete (window.navigator as { maxTouchPoints?: number }).maxTouchPoints
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TypographySection", () => {
  it("AC-2: four role comboboxes in order, each showing Inter, each with its description", () => {
    stubFetchOk()
    renderSection()

    const boxes = screen.getAllByRole("combobox")
    expect(boxes).toHaveLength(4)
    ROLE_NAMES.forEach((name, i) => {
      expect(boxes[i]).toBe(screen.getByRole("combobox", { name }))
      expect(boxes[i].textContent?.trim()).toBe("Inter")
    })
    for (const description of ROLE_DESCRIPTIONS) {
      expect(screen.getByText(description)).toBeInTheDocument()
    }
  })

  it("AC-3: the Text list shows the eleven fonts in registry order, grouped Sans/Mono, each label in its own font", async () => {
    stubFetchOk()
    const user = setup()
    renderSection()

    await user.click(trigger("Text"))

    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(11)
    const labels = FONT_IDS.map((id) => FONTS[id].label)
    expect(labels).toEqual([
      "Inter",
      "Martian Grotesk",
      "PT Root UI",
      "Golos Text",
      "IBM Plex Sans",
      "SF Pro",
      "SF Pro Rounded",
      "Martian Mono",
      "JetBrains Mono",
      "IBM Plex Mono",
      "SF Mono",
    ])
    options.forEach((option, i) => {
      expect(option.textContent?.trim().startsWith(labels[i])).toBe(true)
    })

    const sans = screen.getByRole("group", { name: "Sans" })
    const mono = screen.getByRole("group", { name: "Mono" })
    expect(within(sans).getAllByRole("option")).toEqual(options.slice(0, 7))
    expect(within(mono).getAllByRole("option")).toEqual(options.slice(7))

    FONT_IDS.forEach((id, i) => {
      const label = styledLabel(options[i], labels[i])
      expect(label, `styled label for ${id}`).not.toBeNull()
      expect(label!.style.fontFamily).toBe(`var(--f-${id}-text-family)`)
    })
  })

  it("AC-4: SF options carry availability hints outside the mirrored label; the trigger shows only \"SF Pro\"", async () => {
    stubFetchOk()
    const user = setup()
    renderSection()

    await user.click(trigger("Text"))
    const options = screen.getAllByRole("option")
    const expectedHints: Record<string, string | null> = {
      inter: null,
      "martian-grotesk": null,
      "pt-root-ui": null,
      "golos-text": null,
      "ibm-plex-sans": null,
      "sf-pro": "Apple devices",
      "sf-pro-rounded": "Safari and iOS",
      "martian-mono": null,
      "jetbrains-mono": null,
      "ibm-plex-mono": null,
      "sf-mono": "Apple devices",
    }
    FONT_IDS.forEach((id, i) => {
      const hint = expectedHints[id]
      const text = (options[i].textContent ?? "").replace(/\s+/g, "")
      const expected = `${FONTS[id].label}${hint ?? ""}`.replace(/\s+/g, "")
      expect(text, `option text for ${id}`).toBe(expected)
      expect(options[i], `accessible name for ${id}`).toHaveAccessibleName(FONTS[id].label)
      if (hint) {
        expect(within(options[i]).getByText(hint)).toBeInTheDocument()
        expect(options[i], `accessible description for ${id}`).toHaveAccessibleDescription(hint)
      } else {
        expect(options[i], `no description for ${id}`).toHaveAccessibleDescription("")
      }
    })

    await user.click(options[FONT_IDS.indexOf("sf-pro")])

    expect(triggerText("Text")).toBe("SF Pro")
    expect(styledLabel(trigger("Text"), "SF Pro")?.style.fontFamily).toBe("var(--f-sf-pro-text-family)")
  })

  it("AC-5: choosing PT Root UI for Text PATCHes the full object, updates the trigger and the provider <style>", async () => {
    const fetchMock = stubFetchOk()
    const user = setup()
    renderSection()

    await choose(user, "Text", "PT Root UI")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodies(fetchMock)).toEqual([
      '{"typography":{"heading":"inter","text":"pt-root-ui","counter":"inter","tag":"inter"}}',
    ])
    expect(triggerText("Text")).toBe("PT Root UI")
    expect(styleText()).toContain("--type-text-family:var(--f-pt-root-ui-text-family)")
  })

  it("AC-6: five aria-pressed preset chips; Martian sends its preset and fills the four triggers", async () => {
    const fetchMock = stubFetchOk()
    const user = setup()
    renderSection()

    for (const name of CHIP_NAMES) {
      expect(chip(name)).toHaveAttribute("aria-pressed")
    }
    expect(pressed()).toEqual(["Inter"])

    await user.click(chip("Martian"))

    expect(bodies(fetchMock)).toEqual([body(presetPrefs("martian"))])
    expect(pressed()).toEqual(["Martian"])
    expect(ROLE_NAMES.map(triggerText)).toEqual([
      "Martian Grotesk",
      "Martian Grotesk",
      "Martian Mono",
      "Martian Grotesk",
    ])
  })

  it("AC-6b: the Plex chip sends its preset and fills all four roles", async () => {
    const fetchMock = stubFetchOk()
    const user = setup()
    renderSection()

    await user.click(chip("Plex"))

    expect(bodies(fetchMock)).toEqual([body(presetPrefs("plex"))])
    expect(pressed()).toEqual(["Plex"])
    expect(ROLE_NAMES.map(triggerText)).toEqual([
      "IBM Plex Sans",
      "IBM Plex Sans",
      "IBM Plex Mono",
      "IBM Plex Sans",
    ])
  })

  it("AC-7: prefs matching no preset press no chip and show \"Custom\"; preset prefs hide it", () => {
    stubFetchOk()
    const first = renderSection(CUSTOM)
    expect(pressed()).toEqual([])
    expect(screen.getByText("Custom")).toBeInTheDocument()
    first.unmount()

    renderSection(presetPrefs("apple"))
    expect(pressed()).toEqual(["Apple"])
    expect(screen.queryByText("Custom")).toBeNull()
  })

  it("AC-8: a result equal to the all-Inter default sends {\"typography\":null} — via the Inter chip and via a role select", async () => {
    const fetchMock = stubFetchOk()
    const user = setup()
    const first = renderSection(presetPrefs("martian"))

    await user.click(chip("Inter"))
    expect(bodies(fetchMock)).toEqual(['{"typography":null}'])
    first.unmount()

    fetchMock.mockClear()
    renderSection(CUSTOM)
    await choose(user, "Headings", "Inter")
    expect(bodies(fetchMock)).toEqual(['{"typography":null}'])
  })

  it.each([
    ["Martian Mono in Text", { heading: "inter", text: "martian-mono", counter: "inter", tag: "inter" }, true],
    ["SF Mono in Text", { heading: "inter", text: "sf-mono", counter: "inter", tag: "inter" }, true],
    ["JetBrains Mono in Text", { heading: "inter", text: "jetbrains-mono", counter: "inter", tag: "inter" }, true],
    ["IBM Plex Mono in Text", { heading: "inter", text: "ibm-plex-mono", counter: "inter", tag: "inter" }, true],
    ["sans Text, mono Counters and Headings", { heading: "sf-mono", text: "inter", counter: "martian-mono", tag: "inter" }, false],
  ] as const)("AC-9: mono-reading note — %s", (_name, prefs, shown) => {
    stubFetchOk()
    renderSection({ ...prefs })
    if (shown) expect(screen.getByText(NOTE_MONO)).toBeInTheDocument()
    else expect(screen.queryByText(NOTE_MONO)).toBeNull()
  })

  it.each([
    ["Windows Chrome, SF Pro in Headings", UA.windowsChrome, { heading: "sf-pro", text: "inter", counter: "inter", tag: "inter" }, NOTE_NO_SF],
    ["Windows Chrome, SF Mono in Counters", UA.windowsChrome, { heading: "inter", text: "inter", counter: "sf-mono", tag: "inter" }, NOTE_NO_SF_MONO],
    ["Windows Chrome, the Apple preset (SF Pro + SF Mono)", UA.windowsChrome, { heading: "sf-pro", text: "sf-pro", counter: "sf-mono", tag: "sf-pro" }, NOTE_NO_SF_BOTH],
    ["iPad desktop mode, SF Pro Rounded in Tags", UA.macChrome, { heading: "inter", text: "inter", counter: "inter", tag: "sf-pro-rounded" }, null, 5],
    ["macOS Chrome, SF Pro Rounded in Tags", UA.macChrome, { heading: "inter", text: "inter", counter: "inter", tag: "sf-pro-rounded" }, NOTE_NO_ROUNDED],
    ["macOS Safari, SF Pro Rounded + SF Pro", UA.macSafari, { heading: "sf-pro", text: "sf-pro-rounded", counter: "inter", tag: "inter" }, null],
    ["Windows Chrome, no SF font", UA.windowsChrome, { heading: "martian-grotesk", text: "inter", counter: "martian-mono", tag: "pt-root-ui" }, null],
    ["macOS Chrome, no SF font", UA.macChrome, { ...DEFAULT_TYPOGRAPHY }, null],
  ] as const)("AC-11: device notes after mount — %s", async (_name, ua, prefs, expected, touchPoints = 0) => {
    stubFetchOk()
    stubUserAgent(ua, touchPoints)
    renderSection({ ...prefs })
    // Settle the post-mount effect before asserting either presence or absence.
    await act(async () => {})
    // The card itself must be up (proves the render ran), whatever the note.
    expect(screen.getAllByRole("combobox")).toHaveLength(4)

    if (expected) expect(await screen.findByText(expected)).toBeInTheDocument()
    for (const note of DEVICE_NOTES) {
      if (note !== expected) expect(screen.queryByText(note)).toBeNull()
    }
  })

  it("AC-11b: presets form a named group, each role combobox is described by its role text, and notes live in a mounted status region", async () => {
    stubFetchOk()
    const user = setup()
    renderSection()

    const group = screen.getByRole("group", { name: "Presets" })
    expect(within(group).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([...CHIP_NAMES])

    ROLE_NAMES.forEach((name, i) => {
      expect(trigger(name)).toHaveAccessibleDescription(ROLE_DESCRIPTIONS[i])
    })

    const status = screen.getByRole("status")
    expect(status).toBeEmptyDOMElement()
    await choose(user, "Text", "Martian Mono")
    expect(within(status).getByText(NOTE_MONO)).toBeInTheDocument()
  })

  it("AC-11c: chips, role triggers and font options carry the 44px mobile floor, relaxed from sm up", async () => {
    stubFetchOk()
    const user = setup()
    renderSection()

    const floor = (el: HTMLElement, what: string) => {
      expect(el.className, what).toContain("min-h-[44px]")
      expect(el.className, what).toContain("sm:min-h-0")
    }
    for (const name of CHIP_NAMES) floor(chip(name), `chip ${name}`)
    for (const name of ROLE_NAMES) floor(trigger(name), `trigger ${name}`)
    await user.click(trigger("Text"))
    for (const option of screen.getAllByRole("option")) floor(option, `option ${option.textContent}`)
  })

  it("AC-11 (constraint): the server render shows no device note even on a non-Apple device", () => {
    stubFetchOk()
    stubUserAgent(UA.windowsChrome)
    const html = renderToString(
      <TypographyProvider initialPrefs={{ heading: "sf-pro", text: "inter", counter: "inter", tag: "inter" }}>
        <TypographySection />
      </TypographyProvider>,
    )
    expect(html).toContain("Headings")
    expect(html).not.toContain("SF fonts are only on Apple devices")
  })

  it("EC-1: two quick choices end on the second, even when the first request fails", async () => {
    const { fetchMock, calls } = stubFetchControlled()
    const user = setup()
    renderSection()

    await choose(user, "Text", "PT Root UI")
    await choose(user, "Text", "Martian Grotesk")
    await act(async () => {
      calls[0].reject(new TypeError("Failed to fetch"))
    })
    await act(async () => {
      calls[calls.length - 1].resolve({ ok: true, status: 200 })
    })

    expect(triggerText("Text")).toBe("Martian Grotesk")
    const sent = bodies(fetchMock)
    expect(sent.at(-1)).toBe(
      '{"typography":{"heading":"inter","text":"martian-grotesk","counter":"inter","tag":"inter"}}',
    )
  })

  it("EC-2: a failed save returns the trigger and the chips to the last confirmed prefs", async () => {
    const { calls } = stubFetchControlled()
    const user = setup()
    renderSection(presetPrefs("martian"))
    expect(pressed()).toEqual(["Martian"])

    await choose(user, "Text", "PT Root UI")
    expect(triggerText("Text")).toBe("PT Root UI")
    expect(pressed()).toEqual([])

    await act(async () => {
      calls[0].resolve({ ok: false, status: 500 })
    })

    await waitFor(() => expect(triggerText("Text")).toBe("Martian Grotesk"))
    expect(pressed()).toEqual(["Martian"])
  })

  it("AC-12 (section): TypographySection renders the specimen", () => {
    stubFetchOk()
    const { container } = renderSection()
    expect(container.querySelector(".type-heading")).not.toBeNull()
    const counters = Array.from(container.querySelectorAll(".type-counter")).map((el) => el.textContent?.trim())
    expect(counters).toEqual(expect.arrayContaining(["12", "87%"]))
  })
})

describe("TypographySpecimen", () => {
  it("AC-12: heading.type-heading, an unclassed paragraph, counters 12 and 87%, two Badges", () => {
    stubFetchOk()
    const { container } = render(
      <TypographyProvider initialPrefs={{ ...DEFAULT_TYPOGRAPHY }}>
        <TypographySpecimen />
      </TypographyProvider>,
    )

    const headings = Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).filter((h) =>
      h.classList.contains("type-heading"),
    )
    expect(headings.length).toBeGreaterThanOrEqual(1)
    expect(headings[0].textContent?.trim()).not.toBe("")

    const paragraphs = Array.from(container.querySelectorAll<HTMLElement>("p"))
    const plain = paragraphs.filter((p) => ![...p.classList].some((c) => c.startsWith("type-")))
    expect(plain.length).toBeGreaterThanOrEqual(1)

    const counters = Array.from(container.querySelectorAll(".type-counter")).map((el) => el.textContent?.trim())
    expect(counters).toEqual(expect.arrayContaining(["12", "87%"]))

    for (const tag of ["Design", "Tools"]) expect(screen.getByText(tag)).toHaveClass("type-tag")
  })
})
