/**
 * @vitest-environment jsdom
 */

/**
 * Telegram rich text — interactive leaves and the text-integrity invariant.
 *
 * The converter's structure is pinned in the node test
 * (__tests__/lib/telegram-entities-to-react.test.tsx). Here: the spoiler and the
 * collapsed quote must stay clickable/keyboard-operable without letting a click
 * escape into the surrounding card, and no combination of entities may lose,
 * duplicate or reorder a single character.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  convertTelegramEntitiesToReact,
  type TelegramEntity,
  type RichTextVariant,
} from "@/lib/telegram-entities-to-react"

afterEach(cleanup)

function renderRich(text: string, entities: TelegramEntity[], variant?: RichTextVariant) {
  return render(<div>{convertTelegramEntitiesToReact(text, entities, variant)}</div>)
}

describe("TelegramSpoiler", () => {
  const spoiler: TelegramEntity[] = [{ className: "MessageEntitySpoiler", offset: 0, length: 6 }]

  it("starts hidden, reveals on click, and toggles back", async () => {
    const user = userEvent.setup()
    const { getByRole } = renderRich("secret", spoiler)

    const button = getByRole("button", { name: /reveal spoiler/i })
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(button.className).toContain("blur")

    await user.click(button)

    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(button.className).not.toContain("blur")

    await user.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("false")
  })

  it("reveals with the keyboard", async () => {
    const user = userEvent.setup()
    const { getByRole } = renderRich("secret", spoiler)

    await user.tab()
    const button = getByRole("button", { name: /reveal spoiler/i })
    expect(document.activeElement).toBe(button)

    await user.keyboard("{Enter}")
    expect(button.getAttribute("aria-expanded")).toBe("true")
  })

  it("does not bubble the click into a surrounding clickable card", async () => {
    const user = userEvent.setup()
    const onCardClick = vi.fn()
    const { getByRole } = render(
      <div onClick={onCardClick} role="presentation">
        {convertTelegramEntitiesToReact("secret", spoiler)}
      </div>
    )

    await user.click(getByRole("button", { name: /reveal spoiler/i }))
    expect(onCardClick).not.toHaveBeenCalled()
  })
})

describe("collapsed blockquote", () => {
  const text = "a long quote that should start clamped"
  const quote: TelegramEntity[] = [
    { className: "MessageEntityBlockquote", offset: 0, length: text.length, collapsed: true },
  ]

  it("expands and collapses", async () => {
    const user = userEvent.setup()
    const { getByRole, container } = renderRich(text, quote)

    const toggle = getByRole("button", { name: /show more/i })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector(".line-clamp-3")).not.toBeNull()

    await user.click(toggle)

    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(container.querySelector(".line-clamp-3")).toBeNull()
    expect(getByRole("button", { name: /show less/i })).toBe(toggle)
  })

  it("does not bubble the toggle click into a surrounding clickable card", async () => {
    const user = userEvent.setup()
    const onCardClick = vi.fn()
    const { getByRole } = render(
      <div onClick={onCardClick} role="presentation">
        {convertTelegramEntitiesToReact(text, quote)}
      </div>
    )

    await user.click(getByRole("button", { name: /show more/i }))
    expect(onCardClick).not.toHaveBeenCalled()
  })
})

describe("text integrity", () => {
  const cases: Array<{ name: string; text: string; entities: TelegramEntity[] }> = [
    {
      name: "nested bold + link inside a quote",
      text: "the release notes say more",
      entities: [
        { className: "MessageEntityBlockquote", offset: 0, length: 27 },
        { className: "MessageEntityBold", offset: 4, length: 13 },
        { className: "MessageEntityTextUrl", offset: 18, length: 4, url: "https://x.com" },
      ],
    },
    {
      name: "pre nested in a quote",
      text: "intro\nconst x = 1\noutro",
      entities: [
        { className: "MessageEntityBlockquote", offset: 0, length: 24 },
        { className: "MessageEntityPre", offset: 6, length: 11 },
      ],
    },
    {
      name: "spoiler, code and emoji",
      text: "😈 hidden npm i chars",
      entities: [
        { className: "MessageEntitySpoiler", offset: 2, length: 6 },
        { className: "MessageEntityCode", offset: 9, length: 5 },
      ],
    },
    {
      name: "adjacent same-type entities",
      text: "one two",
      entities: [
        { className: "MessageEntityBold", offset: 0, length: 3 },
        { className: "MessageEntityBold", offset: 4, length: 3 },
      ],
    },
    {
      name: "partially overlapping entities",
      text: "abcdefgh",
      entities: [
        { className: "MessageEntityBold", offset: 0, length: 5 },
        { className: "MessageEntityItalic", offset: 3, length: 5 },
      ],
    },
    {
      name: "merged multi-paragraph quote",
      text: "quote one\n\nquote two",
      entities: [
        { className: "MessageEntityBlockquote", offset: 0, length: 9 },
        { className: "MessageEntityBlockquote", offset: 11, length: 9 },
      ],
    },
  ]

  it.each(cases)("preserves every character: $name", ({ text, entities }) => {
    const { container } = renderRich(text, entities)
    expect(container.textContent).toBe(text)
  })

  it("renders without React key or HTML-nesting warnings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      for (const { text, entities } of cases) {
        renderRich(text, entities)
        renderRich(text, entities, "compact")
      }
      const problems = errorSpy.mock.calls.filter((call) => {
        const message = String(call[0])
        return message.includes('unique "key"') || message.includes("cannot be a descendant")
      })
      expect(problems).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})
