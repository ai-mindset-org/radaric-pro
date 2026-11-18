/**
 * @vitest-environment jsdom
 */

/**
 * RAD-393 — sidebar folder tree.
 *
 * Renders the real Sidebar under the real provider with fetch/router mocked.
 * Covers: the folder/uncategorized split, badge sums, expand/collapse (cookie),
 * transient expansion for the active source, inline create/rename with inline
 * duplicate errors, the delete dialog copy, the kebab move paths, optimistic
 * moves with revert + toast, the live-region announcement, and instance sync.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- fetch mocks and fixtures */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { usePathname } from "next/navigation"
import { toast } from "sonner"
import { Sidebar } from "@/components/layout/sidebar"
import { SidebarTreeProvider } from "@/components/layout/sidebar-tree-provider"
import type { SidebarFolder, SidebarSource } from "@/components/layout/sidebar-types"

const FOLDERS: SidebarFolder[] = [
  { id: "folder-1", name: "Design" },
  { id: "folder-2", name: "Tech" },
]

const SOURCES: SidebarSource[] = [
  { id: "feed-1", name: "Alpha", type: "RSS", coverUrl: null, faviconUrl: null, inboxCount: 2, folderId: "folder-1" },
  { id: "feed-2", name: "Beta", type: "RSS", coverUrl: null, faviconUrl: null, inboxCount: 3, folderId: "folder-1" },
  { id: "feed-3", name: "Gamma", type: "RSS", coverUrl: null, faviconUrl: null, inboxCount: 1, folderId: null },
]

function setPathname(path: string) {
  vi.mocked(usePathname).mockReturnValue(path)
}

let fetchMock: ReturnType<typeof vi.fn>

/** Bodies of the collapse-state writes to /api/ui-state (RAD-408: a route handler, not a server action). */
function uiStateWrites(): unknown[] {
  return fetchMock.mock.calls
    .filter(([input]) => input === "/api/ui-state")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

function renderTree(options: { folders?: SidebarFolder[]; sources?: SidebarSource[]; collapsed?: string[]; twoInstances?: boolean } = {}) {
  return render(
    <SidebarTreeProvider
      folders={options.folders ?? FOLDERS}
      sources={options.sources ?? SOURCES}
      collapsed={options.collapsed ?? []}
    >
      <Sidebar instanceId="desktop" id="sidebar-desktop" />
      {options.twoInstances && <Sidebar instanceId="mobile" id="sidebar-mobile" />}
    </SidebarTreeProvider>
  )
}

/** Open a row's kebab menu and return the user for further steps. */
async function openActions(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }))
}

