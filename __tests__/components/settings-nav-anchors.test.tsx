// @vitest-environment jsdom

/**
 * Settings left-nav anchors (RAD-418).
 *
 * On md+ the dashboard shell scrolls its own `<main>`, not the window, so the
 * nav used to do nothing: `window.scrollTo` is a no-op inside a scroll
 * container and a `window` scroll listener never fires. These tests pin the
 * behaviours that make the nav work again — click → `scrollIntoView` on the
 * matching section, active tracking from the real scroll container, the bottom
 * edge belonging to the last section, and a click keeping its own highlight
 * until reader input releases it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { SettingsForm } from "@/components/settings/settings-form"
import { TypographyProvider } from "@/components/providers/typography-provider"
import { DEFAULT_TYPOGRAPHY } from "@/lib/typography/prefs"

// Radix controls in the form rely on DOM APIs jsdom lacks. Polyfilled here, not
// in the shared setup — same seam the typography-settings test uses.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.setPointerCapture = () => {}
})

beforeEach(() => {
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  vi.mocked(Element.prototype.scrollIntoView).mockClear()
  vi.restoreAllMocks()
})

const INITIAL_SETTINGS = {
  globalPrompt: null,
  aiModel: null,
  aiTemperature: null,
  notionToken: null,
  hasNotionToken: false,
  notionDatabaseId: null,
  aiApiKey: null,
  telegramApiId: null,
  telegramApiHash: null,
  telegramSessionString: null,
  telegramPhoneNumber: null,
  parallelApiKey: null,
  parallelWebhookSecret: null,
  storyInboxChannelId: null,
  storyNotionDatabaseId: null,
  storySystemPrompt: null,
  storyWriterModel: null,
  storyMatcherModel: null,
  materialStoryModel: null,
  synthesisModel: null,
  discoveryModel: null,
  filterReasoningEffort: null,
  storyLanguage: "en",
  autoDeleteTelegramMessages: false,
  globalLikedCategories: [],
  globalDislikedCategories: [],
}

const ACCOUNT = { email: "reader@example.com", username: "reader", canEditEmail: true }

function settingsForm(isAdmin = false) {
  return (
    <TypographyProvider initialPrefs={DEFAULT_TYPOGRAPHY}>
      <SettingsForm
        initialSettings={INITIAL_SETTINGS}
        initialBlacklist={[]}
        initialFeedback={[]}
        isAdmin={isAdmin}
        account={ACCOUNT}
      />
    </TypographyProvider>
  )
}

/**
 * Render the form inside an `overflow-y: auto` column, the way `<main>` wraps
 * it on md+. jsdom reports zero heights for every element, so the geometry the
 * scroll detection reads is defined here before render.
 */
function renderSettings({ scroller = true } = {}) {
  if (!scroller) {
    const utils = render(settingsForm())
    return { scroller: null, ...utils }
  }

  const column = document.createElement("div")
  column.style.overflowY = "auto"
  Object.defineProperty(column, "clientHeight", { configurable: true, value: 800 })
  Object.defineProperty(column, "scrollHeight", { configurable: true, value: 2000 })
  document.body.appendChild(column)

  const utils = render(settingsForm(), { container: column })
  return { scroller: column, ...utils }
}

/** Give every section the viewport-relative top the active-tracking reads. */
function stubSectionTops(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    const section = document.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!section) throw new Error(`missing section ${id}`)
    section.getBoundingClientRect = () =>
      ({ top, bottom: top + 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  }
}

const navButton = (name: string) => screen.getByRole("button", { name, exact: true })

describe("SettingsForm left-nav anchors (RAD-418)", () => {
  it("scrolls the matching section into view and marks its nav item current", async () => {
    const user = userEvent.setup()
    renderSettings()

    const section = document.querySelector<HTMLElement>('[data-section="integrations"]')
    if (!section) throw new Error("missing integrations section")
    const scrollIntoView = vi.spyOn(section, "scrollIntoView")

    await user.click(navButton("Integrations"))

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
    expect(navButton("Integrations")).toHaveAttribute("aria-current", "location")
    expect(navButton("Account")).not.toHaveAttribute("aria-current")
    expect(window.location.hash).toBe("#integrations")
  })

  it("tracks the active section from the scroll container, not the window", () => {
    const { scroller } = renderSettings()
    stubSectionTops({ account: -800, appearance: 120, integrations: 900, filters: 1400, danger: 1800 })

    fireEvent.scroll(scroller)

    expect(navButton("Appearance")).toHaveAttribute("aria-current", "location")
    expect(navButton("Account")).not.toHaveAttribute("aria-current")
  })

  it("marks the last section active at the bottom edge, where only it can win", () => {
    const { scroller } = renderSettings()
    // At max scroll Filters is above the active line and Danger Zone is still
    // near the bottom of the pane: without the bottom rule Filters would win.
    stubSectionTops({ account: -1600, appearance: -1200, integrations: -600, filters: 60, danger: 620 })
    scroller.scrollTop = 1200

    fireEvent.scroll(scroller)

    expect(navButton("Danger Zone")).toHaveAttribute("aria-current", "location")
    expect(navButton("Filters")).not.toHaveAttribute("aria-current")
  })

  it("keeps a clicked section active at the bottom until the reader scrolls", async () => {
    const user = userEvent.setup()
    const { scroller } = renderSettings()
    stubSectionTops({ account: -1600, appearance: -1200, integrations: -600, filters: 60, danger: 620 })
    scroller.scrollTop = 1200

    await user.click(navButton("Filters"))
    // "Filters" cannot top-align at the bottom — its smooth scroll lands on the
    // bottom edge, and the bottom rule must not hand the highlight away.
    fireEvent.scroll(scroller)

    expect(navButton("Filters")).toHaveAttribute("aria-current", "location")

    // A reader's own wheel releases the click, and the bottom rule applies.
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)

    expect(navButton("Danger Zone")).toHaveAttribute("aria-current", "location")
  })

  it("tracks the document when the page scrolls on the window (mobile)", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 })
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 2000 })
    renderSettings({ scroller: false })
    stubSectionTops({ account: -600, appearance: 100, integrations: 900, filters: 1400, danger: 1800 })

    fireEvent.scroll(document)

    expect(navButton("Appearance")).toHaveAttribute("aria-current", "location")

    Object.defineProperty(window, "scrollY", { configurable: true, value: 1200 })
    fireEvent.scroll(document)

    expect(navButton("Danger Zone")).toHaveAttribute("aria-current", "location")
  })

  it("keeps the nav in step with the sections in the DOM", () => {
    renderSettings()
    const navIds = screen.getAllByRole("navigation")
      .find((nav) => nav.getAttribute("aria-label") === "Settings sections")
    if (!navIds) throw new Error("settings nav is missing its label")
    const buttons = Array.from(navIds.querySelectorAll("button")).map((b) => b.textContent?.trim())
    const sections = Array.from(document.querySelectorAll("[data-section]")).map((s) =>
      s.getAttribute("data-section")
    )
    expect(buttons).toHaveLength(sections.length)

    // The bottom rule trusts the last DOM section to be the last nav item.
    const labels = ["Account", "Appearance", "Integrations", "Filters", "Danger Zone"]
    expect(buttons).toEqual(labels)
    expect(sections.length).toBe(labels.length)
  })
})
