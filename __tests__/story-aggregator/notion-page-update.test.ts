/**
 * RAD-401 review — re-publishing a story must never leave an empty Notion page.
 *
 * The update path used to delete every old block before appending the new
 * ones, so a failed append (a 400 from one bad media URL, a 502) left the page
 * blank. Now: update properties → list ALL old block ids → append the new
 * blocks in batches of 100 → only then delete the old ids.
 *
 * Covered at both callers: `buildPipelineDeps().updateNotionPage` (API routes)
 * is exercised end to end against a mocked @notionhq/client; the worker's copy
 * cannot be imported (the module boots the worker on import), so a source
 * contract pins it to the same shared helper. Never the real Notion API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const { calls, pagesUpdate, childrenList, childrenAppend, blocksDelete } = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    pagesUpdate: vi.fn(async () => {
      calls.push("update")
      return {}
    }),
    childrenList: vi.fn(),
    childrenAppend: vi.fn(),
    blocksDelete: vi.fn(async ({ block_id }: { block_id: string }) => {
      calls.push(`delete:${block_id}`)
      return {}
    }),
  }
})

vi.mock("@notionhq/client", () => {
  class Client {
    pages = { update: pagesUpdate }
    blocks = { children: { list: childrenList, append: childrenAppend }, delete: blocksDelete }
  }
  return { Client }
})

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn(async () => ({ id: "s1", aiApiKey: "fake-anthropic-key", aiModel: null })) },
    userSettings: { findUnique: vi.fn(async () => null) },
    // RAD-369: model/prompt overrides are an admin entitlement — an operator
    // account keeps this fixture's original (full-override) behaviour.
    user: { findUnique: vi.fn(async () => ({ role: "ADMIN" })) },
    inboxItem: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    story: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    material: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock("@/lib/models/provider", () => ({ createModelInstance: vi.fn() }))

import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"

const PAGE_ID = "page-1"
const OLD_IDS = Array.from({ length: 130 }, (_, i) => `old-${i}`)
const para = (i: number) => ({ type: "paragraph", paragraph: { rich_text: [{ text: { content: `n${i}` } }] } })
const NEW_BLOCKS = Array.from({ length: 150 }, (_, i) => para(i))
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  blocksDelete.mockImplementation(async ({ block_id }: { block_id: string }) => {
    calls.push(`delete:${block_id}`)
    return {}
  })
  // Two pages of old blocks: 100 + 30.
  childrenList.mockImplementation(async ({ start_cursor }: { start_cursor?: string }) => {
    calls.push(`list:${start_cursor ?? "start"}`)
    return start_cursor
      ? { results: OLD_IDS.slice(100).map((id) => ({ id })), has_more: false, next_cursor: null }
      : { results: OLD_IDS.slice(0, 100).map((id) => ({ id })), has_more: true, next_cursor: "c2" }
  })
  childrenAppend.mockImplementation(async ({ children }: { children: unknown[] }) => {
    calls.push(`append:${children.length}`)
    return {}
  })
})

async function updateNotionPage() {
  const deps = await buildPipelineDeps("user_1", "secret_test_token")
  return deps.updateNotionPage!(PAGE_ID, { title: {} }, NEW_BLOCKS)
}

describe("pipeline-deps updateNotionPage — append before delete", () => {
  it("call order: properties → list (every page) → append(s) in batches of 100 → delete every old id", async () => {
    await updateNotionPage()

    expect(calls).toEqual([
      "update",
      "list:start",
      "list:c2",
      "append:100",
      "append:50",
      ...OLD_IDS.map((id) => `delete:${id}`),
    ])
    expect(childrenAppend.mock.calls.map((c) => (c[0] as { block_id: string }).block_id)).toEqual([PAGE_ID, PAGE_ID])
    expect((childrenAppend.mock.calls[0][0] as { children: unknown[] }).children).toEqual(NEW_BLOCKS.slice(0, 100))
    expect((childrenAppend.mock.calls[1][0] as { children: unknown[] }).children).toEqual(NEW_BLOCKS.slice(100))
  })

  it("the FIRST append rejecting aborts before ANY delete — the old content survives", async () => {
    childrenAppend.mockImplementationOnce(async () => {
      throw Object.assign(new Error("body failed validation"), { code: "validation_error" })
    })

    await expect(updateNotionPage()).rejects.toThrow("body failed validation")

    expect(blocksDelete).not.toHaveBeenCalled()
  })

  // RAD-403: a retry after a mid-way failure must not stack another copy of the
  // landed batches under the old content.
  it("an append that rejects mid-way deletes the batches that already landed, then rethrows; old blocks untouched", async () => {
    const landed = Array.from({ length: 100 }, (_, i) => `new-${i}`)
    childrenAppend.mockImplementationOnce(async () => {
      calls.push("append:100")
      return { results: landed.map((id) => ({ id })) }
    })
    childrenAppend.mockImplementationOnce(async () => {
      throw Object.assign(new Error("bad gateway"), { status: 502 })
    })

    await expect(updateNotionPage()).rejects.toThrow("bad gateway")

    const deleted = blocksDelete.mock.calls.map((c) => (c[0] as { block_id: string }).block_id)
    expect(deleted).toEqual(landed)
    expect(deleted.some((id) => id.startsWith("old-"))).toBe(false)
  })

  it("a rollback delete that fails does not mask the append error, and the other landed blocks are still removed", async () => {
    const landed = ["new-0", "new-1", "new-2"]
    childrenAppend.mockImplementationOnce(async () => ({ results: landed.map((id) => ({ id })) }))
    childrenAppend.mockImplementationOnce(async () => {
      throw new Error("bad gateway")
    })
    blocksDelete.mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === "new-1") throw new Error("rate limited")
      return {}
    })

    await expect(updateNotionPage()).rejects.toThrow("bad gateway")

    expect(blocksDelete.mock.calls.map((c) => (c[0] as { block_id: string }).block_id)).toEqual(landed)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 partially appended block/))
  })

  // RAD-403: an old block that is already gone (archived by the editor, not
  // found) needs no deleting — that is not a failed publish.
  it("an old block that is already archived or not found counts as deleted: the publish resolves", async () => {
    blocksDelete.mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === "old-3") {
        throw Object.assign(new Error("Can't edit block that is archived. You must unarchive the block before editing."), { status: 400, code: "validation_error" })
      }
      if (block_id === "old-4") throw Object.assign(new Error("Could not find block"), { status: 404, code: "object_not_found" })
      calls.push(`delete:${block_id}`)
      return {}
    })

    await expect(updateNotionPage()).resolves.toBeUndefined()

    expect(blocksDelete).toHaveBeenCalledTimes(OLD_IDS.length)
    expect(calls.filter((c) => c.startsWith("delete:"))).toEqual(
      OLD_IDS.filter((id) => id !== "old-3" && id !== "old-4").map((id) => `delete:${id}`)
    )
  })

  // The SDK (5.3) has no 429 retry and ~130 deletes run back to back; an old
  // block left behind sits ABOVE the new story, so a transient failure is retried.
  it("a rate-limited (429) or 5xx old-block delete is retried and the publish resolves", async () => {
    vi.useFakeTimers()
    try {
      const failures: Record<string, number> = { "old-3": 2, "old-7": 1 }
      blocksDelete.mockImplementation(async ({ block_id }: { block_id: string }) => {
        if (failures[block_id]) {
          failures[block_id]--
          throw block_id === "old-3"
            ? Object.assign(new Error("rate limited"), { status: 429, code: "rate_limited" })
            : Object.assign(new Error("bad gateway"), { status: 502 })
        }
        calls.push(`delete:${block_id}`)
        return {}
      })

      const result = updateNotionPage()
      await vi.runAllTimersAsync()
      await expect(result).resolves.toBeUndefined()

      expect(calls.filter((c) => c.startsWith("delete:"))).toEqual(OLD_IDS.map((id) => `delete:${id}`))
      expect(blocksDelete).toHaveBeenCalledTimes(OLD_IDS.length + 3)
    } finally {
      vi.useRealTimers()
    }
  })

  // A stale block left above the new content must not be marked a success:
  // rejecting keeps the story un-sent, and the next re-publish lists old + new
  // and cleans both up.
  it("an old-block delete that keeps failing rejects — after every other old block was still deleted", async () => {
    vi.useFakeTimers()
    try {
      blocksDelete.mockImplementation(async ({ block_id }: { block_id: string }) => {
        if (block_id === "old-3") throw Object.assign(new Error("internal error"), { status: 500 })
        calls.push(`delete:${block_id}`)
        return {}
      })

      const result = updateNotionPage()
      const assertion = expect(result).rejects.toThrow(/1 old block/)
      await vi.runAllTimersAsync()
      await assertion

      expect(calls.filter((c) => c.startsWith("delete:"))).toEqual(
        OLD_IDS.filter((id) => id !== "old-3").map((id) => `delete:${id}`)
      )
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("lost access (401/403) stops deleting at once and rejects — no 130 pointless requests", async () => {
    blocksDelete.mockImplementation(async () => {
      throw Object.assign(new Error("API token is invalid."), { status: 401, code: "unauthorized" })
    })

    await expect(updateNotionPage()).rejects.toThrow("API token is invalid.")

    expect(blocksDelete).toHaveBeenCalledTimes(1)
  })
})

describe("worker updateNotionPage — same shared helper", () => {
  const source = readFileSync(path.resolve(__dirname, "../../lib/story-aggregator/worker.ts"), "utf8")
  const start = source.indexOf("updateNotionPage: async")
  const body = source.slice(start, source.indexOf("extractContent:", start))

  it("delegates to replaceNotionPageContent and deletes nothing itself", () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/replaceNotionPageContent\(/)
    expect(body).not.toMatch(/blocks\.delete/)
  })

  it("pipeline-deps uses the same helper", () => {
    const deps = readFileSync(path.resolve(__dirname, "../../lib/story-aggregator/pipeline-deps.ts"), "utf8")
    expect(deps).toMatch(/replaceNotionPageContent\(/)
  })
})
