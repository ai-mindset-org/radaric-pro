import { describe, it, expect } from "vitest"
import {
  cardGalleryImages,
  detailGalleryMedia,
  isTelegramPlaceholder,
  isVideoEmbedUrl,
  isNonImageAsset,
  sameImageKey,
  isRenderableImageUrl,
  isLandbookFullPageScreenshot,
  isLandbookOgCard,
  mediaKindFromUrl,
  previewImageUrl,
  coverHasVideo,
  CARD_GALLERY_MAX,
  storyGalleryImages,
  storyLeadMaterial,
  coverIsVideoPoster,
  postMediaEntries,
  storyDetailMedia,
} from "@/lib/media-urls"

describe("isVideoEmbedUrl", () => {
  it("matches the hosts the detail page embeds as iframes", () => {
    expect(isVideoEmbedUrl("https://www.youtube.com/watch?v=abc")).toBe(true)
    expect(isVideoEmbedUrl("https://youtu.be/abc")).toBe(true)
    expect(isVideoEmbedUrl("https://player.vimeo.com/video/1")).toBe(true)
  })

  it("does not match an image host or a malformed URL", () => {
    expect(isVideoEmbedUrl("https://cdn.example.com/a.jpg")).toBe(false)
    expect(isVideoEmbedUrl("not a url")).toBe(false)
  })

  it("does not match a lookalike host", () => {
    expect(isVideoEmbedUrl("https://notyoutube.com/watch?v=abc")).toBe(false)
  })
})

describe("isTelegramPlaceholder", () => {
  it("flags unresolved Telegram media", () => {
    expect(isTelegramPlaceholder("tg://photo/123")).toBe(true)
    expect(isTelegramPlaceholder("https://cdn.example.com/a.jpg")).toBe(false)
  })
})

describe("isNonImageAsset", () => {
  it("rejects what the RSS scrape collects but an <img> cannot render", () => {
    // lib/parsers/rss.ts pushes <video> srcs into mediaUrls and its validator
    // allows these extensions through.
    expect(isNonImageAsset("https://cdn.example.com/clip.mp4")).toBe(true)
    expect(isNonImageAsset("https://cdn.example.com/clip.webm?t=1")).toBe(true)
    expect(isNonImageAsset("https://cdn.example.com/logo.svg")).toBe(true)
    expect(isNonImageAsset("https://cdn.example.com/favicon.ico#x")).toBe(true)
  })

  it("keeps real images, including the extensionless CDN kind", () => {
    expect(isNonImageAsset("https://cdn.example.com/a.jpg")).toBe(false)
    expect(isNonImageAsset("https://cdn.example.com/image?id=42")).toBe(false)
    // A denylist must not fire on a substring of the path.
    expect(isNonImageAsset("https://cdn.example.com/mp4/photo.png")).toBe(false)
  })
})

describe("isRenderableImageUrl — an extra frame has to be an image", () => {
  // `mediaUrls` is a media column, but the Parallel (EVENT_TRIGGER) parser
  // writes an event's `source_urls` into it — the article pages the event was
  // found on. Nothing rendered that column for those cards until the cover
  // gallery did, and then 197 of the dev DB's 290 galleries were a card
  // promising a second image that is an HTML page (2026-09-12).
  it("accepts a file that names an image, with or without a query", () => {
    expect(isRenderableImageUrl("https://x/a.jpg")).toBe(true)
    expect(isRenderableImageUrl("https://x/a.JPEG")).toBe(true)
    expect(isRenderableImageUrl("https://x/a.png?w=640")).toBe(true)
    expect(isRenderableImageUrl("https://x/a.webp#frag")).toBe(true)
    expect(isRenderableImageUrl("https://i0.wp.com/x/a.jpg?resize=960%2C540")).toBe(true)
    expect(isRenderableImageUrl("https://x/_next/image?url=https%3A%2F%2Fcdn%2Fa.jpg&w=640")).toBe(true)
  })

  it("accepts the format-in-the-query spelling — X serves its media that way", () => {
    expect(isRenderableImageUrl("https://pbs.twimg.com/media/Gx1?format=jpg&name=large")).toBe(true)
    expect(isRenderableImageUrl("https://cdn.x/i/abc?fm=webp")).toBe(true)
  })

  it("rejects an article page, which is what a Parallel source URL is", () => {
    expect(isRenderableImageUrl("https://www.nytimes.com/2025/12/08/business/ai-slop.html")).toBe(false)
    expect(isRenderableImageUrl("https://mashable.com/article/sora-videos-social-media")).toBe(false)
    expect(isRenderableImageUrl("https://www.pentagram.com/work/london-design-biennale-2025")).toBe(false)
  })

  it("still rejects the assets isNonImageAsset knows about", () => {
    expect(isRenderableImageUrl("https://x/clip.mp4")).toBe(false)
    expect(isRenderableImageUrl("https://x/logo.svg")).toBe(false)
  })
})

describe("sameImageKey — one image, several URLs", () => {
  // Every pair below is one image that the dev DB holds twice: the feed's
  // <img src> and the same file behind the site's own image proxy, so string
  // dedup let both through and a card claimed "1/2" it could not scrub.
  it("unwraps a Jetpack Photon URL to the file it proxies", () => {
    expect(
      sameImageKey(
        "https://i0.wp.com/thedieline.com/wp-content/uploads/2025/11/spice.jpg?resize=960%2C540&quality=70&ssl=1"
      )
    ).toBe(sameImageKey("https://thedieline.com/wp-content/uploads/2025/11/spice.jpg"))
  })

  it("sees through a percent-encoded path", () => {
    expect(
      sameImageKey("https://i0.wp.com/thedieline.com/u/Artboard-4%402x-8.png?resize=960%2C540")
    ).toBe(sameImageKey("https://thedieline.com/u/Artboard-4@2x-8.png"))
  })

  it("ignores transform parameters on a file URL", () => {
    // The Verge ships the same photo twice, cropped differently by the feed.
    expect(
      sameImageKey("https://platform.theverge.com/u/godox1.jpg?quality=90&crop=0%2C10.7%2C100%2C78")
    ).toBe(sameImageKey("https://platform.theverge.com/u/godox1.jpg?quality=90&crop=0,0,100,100"))
  })

  it("unwraps an ?url= style proxy", () => {
    expect(
      sameImageKey("https://example.com/_next/image?url=https%3A%2F%2Fcdn.x%2Fa.jpg&w=640")
    ).toBe(sameImageKey("https://cdn.x/a.jpg"))
  })

  it("treats a bare host difference as the same image", () => {
    expect(sameImageKey("https://www.site.com/a.jpg")).toBe(sameImageKey("https://site.com/a.jpg"))
  })

  // The other half of the same bug, and the more common half: WordPress stores
  // every upload as a family of files — `name-1024x576.png` (a resize), a
  // `name-scaled.png` (its 2560px cap) and the original `name.png`. A feed puts
  // one of them in the cover and another in the body, so a card claimed two
  // frames of one photograph — measured on 40 of the dev DB's 328 galleries
  // after the proxy fix alone (2026-09-12).
  it("collapses a WordPress resize derivative onto the original", () => {
    expect(sameImageKey("https://thedieline.com/u/2026/02/pepsi-1024x576.png")).toBe(
      sameImageKey("https://thedieline.com/u/2026/02/pepsi.png")
    )
  })

  it("collapses WordPress's -scaled cap onto the original", () => {
    expect(sameImageKey("https://thedieline.com/u/2026/01/5-scaled.png")).toBe(
      sameImageKey("https://thedieline.com/u/2026/01/5.png")
    )
  })

  it("matches a resize against a -scaled sibling — neither one is the original", () => {
    expect(sameImageKey("https://thedieline.com/u/2026/01/5-1024x576.png")).toBe(
      sameImageKey("https://thedieline.com/u/2026/01/5-scaled.png")
    )
  })

  it("matches two resizes of one upload", () => {
    expect(sameImageKey("https://x/u/hero-1024x576.jpg")).toBe(
      sameImageKey("https://x/u/hero-2048x1152.jpg")
    )
  })

  it("keeps a dimension that is part of the name, not a derivative suffix", () => {
    // `1600X1200PX-MG-TEA1` is the photographer's own filename (it appears in
    // the dev DB) — the suffix rule only strips a trailing `-WxH`.
    expect(sameImageKey("https://x/u/1600X1200PX-MG-TEA1.jpg")).not.toBe(
      sameImageKey("https://x/u/MG-TEA1.jpg")
    )
  })

  it("does not merge two different uploads that share a size suffix", () => {
    expect(sameImageKey("https://x/u/shot-1-1024x576.jpg")).not.toBe(
      sameImageKey("https://x/u/shot-2-1024x576.jpg")
    )
  })

  it("KEEPS the query when the path is not a file — there it carries the identity", () => {
    // `/image?id=42` and `/image?id=43` are two different images.
    expect(sameImageKey("https://cdn.x/image?id=42")).not.toBe(
      sameImageKey("https://cdn.x/image?id=43")
    )
  })

  it("keeps genuinely different files apart", () => {
    expect(sameImageKey("https://x.ru/p/airport-screen-1-IMG_7689.jpg")).not.toBe(
      sameImageKey("https://x.ru/p/airport-screen-2-IMG_7690.jpg")
    )
  })
})

