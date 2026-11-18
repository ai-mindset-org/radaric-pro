"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { FeedForm } from "@/components/feeds/feed-form"
import type { SourceFormData } from "@/lib/validations/feed"
import { FLAVOR_CONFIGS, isFeedFlavor } from "@/lib/feed-flavor"
import { rejectionCopy } from "@/lib/feed-rejection-copy"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Check, Lock } from "lucide-react"
import Link from "next/link"

const VALID_TYPES = ["RSS", "TELEGRAM", "TWITTER", "YOUTUBE", "EVENT_TRIGGER"] as const

export function NewFeedPage({ includesTwitter = true }: { includesTwitter?: boolean }) {
  return (
    <Suspense>
      <NewFeedContent includesTwitter={includesTwitter} />
    </Suspense>
  )
}

function NewFeedContent({ includesTwitter }: { includesTwitter: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [customPool, setCustomPool] = useState<{ liked: string[]; disliked: string[] }>()
  const [urlError, setUrlError] = useState<string>()
  // Set only when the feed was created WITH a caveat — see onSubmit.
  const [created, setCreated] = useState<{ name: string; warning: string }>()

  // Pre-select type from query param (e.g., /feeds/new?type=TELEGRAM)
  const typeParam = searchParams.get("type")?.toUpperCase()
  const preselectedType = (VALID_TYPES as readonly string[]).includes(typeParam ?? "")
    ? (typeParam as "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "EVENT_TRIGGER")
    : undefined

  // Branded RSS preset from a "Popular sources" card (RAD-268) — only
  // meaningful alongside type=RSS
  const flavorParam = searchParams.get("flavor")?.toUpperCase()
  const preselectedFlavor =
    preselectedType === "RSS" && isFeedFlavor(flavorParam) ? flavorParam : undefined

  useEffect(() => {
    fetch("/api/categories/custom")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCustomPool(data) })
      .catch(() => {})
  }, [])

  async function onSubmit(data: SourceFormData) {
    setUrlError(undefined)
    try {
      const response = await fetch("/api/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      const body = await response.json().catch(() => null)

      if (!response.ok) {
        // Duplicate source — friendly message instead of a generic failure (RAD-268)
        if (response.status === 409) {
          toast.error(body?.error || "This source is already in your feeds")
          return
        }
        // A rejected source is about the URL, so it belongs next to the URL —
        // a toast puts the explanation in the opposite corner from the field.
        // body.url is the canonicalized form when the server sends one.
        const inline = rejectionCopy(body?.code, body?.url ?? data.url)
        if (inline) {
          setUrlError(inline)
          return
        }
        toast.error(body?.error || "Couldn't add this feed — try again.")
        return
      }

      const name = body?.name || data.name
      // A caveat is worth more than the 4s a toast survives, and pushing to
      // /feeds would unmount it — so hold here and let the user read it.
      if (body?.warning) {
        setCreated({ name, warning: body.warning })
        router.refresh()
        return
      }

      toast.success(`Added ${name}`)
      router.push("/feeds")
      router.refresh()
    } catch (error) {
      console.error("Error creating feed:", error)
      toast.error("Couldn't add this feed — try again.")
    }
  }

  const typeLabels: Record<string, string> = {
    RSS: "RSS feed",
    TELEGRAM: "Telegram channel",
    TWITTER: "X / Twitter account",
    YOUTUBE: "YouTube channel",
    EVENT_TRIGGER: "event trigger",
  }

  const subtitle = preselectedFlavor
    ? `Add a ${FLAVOR_CONFIGS[preselectedFlavor].label} source`
    : preselectedType
      ? `Add a new ${typeLabels[preselectedType]}`
      : "Add a new content feed"

  // Explain-first upsell: a non-Pro user who lands on the X form sees WHY it's
  // gated before being sent to billing, rather than a silent block.
  const twitterLocked = preselectedType === "TWITTER" && !includesTwitter

  if (twitterLocked) {
    return (
      <div className="flex flex-col h-full">
        <div>
          <div className="flex h-16 items-center px-4 md:px-6 mt-2 lg:mt-4">
            <Button variant="ghost" size="icon" className="-ml-3 mr-2" asChild>
              <Link href="/feeds">
                <ArrowLeft className="h-[16px] w-[16px]" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl md:text-2xl font-bold">Add feed</h1>
              <p className="text-sm text-muted-foreground hidden sm:block">
                X / Twitter accounts are part of Radaric Pro
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto scrollbar-stable-both">
          <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
            <div className="rounded-xl surface-card p-6 sm:p-8 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-sm bg-muted">
                <Lock className="h-[22px] w-[22px] text-muted-foreground" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">Parse X / Twitter accounts with Pro</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Your plan covers RSS, Telegram, and YouTube. Twitter/X account
                parsing is included in Radaric Pro — upgrade to add X accounts to
                your feeds.
              </p>
              <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
                <Button asChild className="h-11">
                  <Link href="/settings/billing">Upgrade to Pro</Link>
                </Button>
                <Button asChild variant="outline" className="h-11">
                  <Link href="/feeds/new?type=RSS">Add a different feed</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div>
        <div className="flex h-16 items-center px-4 md:px-6 mt-2 lg:mt-4">
          <Button variant="ghost" size="icon" className="-ml-3 mr-2" asChild>
            <Link href="/feeds">
              <ArrowLeft className="h-[16px] w-[16px]" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Add feed</h1>
            <p className="text-sm text-muted-foreground hidden sm:block">
              {subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-auto scrollbar-stable-both">
        <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
          <div className="bg-card rounded-xl p-6">
            {created ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xs bg-primary-subtle">
                    <Check className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold">
                      Added {created.name}
                      {created.warning === "FEED_EMPTY" ? " — no items yet" : ""}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {created.warning === "FEED_EMPTY"
                        ? "This feed hasn't published anything. We'll pull new items in automatically as they appear."
                        : "We couldn't check it just now — the check itself didn't complete, which says nothing about the source. We'll pull anything it has on the next parse."}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => router.push("/feeds")}>Go to feeds</Button>
                  <Button variant="ghost" onClick={() => setCreated(undefined)}>
                    Add another
                  </Button>
                </div>
              </div>
            ) : (
              <FeedForm
                onSubmit={onSubmit}
                onCancel={() => router.push("/feeds")}
                submitLabel="Add feed"
                customCategoryPool={customPool}
                preselectedType={preselectedType}
                preselectedFlavor={preselectedFlavor}
                externalUrlError={urlError}
                onUrlChange={() => setUrlError(undefined)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
