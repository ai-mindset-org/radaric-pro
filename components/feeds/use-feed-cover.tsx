"use client"

import { useState } from "react"
import { classifyCoverShape, type CoverShape } from "@/lib/cover-shape"

/** Channel and profile photos are avatars by construction — no need to measure. */
const AVATAR_TYPES = new Set(["TELEGRAM", "TWITTER"])

/** Near-square: cropped to the circle. Anything else is contained in it. */
const SQUARE_TOLERANCE = 0.15

type Measured = { shape: CoverShape; square: boolean } | "failed"

/**
 * Decides how a feed card shows its `coverUrl` — the band on top, or the small
 * avatar beside the title — from the image's own proportions (see
 * `lib/cover-shape.ts`).
 *
 * Until the image reports its size the card shows neither, and `probe` is a
 * hidden `<img>` that fetches it: a hidden image still loads, and the bytes it
 * pulls are the ones the band or the avatar then reads from cache. A cover
 * that fails to load leaves the card with neither, rather than a broken-image
 * icon or an empty grey band.
 */
export function useFeedCover(type: string, coverUrl: string | null | undefined) {
  // Keyed by URL so an edited cover is measured afresh instead of inheriting
  // the previous image's verdict.
  const [measured, setMeasured] = useState<{ src: string; result: Measured } | null>(null)

  const src = coverUrl || null
  const fixedAvatar = src !== null && AVATAR_TYPES.has(type)
  const result = measured && measured.src === src ? measured.result : null

  function onError() {
    if (src) setMeasured({ src, result: "failed" })
  }

  function measure(img: HTMLImageElement) {
    if (!src) return
    const { naturalWidth: width, naturalHeight: height } = img
    // No intrinsic size (a dimensionless SVG) cannot be placed either way —
    // the same verdict whether it settled before hydration or after.
    if (width === 0 || height === 0) return onError()
    const ratio = width / height
    setMeasured({
      src,
      result: {
        shape: classifyCoverShape(width, height),
        square: Math.abs(ratio - 1) <= SQUARE_TOLERANCE,
      },
    })
  }

  // A server-rendered image can finish (or fail) before hydration attaches
  // `onLoad`/`onError`, and neither event fires again — so on mount read what
  // already happened. A complete image with no width is a failed one.
  function settled(onLoaded?: (img: HTMLImageElement) => void) {
    return (img: HTMLImageElement | null) => {
      if (!img?.complete) return
      if (img.naturalWidth === 0) onError()
      else onLoaded?.(img)
    }
  }

  if (!src || result === "failed") {
    return { src: "", shape: null, square: false, probe: null, onError, ref: undefined }
  }

  if (fixedAvatar) {
    return { src, shape: "avatar" as const, square: true, probe: null, onError, ref: settled() }
  }

  if (!result) {
    return {
      src,
      shape: null,
      square: false,
      probe: (
        // eslint-disable-next-line @next/next/no-img-element -- a measuring probe, never painted
        <img
          key={src}
          ref={settled(measure)}
          src={src}
          alt=""
          aria-hidden="true"
          hidden
          onLoad={(event) => measure(event.currentTarget)}
          onError={onError}
        />
      ),
      onError,
      ref: undefined,
    }
  }

  return { src, shape: result.shape, square: result.square, probe: null, onError, ref: settled() }
}