describe("sameImageKey — Behance serves the same project file at every size", () => {
  // RAD-336: the feed's og:image is `/project_modules/1400/<file>` while the
  // project page's own <img> is `/project_modules/1400_webp/<file>` — the same
  // picture, so a card used to claim two frames and scrubbing changed nothing.
  const BEHANCE = "https://mir-s3-cdn-cf.behance.net"

  it("folds every size segment onto the bare project_modules path", () => {
    const bare = `${BEHANCE}/project_modules/cover.jpg`
    for (const size of [
      "source",
      "disp",
      "fs_webp",
      "1400",
      "1400_webp",
      "1400_opt_1",
      "max_1200_webp",
      "max_3840_webp",
      "hd_webp",
    ]) {
      expect(sameImageKey(`${BEHANCE}/project_modules/${size}/cover.jpg`)).toBe(
        sameImageKey(bare)
      )
    }
  })

  it("keeps two different project files apart", () => {
    expect(sameImageKey(`${BEHANCE}/project_modules/1400/one.jpg`)).not.toBe(
      sameImageKey(`${BEHANCE}/project_modules/1400_webp/two.jpg`)
    )
  })

  it("does not touch the feed's /projects/404/ cover crop — it is a different file", () => {
    expect(sameImageKey(`${BEHANCE}/projects/404/cover.jpg`)).not.toBe(
      sameImageKey(`${BEHANCE}/projects/1400/cover.jpg`)
    )
  })

  it("is scoped to behance.net hosts — another site's project_modules path is not folded", () => {
    expect(sameImageKey("https://example.com/project_modules/1400/x.jpg")).not.toBe(
      sameImageKey("https://example.com/project_modules/source/x.jpg")
    )
    expect(sameImageKey("https://notbehance.net/project_modules/1400/x.jpg")).not.toBe(
      sameImageKey("https://notbehance.net/project_modules/source/x.jpg")
    )
  })
})

describe("cardGalleryImages", () => {
  it("collapses the cover and its proxied twin into one frame", () => {
    // The reported bug: a card showing "1/2" whose two frames are one image,
    // so a hover scrub changed nothing.
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://thedieline.com/wp-content/uploads/2025/11/heinz.jpg",
        mediaUrls: [
          "https://i0.wp.com/thedieline.com/wp-content/uploads/2025/11/heinz.jpg?resize=960%2C540&quality=70&ssl=1",
        ],
      })
    ).toEqual(["https://thedieline.com/wp-content/uploads/2025/11/heinz.jpg"])
  })

  it("keeps the cover's own URL when the duplicate arrives first in mediaUrls", () => {
    const cover = "https://thedieline.com/u/a.jpg"
    expect(
      cardGalleryImages({
        thumbnailUrl: cover,
        mediaUrls: ["https://i0.wp.com/thedieline.com/u/a.jpg?resize=960", "https://thedieline.com/u/b.jpg"],
      })
    ).toEqual([cover, "https://thedieline.com/u/b.jpg"])
  })

  it("drops audio files — a podcast enclosure is not a frame", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["http://audio.x/patrice-baeumel-luce-cut.m4a", "https://x/b.mp3"],
      })
    ).toEqual(["https://x/cover.jpg"])
  })

  it("puts the cover first — it is the frame that sets the band's height", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/b.jpg", "https://x/c.jpg"],
      })
    ).toEqual(["https://x/cover.jpg", "https://x/b.jpg", "https://x/c.jpg"])
  })

  it("drops the cover's duplicate inside mediaUrls", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/cover.jpg", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/cover.jpg", "https://x/b.jpg"])
  })

  it("drops repeats inside mediaUrls too", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: null,
        mediaUrls: ["https://x/b.jpg", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/b.jpg"])
  })

  it("drops video embeds and Telegram placeholders", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://youtu.be/abc", "tg://photo/1", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/cover.jpg", "https://x/b.jpg"])
  })

  it("drops video files and icons, so the count chip cannot advertise them", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/clip.mp4", "https://x/logo.svg", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/cover.jpg", "https://x/b.jpg"])
  })

  it("collapses a cover that is only a WordPress resize of the body image", () => {
    // The shape the bug report described: "2 images" that is one image, no
    // switch on hover.
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://thedieline.com/u/pepsi-1024x576.png",
        mediaUrls: ["https://thedieline.com/u/pepsi-1024x576.png", "https://thedieline.com/u/pepsi.png"],
      })
    ).toEqual(["https://thedieline.com/u/pepsi-1024x576.png"])
  })

  it("collapses a Behance cover's size twin so the card shows one frame per file", () => {
    // RAD-336: og:image is the 1400 crop, the project page's own <img> the
    // 1400_webp file — one picture, one frame.
    const cover = "https://mir-s3-cdn-cf.behance.net/project_modules/1400/one.jpg"
    const two = "https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/two.jpg"
    expect(
      cardGalleryImages({
        thumbnailUrl: cover,
        mediaUrls: ["https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/one.jpg", two],
      })
    ).toEqual([cover, two])
  })

  it("drops a media entry that is an article page, not an image", () => {
    // The Parallel shape: the cover is the OG image, and `mediaUrls` carries
    // the page the event was found on. One image, so no gallery.
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://cdn.site/og/seedance.jpg",
        mediaUrls: ["https://mashable.com/article/sora-videos-social-media"],
      })
    ).toEqual(["https://cdn.site/og/seedance.jpg"])
  })

  it("trusts the cover even when its URL names no file", () => {
    // Habr serves a post's share image from an extensionless path, and it is a
    // PNG. The cover comes from the parser as an image; only the extra frames
    // have to prove themselves.
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://habr.com/share/publication/1081312/201abfd41cc/",
        mediaUrls: ["https://habrastorage.org/getpro/habr/upload_files/e58/a.jpg"],
      })
    ).toEqual([
      "https://habr.com/share/publication/1081312/201abfd41cc/",
      "https://habrastorage.org/getpro/habr/upload_files/e58/a.jpg",
    ])
  })

  it("shows no band at all rather than an article page as the cover", () => {
    // No OG image and `mediaUrls` full of links: there is no image here, and a
    // band whose cover is an HTML page renders as a broken image.
    expect(
      cardGalleryImages({
        thumbnailUrl: null,
        mediaUrls: ["https://mashable.com/article/sora-videos-social-media"],
      })
    ).toEqual([])
  })

  it("caps the frame count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://x/${i}.jpg`)
    expect(cardGalleryImages({ thumbnailUrl: null, mediaUrls: many })).toHaveLength(
      CARD_GALLERY_MAX
    )
    expect(
      cardGalleryImages({ thumbnailUrl: null, mediaUrls: many }, 3)
    ).toEqual(["https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"])
  })

  it("returns a single frame when there is only a cover, and nothing when there is nothing", () => {
    expect(cardGalleryImages({ thumbnailUrl: "https://x/cover.jpg" })).toEqual([
      "https://x/cover.jpg",
    ])
    expect(cardGalleryImages({ thumbnailUrl: null, mediaUrls: [] })).toEqual([])
    expect(cardGalleryImages({})).toEqual([])
    expect(cardGalleryImages({ thumbnailUrl: null, mediaUrls: null })).toEqual([])
  })

  it("keeps a media-only material usable — no cover, media becomes the frames", () => {
    expect(
      cardGalleryImages({ thumbnailUrl: null, mediaUrls: ["https://x/a.jpg", "https://x/b.jpg"] })
    ).toEqual(["https://x/a.jpg", "https://x/b.jpg"])
  })
})

