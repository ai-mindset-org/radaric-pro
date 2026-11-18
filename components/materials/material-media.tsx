"use client"

import { mediaKindFromUrl } from "@/lib/media-urls"

type MaterialMediaProps = {
  url: string
  poster?: string | null
  alt?: string
  title?: string
}

function fileExtension(url: string): string {
  const match = /\.([a-z0-9]{2,5})(?=[?#]|$)/i.exec(url)
  return match ? match[1].toLowerCase() : ""
}

export function MaterialMedia({ url, poster, alt, title }: MaterialMediaProps) {
  const kind = mediaKindFromUrl(url)

  if (kind === "video") {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
        <video
          src={url}
          poster={poster ?? undefined}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
      </div>
    )
  }

  if (kind === "audio") {
    const ext = fileExtension(url)
    const label = ext === "ogg" || ext === "oga" || ext === "opus" ? "Voice message" : "Audio"
    return (
      <div className="w-full rounded-xl bg-muted ring-1 ring-inset ring-hairline p-2.5">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
        <audio src={url} controls className="w-full min-h-[44px]" />
      </div>
    )
  }

  if (kind === "document") {
    const ext = fileExtension(url)
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm font-medium text-foreground ring-1 ring-inset ring-hairline transition-colors hover:bg-accent/60"
      >
        {ext ? `Open ${ext.toUpperCase()}` : "Open document"}
      </a>
    )
  }

  if (kind === "image") {
    return (
      <img
        src={url}
        alt={alt ?? ""}
        loading="lazy"
        className="w-full h-auto rounded-lg object-contain"
      />
    )
  }

  if (kind === "embed") {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
        <iframe
          src={url}
          title={title ?? alt ?? "Embedded video"}
          className="h-full w-full"
          loading="lazy"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
      </div>
    )
  }

  if (kind === "placeholder") {
    if (url.startsWith("tg://too-large")) {
      return (
        <div className="flex min-h-[44px] flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground ring-1 ring-inset ring-hairline">
          <span>Media not mirrored</span>
          <a
            href={`https://t.me/${url.replace(/^tg:\/\/too-large\//, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium link"
          >
            Open in Telegram
          </a>
        </div>
      )
    }
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted ring-1 ring-inset ring-hairline">
        <p className="text-sm text-muted-foreground">Telegram media</p>
      </div>
    )
  }

  return null
}