/** Open the "Move to folder" submenu with the keyboard and click an item. */
async function moveViaMenu(
  user: ReturnType<typeof userEvent.setup>,
  sourceName: string,
  folderName: string
) {
  await openActions(user, sourceName)
  await user.keyboard("{ArrowDown}")
  await user.keyboard("{ArrowRight}")
  const item = await screen.findByRole("menuitem", { name: folderName })
  await user.click(item)
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  vi.stubGlobal("fetch", fetchMock)
  setPathname("/posts")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("RAD-393: folder tree", () => {
  it("splits sources into folders and the Uncategorized bucket, and sums folder badges", () => {
    renderTree()

    expect(screen.getByText("Design")).toBeInTheDocument()
    expect(screen.getByText("Tech")).toBeInTheDocument()
    expect(screen.getByText("Uncategorized")).toBeInTheDocument()

    // Design badge = Alpha (2) + Beta (3)
    expect(screen.getByRole("link", { name: /design/i })).toHaveTextContent("5")
    // Gamma lives in Uncategorized
    expect(screen.getByRole("link", { name: /gamma/i })).toBeInTheDocument()
  })

  it("uses live counts over SSR counts in the folder badge", () => {
    render(
      <SidebarTreeProvider folders={FOLDERS} sources={SOURCES} collapsed={[]}>
        <Sidebar instanceId="desktop" liveCounts={{ "feed-1": 10, "feed-2": 0 }} />
      </SidebarTreeProvider>
    )
    expect(screen.getByRole("link", { name: /design/i })).toHaveTextContent("10")
  })

  it("collapses a folder, hiding its members, and persists the collapsed ids", async () => {
    const user = userEvent.setup()
    renderTree({ collapsed: ["folder-1"] })

    const toggle = screen.getByRole("button", { name: /expand design/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("link", { name: /alpha/i })).toBeNull()

    await user.click(toggle)

    await waitFor(() => expect(screen.getByRole("link", { name: /alpha/i })).toBeInTheDocument())
    expect(uiStateWrites()).toEqual([{ collapsedFolders: [] }])
    expect(fetchMock).toHaveBeenCalledWith("/api/ui-state", expect.objectContaining({ method: "POST", keepalive: true }))
  })

  it("expands a collapsed folder transiently when it holds the active source (cookie untouched)", () => {
    setPathname("/feeds/feed-1")
    renderTree({ collapsed: ["folder-1"] })

    expect(screen.getByRole("link", { name: /alpha/i })).toBeInTheDocument()
    expect(uiStateWrites()).toEqual([])
  })

  it("keeps both mounted instances in sync through one provider", async () => {
    const user = userEvent.setup()
    renderTree({ twoInstances: true })

    const desktopToggle = screen.getAllByRole("button", { name: /collapse design/i })[0]
    await user.click(desktopToggle)

    for (const toggle of screen.getAllByRole("button", { name: /expand design/i })) {
      expect(toggle).toHaveAttribute("aria-expanded", "false")
    }
  })
})

describe("RAD-393: create", () => {
  it("creates a folder inline from the + button", async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (input: any, init: any) => {
      if (String(input) === "/api/folders") {
        const body = JSON.parse(init.body)
        return { ok: true, status: 201, json: async () => ({ folder: { id: "folder-3", name: body.name } }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })

    renderTree()
    await user.click(screen.getByRole("button", { name: "New folder" }))

    const input = screen.getByRole("textbox", { name: "Folder name" })
    await user.type(input, "Later")
    await user.keyboard("{Enter}")

    await waitFor(() => expect(screen.getByText("Later")).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/folders",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Later" }) })
    )
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull()
    // Focus lands on the new folder row (reveal + flash).
    await waitFor(() => expect(document.activeElement?.id).toBe("desktop-folder-folder-3"))
  })

  it("keeps the editor value and shows the failure message on a transport error", async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValue(new Error("offline"))

    renderTree()
    await user.click(screen.getByRole("button", { name: "New folder" }))
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Later")
    await user.keyboard("{Enter}")

    expect(await screen.findByText("Couldn’t create the folder — try again.")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Later")
  })

  it("keeps the editor open with an inline message on a duplicate", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "duplicate" }) })

    renderTree()
    await user.click(screen.getByRole("button", { name: "New folder" }))
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Design")
    await user.keyboard("{Enter}")

    expect(
      await screen.findByText("A folder with this name already exists.")
    ).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Folder name" })).toBeInTheDocument()
  })

  it("cancels creation on Escape", async () => {
    const user = userEvent.setup()
    renderTree()
    await user.click(screen.getByRole("button", { name: "New folder" }))
    expect(screen.getByRole("textbox", { name: "Folder name" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull()
  })
})

describe("RAD-393: rename and delete", () => {
  it("renames a folder from the kebab, sending both name and key to the API", async () => {
    const user = userEvent.setup()
    renderTree()

    await openActions(user, "Design")
    await user.click(await screen.findByRole("menuitem", { name: /rename/i }))

    const input = screen.getByRole("textbox", { name: /folder name for design/i })
    await user.clear(input)
    await user.type(input, "Product design")
    await user.keyboard("{Enter}")

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/folders/folder-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "Product design" }),
        })
      )
    )
  })

  it("deletes a folder with the exact confirmation copy and keeps sources", async () => {
    const user = userEvent.setup()
    renderTree({ sources: [SOURCES[0], SOURCES[2]] }) // Design has 1 member

    await openActions(user, "Design")
    await user.click(await screen.findByRole("menuitem", { name: /delete folder/i }))

    expect(await screen.findByText("Delete folder “Design”?")).toBeInTheDocument()
    expect(
      screen.getByText("1 source will move back to Uncategorized. No sources or materials are deleted.")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete folder" }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/folders/folder-1",
        expect.objectContaining({ method: "DELETE" })
      )
    )
    // The member lands in Uncategorized optimistically (FK SetNull mirrored).
    const uncategorized = screen.getByText("Uncategorized").parentElement!
    expect(uncategorized.textContent).toContain("Alpha")
  })
})