describe("detailGalleryMedia", () => {
  const COVER = "https://brand.example/wp-content/uploads/2026/02/logo.png"

  // Contract change (RAD-359): a video file the RSS parser collected used to
  // paint a broken-image tile and was dropped; now the gallery renders it as a
  // <video>, so it is kept. Unknown pages are still dropped (next test).
  it("keeps a video file the RSS parser collected — the gallery plays it now", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: COVER,
        mediaUrls: [COVER, "https://brand.example/archives/reel.mp4"],
      })
    ).toEqual(["https://brand.example/archives/reel.mp4"])
  })

  it("drops an article page an EVENT_TRIGGER feed wrote into mediaUrls", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: null,
        mediaUrls: ["https://news.example/2026/09/some-article", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/b.jpg"])
  })

  it("drops the cover by image identity, not string equality — the hero already shows it", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: COVER,
        mediaUrls: [
          "https://i0.wp.com/brand.example/wp-content/uploads/2026/02/logo.png?resize=960",
          "https://brand.example/wp-content/uploads/2026/02/logo-1024x576.png",
          "https://x/b.jpg",
        ],
      })
    ).toEqual(["https://x/b.jpg"])
  })

  it("drops the cover's Behance size twin — the hero already shows that picture", () => {
    // RAD-336: the cover arrives as og:image `/1400/<file>`, the grid's copy as
    // `/1400_webp/<file>`; the fold is what keeps the grid from repeating it.
    const cover = "https://mir-s3-cdn-cf.behance.net/project_modules/1400/one.jpg"
    expect(
      detailGalleryMedia({
        thumbnailUrl: cover,
        mediaUrls: [
          "https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/one.jpg",
          "https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/two.jpg",
        ],
      })
    ).toEqual(["https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/two.jpg"])
  })

  it("drops a repeat inside mediaUrls", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: null,
        mediaUrls: ["https://x/b.jpg", "https://x/b.jpg?w=400", "https://x/c.jpg"],
      })
    ).toEqual(["https://x/b.jpg", "https://x/c.jpg"])
  })

  it("keeps video embeds and Telegram placeholders — the page renders an iframe and a placeholder card", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: null,
        mediaUrls: ["https://youtu.be/abc", "tg://photo/1", "https://x/b.jpg"],
      })
    ).toEqual(["https://youtu.be/abc", "tg://photo/1", "https://x/b.jpg"])
  })

  it("does not cap — the page shows every image at once", () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://x/${i}.jpg`)
    expect(detailGalleryMedia({ thumbnailUrl: null, mediaUrls: many })).toHaveLength(30)
  })

  it("keeps a tweet's only video when the parser stored that video as the thumbnail (RAD-400 review)", () => {
    // The Twitter parser stores `thumbnailUrl = mediaUrls[0]`, which for a
    // video tweet is the `.mp4`. Nothing paints that as a cover, so it must not
    // be treated as one — it is the only copy of the video.
    const VIDEO = "https://x/v.mp4"
    expect(detailGalleryMedia({ thumbnailUrl: VIDEO, mediaUrls: [VIDEO] })).toEqual([VIDEO])
  })

  it("returns nothing when there is no media", () => {
    expect(detailGalleryMedia({})).toEqual([])
    expect(detailGalleryMedia({ thumbnailUrl: COVER, mediaUrls: null })).toEqual([])
    expect(detailGalleryMedia({ thumbnailUrl: COVER, mediaUrls: [COVER] })).toEqual([])
  })
})

