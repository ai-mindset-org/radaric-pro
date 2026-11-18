/**
 * RAD-393 — folder scope in the single `/api/posts` URL builder.
 *
 * `sourceId` and `folderId` are mutually exclusive scopes; the builder is the
 * one place a request is assembled (RAD-318), so these properties hold for
 * every caller.
 */

import { describe, it, expect } from "vitest"
import { emptyQuery, buildPostsUrl, sameQuery } from "@/lib/materials/posts-query"

function paramsOf(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams
}

describe("PostsQuery folder scope (RAD-393)", () => {
  it("defaults folderId to null", () => {
    expect(emptyQuery().folderId).toBeNull()
  })

  it("carries folderId and never sourceId", () => {
    const params = paramsOf(buildPostsUrl(emptyQuery({ folderId: "folder-1" }), 0))
    expect(params.get("folderId")).toBe("folder-1")
    expect(params.has("sourceId")).toBe(false)
  })

  it("keeps sourceId winning if both are somehow set", () => {
    const params = paramsOf(
      buildPostsUrl(emptyQuery({ sourceId: "feed-1", folderId: "folder-1" }), 0)
    )
    expect(params.get("sourceId")).toBe("feed-1")
    expect(params.has("folderId")).toBe(false)
  })

  it("treats the folder as part of the request identity", () => {
    const base = emptyQuery({ filter: "FILTERED" })
    expect(sameQuery(base, emptyQuery({ filter: "FILTERED", folderId: "folder-1" }))).toBe(false)
    expect(
      sameQuery(
        emptyQuery({ filter: "FILTERED", folderId: "folder-1" }),
        emptyQuery({ filter: "FILTERED", folderId: "folder-1" })
      )
    ).toBe(true)
  })
})