describe("RAD-393: moves via the kebab (canonical path)", () => {
  it("moves an uncategorized source into a folder and announces it", async () => {
    const user = userEvent.setup()
    renderTree()

    await moveViaMenu(user, "Gamma", "Design")

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feeds/feed-3/folder",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ folderId: "folder-1" }),
        })
      )
    )
    // dnd-kit renders its own status region; ours carries the move text.
    expect(await screen.findByText("Gamma moved to Design")).toBeInTheDocument()
    // The moved row is revealed: focused at its new position.
    await waitFor(() => expect(document.activeElement?.id).toBe("desktop-source-feed-3"))
  })

  it("marks the source's current folder as disabled in the submenu", async () => {
    const user = userEvent.setup()
    renderTree()

    await openActions(user, "Alpha")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowRight}")

    const current = await screen.findByRole("menuitem", { name: "Design" })
    expect(current).toHaveAttribute("aria-disabled", "true")
  })

  it("offers Remove from folder only for a foldered source", async () => {
    const user = userEvent.setup()
    renderTree()

    await openActions(user, "Gamma")
    expect(screen.queryByRole("menuitem", { name: /remove from folder/i })).toBeNull()
    await user.keyboard("{Escape}")

    await openActions(user, "Alpha")
    await user.click(await screen.findByRole("menuitem", { name: /remove from folder/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feeds/feed-1/folder",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ folderId: null }),
        })
      )
    )
  })

  it("reverts an optimistic move and toasts when the request fails", async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValue(new Error("offline"))
    renderTree()

    await moveViaMenu(user, "Gamma", "Design")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn’t move “Gamma” — try again.")
    )
    const designList = document.getElementById("desktop-folder-folder-1-sources")
    expect(designList?.textContent).toContain("Alpha")
    expect(designList?.textContent).not.toContain("Gamma")
  })

  it("does not let refreshed props clobber an in-flight optimistic move", async () => {
    const user = userEvent.setup()
    let release!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    fetchMock.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )

    const { rerender } = render(
      <SidebarTreeProvider folders={FOLDERS} sources={SOURCES} collapsed={[]}>
        <Sidebar instanceId="desktop" id="sidebar-desktop" />
      </SidebarTreeProvider>
    )

    await moveViaMenu(user, "Gamma", "Design")

    // Stale server props arrive while the move request is still in flight
    // (structurally identical content, new array identities).
    rerender(
      <SidebarTreeProvider
        folders={FOLDERS.map(folder => ({ ...folder }))}
        sources={SOURCES.map(source => ({ ...source }))}
        collapsed={[]}
      >
        <Sidebar instanceId="desktop" id="sidebar-desktop" />
      </SidebarTreeProvider>
    )

    const designList = document.getElementById("desktop-folder-folder-1-sources")
    expect(designList?.textContent).toContain("Gamma")

    release({ ok: true, status: 200, json: async () => ({}) })
    await waitFor(() => expect(screen.getByText("Gamma moved to Design")).toBeInTheDocument())
  })

  it("creates and moves in one flow from New folder… in a source menu", async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (input: any, init: any) => {
      const url = String(input)
      if (url === "/api/folders") {
        const body = JSON.parse(init.body)
        return { ok: true, status: 201, json: async () => ({ folder: { id: "folder-9", name: body.name } }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    renderTree()

    await openActions(user, "Gamma")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowRight}")
    await screen.findByRole("menuitem", { name: /new folder/i })
    // Submenu focus starts on Design; walk to the last item explicitly.
    await user.keyboard("{ArrowDown}") // Design
    await user.keyboard("{ArrowDown}") // Tech
    await user.keyboard("{ArrowDown}") // New folder…
    expect(document.activeElement?.textContent).toMatch(/new folder/i)
    await user.keyboard("{Enter}")

    const input = await screen.findByRole("textbox", { name: "Folder name" })
    await user.type(input, "Fresh")
    await user.keyboard("{Enter}")

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feeds/feed-3/folder",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ folderId: "folder-9" }),
        })
      )
    )
  })
})