// RAD-359 — a Telegram post carries more than photos. The surfaces rendered
// every URL as an `<img>`; these pin the classifier the shared renderer uses.
describe("mediaKindFromUrl", () => {
  it("AC-1: classifies a video path extension as video, never image", () => {
    for (const ext of ["mp4", "webm", "mov", "m4v", "mkv", "ogv", "avi"]) {
      const url = `https://cdn.example.com/archives/clip.${ext}`
      expect(mediaKindFromUrl(url), url).toBe("video")
      expect(mediaKindFromUrl(url), url).not.toBe("image")
    }
    // Case-insensitive.
    expect(mediaKindFromUrl("https://cdn.example.com/archives/CLIP.MP4")).toBe("video")
  })

  it("AC-2: classifies an audio path extension as audio", () => {
    for (const ext of ["ogg", "oga", "opus", "mp3", "m4a", "aac", "wav", "flac", "weba"]) {
      const url = `https://cdn.example.com/voice/msg.${ext}`
      expect(mediaKindFromUrl(url), url).toBe("audio")
    }
  })

  it("AC-2: keeps every other kind winning for its own extension", () => {
    expect(mediaKindFromUrl("https://cdn.example.com/clip.mp4")).toBe("video")
    expect(mediaKindFromUrl("https://cdn.example.com/photo.jpg")).toBe("image")
    expect(mediaKindFromUrl("https://cdn.example.com/report.pdf")).toBe("document")
    expect(mediaKindFromUrl("https://youtu.be/abc")).toBe("embed")
    expect(mediaKindFromUrl("tg://photo/1")).toBe("placeholder")
  })

  it("AC-3: classifies a document path extension as document", () => {
    for (const ext of [
      "pdf", "zip", "rar", "7z", "tar", "gz", "doc", "docx",
      "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub", "tgs",
    ]) {
      const url = `https://files.example.com/asset.${ext}`
      expect(mediaKindFromUrl(url), url).toBe("document")
    }
  })

  it("AC-3: classifies the known embed hosts as embed", () => {
    for (const host of ["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "player.vimeo.com"]) {
      const url = `https://${host}/watch?v=abc`
      expect(mediaKindFromUrl(url), url).toBe("embed")
    }
  })

  it("AC-3: classifies any tg:// URL as placeholder", () => {
    expect(mediaKindFromUrl("tg://photo/123")).toBe("placeholder")
    expect(mediaKindFromUrl("tg://too-large/123")).toBe("placeholder")
  })

  it("AC-4: returns image only under the positive image rule", () => {
    expect(mediaKindFromUrl("https://cdn.example.com/a.jpg")).toBe("image")
    expect(mediaKindFromUrl("https://pbs.twimg.com/media/Gx1?format=jpg&name=large")).toBe("image")
    expect(mediaKindFromUrl("https://cdn.x/i/abc?fm=webp")).toBe("image")
  })

  it("AC-4: returns unknown for extensionless, .html and unclaimed URLs", () => {
    // Habr's extensionless share image is a real PNG, but this rule sees no
    // kind; the Parallel event's `source_url` is an article page.
    expect(mediaKindFromUrl("https://habr.com/share/publication/1081312/201abfd41cc/")).toBe("unknown")
    expect(mediaKindFromUrl("https://www.nytimes.com/2025/12/08/business/ai-slop.html")).toBe("unknown")
    expect(mediaKindFromUrl("https://mashable.com/article/sora-videos-social-media")).toBe("unknown")
  })

  it("EC-1: classifies an extension with a query or fragment, and an uppercase extension", () => {
    expect(mediaKindFromUrl("https://cdn.example.com/clip.mp4?dl=1")).toBe("video")
    expect(mediaKindFromUrl("https://cdn.example.com/voice.ogg#t=2")).toBe("audio")
    expect(mediaKindFromUrl("https://cdn.example.com/CLIP.M4V")).toBe("video")
  })

  it("EC-2: youtube watch is embed while an i.ytimg.com thumbnail is image — the host list is exact", () => {
    expect(mediaKindFromUrl("https://www.youtube.com/watch?v=abc")).toBe("embed")
    expect(mediaKindFromUrl("https://i.ytimg.com/vi/abc/hqdefault.jpg")).toBe("image")
    // A lookalike host must not match by substring.
    expect(mediaKindFromUrl("https://notyoutube.com/watch?v=abc")).toBe("unknown")
  })

  it("ERR-1: never throws on empty or malformed input and returns unknown", () => {
    expect(mediaKindFromUrl("")).toBe("unknown")
    expect(mediaKindFromUrl("not a url")).toBe("unknown")
    expect(() => mediaKindFromUrl("not a url")).not.toThrow()
  })
})

describe("previewImageUrl", () => {
  it("AC-5: returns the thumbnail when its kind is image", () => {
    const cover = "https://cdn.example.com/cover.jpg"
    expect(
      previewImageUrl({ thumbnailUrl: cover, mediaUrls: ["https://cdn.example.com/b.jpg"] })
    ).toBe(cover)
  })

  it("AC-5: falls back to the first image in mediaUrls", () => {
    expect(
      previewImageUrl({
        thumbnailUrl: null,
        mediaUrls: ["https://x/clip.mp4", "https://x/b.jpg", "https://x/c.jpg"],
      })
    ).toBe("https://x/b.jpg")
  })

  it("AC-5: returns null for a video-only item and for an mp4 thumbnail", () => {
    expect(previewImageUrl({ thumbnailUrl: null, mediaUrls: ["https://x/clip.mp4"] })).toBeNull()
    expect(previewImageUrl({ thumbnailUrl: "https://x/clip.mp4" })).toBeNull()
    // An mp4 thumbnail is not a poster for an <img>, but an image below it still is.
    expect(
      previewImageUrl({ thumbnailUrl: "https://x/clip.mp4", mediaUrls: ["https://x/b.jpg"] })
    ).toBe("https://x/b.jpg")
  })

  it("ERR-1: never throws and returns null on empty, malformed or nullish entries", () => {
    expect(previewImageUrl({})).toBeNull()
    expect(previewImageUrl({ thumbnailUrl: "", mediaUrls: ["not a url"] })).toBeNull()
    expect(
      previewImageUrl({
        thumbnailUrl: null,
        mediaUrls: [null, undefined, "not a url"] as unknown as string[],
      })
    ).toBeNull()
  })
})

describe("detailGalleryMedia — RAD-359 media kinds", () => {
  const COVER = "https://brand.example/wp-content/uploads/2026/02/logo.png"
  const REEL = "https://brand.example/archives/reel.mp4"

  it("AC-6: keeps a video file now that the page renders a <video>", () => {
    expect(
      detailGalleryMedia({ thumbnailUrl: COVER, mediaUrls: [COVER, REEL] })
    ).toEqual([REEL])
  })

  it("AC-6: keeps audio, embed and placeholder entries", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: null,
        mediaUrls: ["https://x/voice.ogg", "https://youtu.be/abc", "tg://photo/1"],
      })
    ).toEqual(["https://x/voice.ogg", "https://youtu.be/abc", "tg://photo/1"])
  })

  it("AC-6: keeps a document entry and drops an unknown page", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: null,
        mediaUrls: [
          "https://mashable.com/article/sora-videos-social-media",
          "https://x/report.pdf",
          "https://x/b.jpg",
        ],
      })
    ).toEqual(["https://x/report.pdf", "https://x/b.jpg"])
  })

  it("AC-6: still excludes the cover by sameImageKey while keeping a video", () => {
    expect(
      detailGalleryMedia({
        thumbnailUrl: COVER,
        mediaUrls: [
          "https://i0.wp.com/brand.example/wp-content/uploads/2026/02/logo.png?resize=960",
          REEL,
        ],
      })
    ).toEqual([REEL])
  })

  it("AC-6: cardGalleryImages behaviour is unchanged — images only", () => {
    expect(
      cardGalleryImages({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/clip.mp4", "https://x/voice.ogg", "https://x/b.jpg"],
      })
    ).toEqual(["https://x/cover.jpg", "https://x/b.jpg"])
  })
})

// ---------------------------------------------------------------------------
// RAD-359 P4 — coverHasVideo
//
// Decides whether a card's cover band carries the video badge: the material has
// a video, AND the cover is NOT one of its `mediaUrls` frames. A Telegram
// video-only post's cover is the document's poster URL, which never appears in
// `mediaUrls`; a mixed album's cover is its first photo, which does — and a
// photo cover must not be badged (plan decision 5). Identity is `sameImageKey`,
// so a proxied or resized twin of the cover still counts as the cover.
// ---------------------------------------------------------------------------

describe("coverHasVideo", () => {
  it("AC-1: true when the cover is a poster — it never appears in mediaUrls", () => {
    expect(
      coverHasVideo({
        thumbnailUrl: "https://x/poster.jpg",
        mediaUrls: ["https://x/reel.mp4"],
      })
    ).toBe(true)
    expect(coverHasVideo({ thumbnailUrl: null, mediaUrls: ["https://x/reel.mp4"] })).toBe(true)
  })

  it("AC-1: false when the cover is itself a frame of the album (a photo cover)", () => {
    expect(
      coverHasVideo({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/cover.jpg", "https://x/reel.mp4"],
      })
    ).toBe(false)
    // The cover's proxied twin counts as the cover — `sameImageKey`, not string
    // equality.
    expect(
      coverHasVideo({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://i0.wp.com/x/cover.jpg?resize=960", "https://x/reel.mp4"],
      })
    ).toBe(false)
  })

  it("AC-1: false when mediaUrls carries no video", () => {
    expect(
      coverHasVideo({
        thumbnailUrl: "https://x/cover.jpg",
        mediaUrls: ["https://x/second.jpg"],
      })
    ).toBe(false)
  })

  it("ERR-1: never throws on nullish mediaUrls or a malformed thumbnail", () => {
    expect(coverHasVideo({ thumbnailUrl: null, mediaUrls: null })).toBe(false)
    expect(coverHasVideo({})).toBe(false)
    expect(
      coverHasVideo({ thumbnailUrl: "not a url", mediaUrls: ["https://x/reel.mp4"] })
    ).toBe(true)
    expect(() => coverHasVideo({ thumbnailUrl: "not a url", mediaUrls: undefined })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// previewImageUrl — trusted-cover rule (RAD-359 review fix)
// ---------------------------------------------------------------------------

describe("previewImageUrl trusted cover", () => {
  it("keeps an extensionless parser thumbnail and rejects a known non-image cover", () => {
    const extensionless = "https://habr.example/share/publication/1/abc"
    expect(previewImageUrl({ thumbnailUrl: extensionless, mediaUrls: [] })).toBe(extensionless)
    // A `.mp4` cover is not an image: fall through to the first real image.
    expect(
      previewImageUrl({ thumbnailUrl: "https://x/reel.mp4", mediaUrls: ["https://x/a.jpg"] })
    ).toBe("https://x/a.jpg")
  })
})

describe("storyGalleryImages (RAD-399)", () => {
  const img = (name: string) => `https://cdn.example.com/${name}.jpg`

  it("AC-1: merges members' frames round-robin by position, primary first", () => {
    const a = { id: "A", thumbnailUrl: img("a1"), mediaUrls: [img("a1"), img("a2")] }
    const b = { id: "B", thumbnailUrl: img("b1"), mediaUrls: [] }

    const result = storyGalleryImages([a, b])

    expect(result.images).toEqual([img("a1"), img("b1"), img("a2")])
    expect(result.coverOwner).toBe(a)
  })

  it("AC-2: an image already taken from an earlier member (same sameImageKey) appears once", () => {
    const x = "https://thedieline.com/wp-content/uploads/2025/11/spice.jpg"
    // The same file behind Jetpack Photon — a different string, the same image.
    const xProxied =
      "https://i0.wp.com/thedieline.com/wp-content/uploads/2025/11/spice.jpg?resize=960%2C540&quality=70&ssl=1"
    expect(sameImageKey(xProxied)).toBe(sameImageKey(x))

    const a = { id: "A", thumbnailUrl: x, mediaUrls: [] }
    const b = { id: "B", thumbnailUrl: xProxied, mediaUrls: [] }
    const c = { id: "C", thumbnailUrl: x, mediaUrls: [] }

    const result = storyGalleryImages([a, b, c])

    expect(result.images).toEqual([x])
    expect(result.coverOwner).toBe(a)
  })

  it("AC-3: caps at CARD_GALLERY_MAX by default and at an explicit max", () => {
    const member = (prefix: string) => {
      const urls = Array.from({ length: 10 }, (_, i) => img(`${prefix}${i + 1}`))
      return { id: prefix, thumbnailUrl: urls[0], mediaUrls: urls }
    }
    const a = member("a")
    const b = member("b")
    const c = member("c")

    const result = storyGalleryImages([a, b, c])
    expect(CARD_GALLERY_MAX).toBe(16)
    expect(result.images).toHaveLength(16)
    expect(result.images.slice(0, 3)).toEqual([img("a1"), img("b1"), img("c1")])
    expect(result.images.slice(3, 6)).toEqual([img("a2"), img("b2"), img("c2")])

    const capped = storyGalleryImages([a, b, c], 4)
    expect(capped.images).toEqual([img("a1"), img("b1"), img("c1"), img("a2")])
  })

  it("AC-4: coverOwner is the first member that contributes a frame", () => {
    const a = { id: "A", thumbnailUrl: "tg://placeholder/12345", mediaUrls: [] }
    const b = { id: "B", thumbnailUrl: img("b1"), mediaUrls: [] }

    const result = storyGalleryImages([a, b])

    expect(result.images).toEqual([img("b1")])
    expect(result.coverOwner).toBe(b)
  })

  it("EC-1: no member has a renderable image → no frames and no cover owner", () => {
    const a = { id: "A", thumbnailUrl: "tg://placeholder/1", mediaUrls: ["https://x.com/clip.mp4"] }
    const b = { id: "B", thumbnailUrl: null, mediaUrls: [] }

    expect(storyGalleryImages([a, b])).toEqual({ images: [], coverOwner: null })
  })

  it("EC-1 control: a single renderable member is not swallowed", () => {
    const a = { id: "A", thumbnailUrl: null, mediaUrls: [] }
    const b = { id: "B", thumbnailUrl: img("b1"), mediaUrls: [] }

    expect(storyGalleryImages([a, b])).toEqual({ images: [img("b1")], coverOwner: b })
  })
})

// ---------------------------------------------------------------------------
// RAD-400 — the story page shows every member post's media
//
// `storyLeadMaterial` (the card's lead rule), `coverIsVideoPoster` (the post
// page's poster rule, shared), `postMediaEntries` (one post's frames) and
// `storyDetailMedia` (the whole story: members round-robin, then inbox items,
// deduped, split into visual tiles and files).
// ---------------------------------------------------------------------------

describe("storyLeadMaterial (RAD-400)", () => {
  it("AC-1: returns the first material with a non-empty thumbnailUrl", () => {
    const a = { id: "A", thumbnailUrl: null }
    const b = { id: "B", thumbnailUrl: "" }
    const c = { id: "C", thumbnailUrl: "https://cdn.example.com/c.jpg" }
    const d = { id: "D", thumbnailUrl: "https://cdn.example.com/d.jpg" }

    expect(storyLeadMaterial([a, b, c, d])).toBe(c)
  })

  it("AC-1: falls back to materials[0] when none has a thumbnail, and to null for no materials", () => {
    const a = { id: "A", thumbnailUrl: null }
    const b = { id: "B", thumbnailUrl: "" }

    expect(storyLeadMaterial([a, b])).toBe(a)
    expect(storyLeadMaterial([])).toBeNull()
  })
})

describe("coverIsVideoPoster (RAD-400)", () => {
  const POSTER = "https://cdn.example.com/telegram/ch/5_thumb.jpg"
  const CLIP = "https://cdn.example.com/telegram/ch/5.mp4"
  const PHOTO = "https://cdn.example.com/telegram/ch/4.jpg"

  it("AC-4: true for a Telegram post whose cover is a poster that never appears in mediaUrls", () => {
    expect(
      coverIsVideoPoster({ thumbnailUrl: POSTER, mediaUrls: [CLIP], feed: { type: "TELEGRAM" } })
    ).toBe(true)
  })

  it("AC-4: false for a Telegram post with no thumbnail — the first photo is a frame, not a poster", () => {
    expect(
      coverIsVideoPoster({ thumbnailUrl: null, mediaUrls: [PHOTO, CLIP], feed: { type: "TELEGRAM" } })
    ).toBe(false)
  })

  it("AC-4: false for a non-Telegram post with a cover and a video file", () => {
    expect(
      coverIsVideoPoster({
        thumbnailUrl: "https://news.example/og.jpg",
        mediaUrls: ["https://news.example/clip.mp4"],
        feed: { type: "RSS" },
      })
    ).toBe(false)
  })

  it("AC-4: false when the Telegram cover is one of the album's own photos, or is not an image at all", () => {
    expect(
      coverIsVideoPoster({ thumbnailUrl: PHOTO, mediaUrls: [PHOTO, CLIP], feed: { type: "TELEGRAM" } })
    ).toBe(false)
    // A `.mp4` thumbnail is not what previewImageUrl paints, so it is no poster.
    expect(
      coverIsVideoPoster({ thumbnailUrl: CLIP, mediaUrls: [CLIP], feed: { type: "TELEGRAM" } })
    ).toBe(false)
  })
})

describe("postMediaEntries (RAD-400)", () => {
  it("AC-2: the cover comes first as an image even when extensionless, then the rest tagged by kind", () => {
    const COVER = "https://habr.example/share/publication/1/abc"
    const entries = postMediaEntries({
      title: "Post A",
      thumbnailUrl: COVER,
      mediaUrls: [
        "https://x.example/a2.jpg",
        "https://x.example/clip.mp4",
        "https://youtu.be/abc",
        "https://x.example/voice.ogg",
      ],
      feed: { type: "RSS" },
    })

    expect(entries.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: COVER, kind: "image" },
      { url: "https://x.example/a2.jpg", kind: "image" },
      { url: "https://x.example/clip.mp4", kind: "video" },
      { url: "https://youtu.be/abc", kind: "embed" },
      { url: "https://x.example/voice.ogg", kind: "audio" },
    ])
    expect(entries[0].alt).toBe("Post A — image 1")
    expect(entries[1].alt).toBe("Post A — image 2")
    // Not a Telegram poster: the video carries none.
    expect(entries[2].poster).toBeUndefined()
  })

  it("AC-2: drops the cover's proxied/resized twin from the rest", () => {
    const COVER = "https://brand.example/wp-content/uploads/2026/02/logo.png"
    const entries = postMediaEntries({
      title: "Brand post",
      thumbnailUrl: COVER,
      mediaUrls: [
        "https://i0.wp.com/brand.example/wp-content/uploads/2026/02/logo.png?resize=960",
        "https://brand.example/wp-content/uploads/2026/02/logo-1024x576.png",
        "https://brand.example/wp-content/uploads/2026/02/second.jpg",
      ],
      feed: { type: "RSS" },
    })

    expect(entries.map((e) => e.url)).toEqual([
      COVER,
      "https://brand.example/wp-content/uploads/2026/02/second.jpg",
    ])
    expect(entries.map((e) => e.alt)).toEqual(["Brand post — image 1", "Brand post — image 2"])
  })

  it("AC-3: a Telegram poster cover is not an entry — the first video carries it as poster", () => {
    const POSTER = "https://cdn.example.com/telegram/ch/5_thumb.jpg"
    const entries = postMediaEntries({
      title: "Reel post",
      thumbnailUrl: POSTER,
      mediaUrls: [
        "https://cdn.example.com/telegram/ch/5.mp4",
        "https://cdn.example.com/telegram/ch/5b.jpg",
        "https://cdn.example.com/telegram/ch/6.mp4",
      ],
      feed: { type: "TELEGRAM" },
    })

    expect(entries).toEqual([
      { url: "https://cdn.example.com/telegram/ch/5.mp4", kind: "video", poster: POSTER, alt: expect.any(String) },
      { url: "https://cdn.example.com/telegram/ch/5b.jpg", kind: "image", alt: "Reel post — image 1" },
      { url: "https://cdn.example.com/telegram/ch/6.mp4", kind: "video", alt: expect.any(String) },
    ])
    expect(entries[2].poster).toBeUndefined()
  })

  it("AC-4: a Telegram post with no thumbnail keeps its photo tile and a poster-less video", () => {
    const PHOTO = "https://cdn.example.com/telegram/ch/4.jpg"
    const CLIP = "https://cdn.example.com/telegram/ch/4.mp4"
    const entries = postMediaEntries({
      title: "Album",
      thumbnailUrl: null,
      mediaUrls: [PHOTO, CLIP],
      feed: { type: "TELEGRAM" },
    })

    expect(entries.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: PHOTO, kind: "image" },
      { url: CLIP, kind: "video" },
    ])
    expect(entries[0].alt).toBe("Album — image 1")
    expect(entries[1].poster).toBeUndefined()
  })

  it("AC-4: a non-Telegram post keeps its cover as an image and its video without a poster", () => {
    const OG = "https://news.example/og.jpg"
    const CLIP = "https://news.example/clip.mp4"
    const entries = postMediaEntries({
      title: "News",
      thumbnailUrl: OG,
      mediaUrls: [CLIP],
      feed: { type: "RSS" },
    })

    expect(entries.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: OG, kind: "image" },
      { url: CLIP, kind: "video" },
    ])
    expect(entries[1].poster).toBeUndefined()
  })
})

describe("postMediaEntries — a video stored as the thumbnail (RAD-400 review)", () => {
  const VIDEO = "https://x/v.mp4"

  it("a video-only tweet is one video entry, not an empty post", () => {
    const entries = postMediaEntries({
      title: "Tweet",
      thumbnailUrl: VIDEO,
      mediaUrls: [VIDEO],
      feed: { type: "TWITTER" },
    })

    expect(entries.map(({ url, kind, poster }) => ({ url, kind, poster }))).toEqual([
      { url: VIDEO, kind: "video", poster: undefined },
    ])
  })

  it("a tweet with a video and a photo: the photo is the cover, the video follows", () => {
    const PHOTO = "https://x/p.jpg"
    const entries = postMediaEntries({
      title: "Tweet",
      thumbnailUrl: VIDEO,
      mediaUrls: [VIDEO, PHOTO],
      feed: { type: "TWITTER" },
    })

    expect(entries.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: PHOTO, kind: "image" },
      { url: VIDEO, kind: "video" },
    ])
  })
})

describe("storyDetailMedia (RAD-400)", () => {
  const img = (name: string) => `https://cdn.example.com/${name}.jpg`

  function mat(
    title: string,
    thumbnailUrl: string | null,
    mediaUrls: string[],
    type: string = "RSS"
  ) {
    return { id: title, title, thumbnailUrl, mediaUrls, feed: { type } }
  }

  function inbox(thumbnailUrl: string | null, mediaUrls: string[]) {
    return { id: "inbox", thumbnailUrl, mediaUrls }
  }

  it("AC-5: members merge round-robin with the lead (first with a thumbnail) first, then inbox media", () => {
    const a = mat("Post A", null, [img("a1"), img("a2")])
    const b = mat("Post B", img("b1"), [img("b2")])
    const result = storyDetailMedia({
      materials: [a, b],
      inboxItems: [inbox(img("i1"), [img("i1"), img("i2")])],
    })

    expect(result.visual.map(({ url, alt }) => ({ url, alt }))).toEqual([
      { url: img("b1"), alt: "Post B — image 1" },
      { url: img("a1"), alt: "Post A — image 1" },
      { url: img("b2"), alt: "Post B — image 2" },
      { url: img("a2"), alt: "Post A — image 2" },
      { url: img("i1"), alt: "Media 1" },
      { url: img("i2"), alt: "Media 2" },
    ])
    expect(result.files).toEqual([])
  })

  it("AC-5: an inbox URL of unknown kind still renders as an image, as today", () => {
    const PAGE = "https://news.example/2026/10/some-article"
    const result = storyDetailMedia({ materials: [], inboxItems: [inbox(null, [PAGE])] })

    expect(result.visual).toEqual([{ url: PAGE, kind: "image", alt: "Media 1", key: expect.any(String) }])
    expect(result.files).toEqual([])
  })

  it("AC-6: a resized or proxied twin across posts and inbox appears once, earlier spelling wins", () => {
    const X = "https://thedieline.com/wp-content/uploads/2025/11/spice.jpg"
    const X_PROXIED =
      "https://i0.wp.com/thedieline.com/wp-content/uploads/2025/11/spice.jpg?resize=960%2C540&quality=70&ssl=1"
    const X_SIZED = "https://thedieline.com/wp-content/uploads/2025/11/spice-1024x576.jpg"

    const result = storyDetailMedia({
      materials: [mat("Post A", X, []), mat("Post B", X_PROXIED, [img("b2")])],
      inboxItems: [inbox(X_SIZED, [])],
    })

    expect(result.visual.map((e) => e.url)).toEqual([X, img("b2")])
  })

  it("AC-6: a poster survives dedupe — it moves onto the kept, poster-less video", () => {
    const COVER = img("cover")
    const CLIP = "https://cdn.example.com/media/clip.mp4"
    const CLIP_SIGNED = "https://cdn.example.com/media/clip.mp4?token=abc"
    const POSTER = "https://cdn.example.com/media/clip_thumb.jpg"

    // A (RSS) is the lead: cover image, then its clip with no poster.
    // B (TELEGRAM) has the same clip with a poster, reached one round later.
    const a = mat("Post A", COVER, [CLIP])
    const b = mat("Post B", POSTER, [img("b2"), CLIP_SIGNED], "TELEGRAM")
    const result = storyDetailMedia({ materials: [a, b], inboxItems: [] })

    expect(result.visual).toEqual([
      { url: COVER, kind: "image", alt: "Post A — image 1", key: expect.any(String) },
      { url: img("b2"), kind: "image", alt: "Post B — image 1", key: expect.any(String) },
      { url: CLIP, kind: "video", poster: POSTER, alt: expect.any(String), key: expect.any(String) },
    ])
  })

  // Review change: a placeholder is identified by its exact URL WITHIN its
  // post — `tg://photo/1` in two posts is two photos (see the scoping test
  // below), so B's copy is no longer collapsed into A's. Embeds stay global.
  it("AC-6: embeds are identified by their exact URL; placeholders by their exact URL within a post", () => {
    const V1 = "https://www.youtube.com/watch?v=aaa"
    const V2 = "https://www.youtube.com/watch?v=bbb"
    const result = storyDetailMedia({
      materials: [
        mat("Post A", null, [V1, "tg://photo/1"]),
        mat("Post B", null, [V2, V1, "tg://photo/1", "tg://photo/2"]),
      ],
      inboxItems: [],
    })

    expect(result.visual.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: V1, kind: "embed" },
      { url: V2, kind: "embed" },
      { url: "tg://photo/1", kind: "placeholder" },
      { url: "tg://photo/1", kind: "placeholder" },
      { url: "tg://photo/2", kind: "placeholder" },
    ])
  })

  it("review: a generic Telegram placeholder is scoped to its post — message ids are per channel", () => {
    // `tg://photo/<messageId>` names no channel: message 12 in one channel and
    // message 12 in another are two different photos.
    const result = storyDetailMedia({
      materials: [
        mat("Channel A", null, ["tg://photo/12"], "TELEGRAM"),
        mat("Channel B", null, ["tg://photo/12"], "TELEGRAM"),
      ],
      inboxItems: [inbox(null, ["tg://photo/12"]), inbox(null, ["tg://photo/12"])],
    })

    expect(result.visual.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: "tg://photo/12", kind: "placeholder" },
      { url: "tg://photo/12", kind: "placeholder" },
      { url: "tg://photo/12", kind: "placeholder" },
      { url: "tg://photo/12", kind: "placeholder" },
    ])
    // Each entry carries the identity it was deduped by, unique across the list.
    const keys = result.visual.map((e) => e.key)
    expect(new Set(keys).size).toBe(4)
  })

  it("review: a placeholder repeated inside ONE post still collapses", () => {
    const result = storyDetailMedia({
      materials: [mat("Channel A", null, ["tg://photo/12", "tg://photo/12"], "TELEGRAM")],
      inboxItems: [],
    })
    expect(result.visual.map((e) => e.url)).toEqual(["tg://photo/12"])
  })

  it("review: alts are numbered after dedupe — a post whose first image was a twin starts at image 1", () => {
    const X = "https://thedieline.com/wp-content/uploads/2025/11/spice.jpg"
    const X_PROXIED = "https://i0.wp.com/thedieline.com/wp-content/uploads/2025/11/spice.jpg?resize=960"
    const result = storyDetailMedia({
      materials: [
        mat("Source A", X, []),
        mat("Source B", X_PROXIED, [img("b2"), "https://x.example/clip.mp4", "https://youtu.be/abc"]),
      ],
      inboxItems: [inbox(X, [img("i2")])],
    })

    expect(result.visual.map(({ url, alt }) => ({ url, alt }))).toEqual([
      { url: X, alt: "Source A — image 1" },
      { url: img("b2"), alt: "Source B — image 1" },
      { url: "https://x.example/clip.mp4", alt: "Source B — video" },
      { url: "https://youtu.be/abc", alt: "Source B — video" },
      // The inbox thumbnail is A's cover again: "Media k" counts kept inbox entries.
      { url: img("i2"), alt: "Media 1" },
    ])
  })

  it("AC-7: visual (image, video, embed, tg placeholder) and files (audio, document, tg://too-large) never interleave", () => {
    const result = storyDetailMedia({
      materials: [
        mat("Post A", null, [
          img("a"),
          "https://x.example/voice.ogg",
          "https://x.example/report.pdf",
          "https://x.example/clip.mp4",
          "tg://too-large/eaccrussia/5",
          "tg://photo/9",
          "https://youtu.be/xyz",
        ]),
      ],
      inboxItems: [],
    })

    expect(result.visual.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: img("a"), kind: "image" },
      { url: "https://x.example/clip.mp4", kind: "video" },
      { url: "tg://photo/9", kind: "placeholder" },
      { url: "https://youtu.be/xyz", kind: "embed" },
    ])
    expect(result.files.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: "https://x.example/voice.ogg", kind: "audio" },
      { url: "https://x.example/report.pdf", kind: "document" },
      { url: "tg://too-large/eaccrussia/5", kind: "placeholder" },
    ])
  })

  it("EC-1: no member media and no inbox media → empty visual and files", () => {
    expect(
      storyDetailMedia({
        materials: [mat("Post A", null, []), mat("Post B", null, [])],
        inboxItems: [inbox(null, [])],
      })
    ).toEqual({ visual: [], files: [] })
    expect(storyDetailMedia({ materials: [], inboxItems: [] })).toEqual({ visual: [], files: [] })
  })
})

/**
 * RAD-432 — Land Book publishes a full-page screenshot of the featured site in
 * its RSS description and a branded Landbook social card as the article's
 * og:image. The card alternated between the two depending on whether the page
 * fetch succeeded; both surfaces must show the site.
 */
describe("Land Book covers (RAD-432)", () => {
  // The shapes taken off the live feed and page, 2026-11-05.
  const SHOT =
    "https://cdn.land-book.com/image/0x0:2880x4320/600x0/filters:format(jpeg)/website/102061/512a0a20d630be65-screenshot-upload?signature=137a0303e549f36fddc0df712db82e7234d25688fdc0be7a75b949d9224b4d43"
  const OG_CARD =
    "https://cdn.land-book.com/website/102061/102061-relume-ai-website-builder-for-marketing-websites-1793868978-og-image.webp"
  const OG_MEDIA =
    "https://storage.land-book.com/website/102061/og-media/352d90583360bbc1-og-media.webp"
  // The same shot as the article page re-serves it: same crop, other widths.
  const ART_2880 =
    "https://cdn.land-book.com/image/0x0:2880x2870/2880x0/filters:format(webp)/website/102061/512a0a20d630be65-screenshot-upload?signature=47da2ec4b231a7a69e72793e011f2923c5d4ade02e986455e6a6e17b8427bf41"
  const ART_600 =
    "https://cdn.land-book.com/image/0x0:2880x2870/600x0/filters:format(webp)/website/102061/512a0a20d630be65-screenshot-upload?signature=b8e96695f6777abdb87dea9b86e8446784bf53358174c4b6cefb8c7bf13afffb"
  // A section crop carries its own offset, so it is not the whole page.
  const SECTION =
    "https://cdn.land-book.com/image/0x16210:2880x17340/600x0/filters:format(webp)/website/102061/512a0a20d630be65-screenshot-upload?signature=ad6a6e7135b8d9cc98dd8e0547238229a27a8a7857af2f64932dc17fe45d6090"

  it("recognizes the full-page shot only — not the og card and not a section crop", () => {
    expect(isLandbookFullPageScreenshot(SHOT)).toBe(true)
    expect(isLandbookFullPageScreenshot(OG_CARD)).toBe(false)
    expect(isLandbookFullPageScreenshot(OG_MEDIA)).toBe(false)
    expect(isLandbookFullPageScreenshot(SECTION)).toBe(false)
    expect(isLandbookFullPageScreenshot("https://notland-book.com/image/0x0:1x1/x-screenshot")).toBe(false)
    expect(isLandbookFullPageScreenshot("not a url")).toBe(false)
  })

  it("recognizes the branded social card on both Landbook hosts", () => {
    expect(isLandbookOgCard(OG_CARD)).toBe(true)
    expect(isLandbookOgCard(OG_MEDIA)).toBe(true)
    expect(isLandbookOgCard(SHOT)).toBe(false)
    expect(isLandbookOgCard("https://example.com/og-image.webp")).toBe(false)
  })

  it("reads the extensionless screenshot as an image anyway", () => {
    // The format sits in a path segment, so the plain rule sees no extension.
    expect(isRenderableImageUrl(SHOT)).toBe(true)
    expect(mediaKindFromUrl(SHOT)).toBe("image")
  })

  it("makes the screenshot the card cover and drops the branded card from the scrub", () => {
    expect(cardGalleryImages({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD, SHOT] })).toEqual([SHOT])
  })

  it("keeps the screenshot first even when the card had no branded cover", () => {
    expect(cardGalleryImages({ thumbnailUrl: null, mediaUrls: [SHOT] })).toEqual([SHOT])
  })

  it("keeps one frame when new rows store the shot as the thumbnail too", () => {
    expect(cardGalleryImages({ thumbnailUrl: SHOT, mediaUrls: [SHOT, OG_CARD] })).toEqual([SHOT])
  })

  it("collapses the article page's other widths of the same shot into no extra frames", () => {
    // RAD-432 review: the page re-serves the asset at `/…/2880x0/` and
    // `/…/600x0/` with the same crop but a different path, so `sameImageKey`
    // cannot fold them — a card would scrub between copies of one picture.
    expect(
      cardGalleryImages({
        thumbnailUrl: OG_CARD,
        mediaUrls: [OG_CARD, SHOT, ART_2880, ART_600, OG_MEDIA],
      })
    ).toEqual([SHOT])
    expect(
      detailGalleryMedia({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD, SHOT, ART_2880, ART_600, OG_MEDIA] })
    ).toEqual([SHOT])
    expect(
      postMediaEntries({
        title: "Doko",
        thumbnailUrl: OG_CARD,
        mediaUrls: [OG_CARD, SHOT, ART_2880, ART_600, OG_MEDIA],
      }).map(({ url, kind, alt }) => ({ url, kind, alt }))
    ).toEqual([{ url: SHOT, kind: "image", alt: "Doko — image 1" }])
  })

  it("still leads a capped gallery, and a section crop stays unrenderable", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://x.example/${i}.jpg`)
    const frames = cardGalleryImages({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD, SHOT, ...many] })
    expect(frames).toHaveLength(CARD_GALLERY_MAX)
    expect(frames[0]).toBe(SHOT)
    expect(isRenderableImageUrl(SECTION)).toBe(false)
  })

  it("does not override another feed's editorial cover that merely quotes the shot", () => {
    const editorial = "https://other.example/wp/editorial-cover.jpg"
    expect(previewImageUrl({ thumbnailUrl: editorial, mediaUrls: [editorial, SHOT] })).toBe(editorial)
    expect(cardGalleryImages({ thumbnailUrl: editorial, mediaUrls: [editorial, SHOT] })).toEqual([
      editorial,
      SHOT,
    ])
  })

  it("makes the screenshot the hero over the stored branded thumbnail", () => {
    expect(previewImageUrl({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD, SHOT] })).toBe(SHOT)
  })

  it("leaves a Landbook page with no screenshot exactly as it was", () => {
    expect(cardGalleryImages({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD] })).toEqual([OG_CARD])
    expect(previewImageUrl({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD] })).toBe(OG_CARD)
  })

  it("does not put the branded card in the detail grid under a screenshot hero", () => {
    expect(detailGalleryMedia({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD, SHOT] })).toEqual([SHOT])
    expect(detailGalleryMedia({ thumbnailUrl: OG_CARD, mediaUrls: [OG_CARD] })).toEqual([])
  })
})
