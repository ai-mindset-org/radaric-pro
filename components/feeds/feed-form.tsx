"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { sourceSchema, type SourceFormData } from "@/lib/validations/feed"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useEffect, useRef, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { ContentCategoryPicker } from "./content-category-picker"
import { cn } from "@/lib/utils"
import { FLAVOR_CONFIGS, resolveFlavorInput, type FeedFlavor } from "@/lib/feed-flavor"
import {
  extractTwitterUsername,
  normalizeFeedUrlInput,
  normalizeTelegramInput,
  normalizeYouTubeInput,
} from "@/lib/validations/feed"

const LAST_SOURCE_TYPE_KEY = "radaric-last-source-type"

interface FeedFormProps {
  initialData?: Partial<SourceFormData>
  onSubmit: (data: SourceFormData) => Promise<void>
  onCancel?: () => void
  submitLabel?: string
  customCategoryPool?: { liked: string[]; disliked: string[] }
  preselectedType?: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
  /** Branded RSS preset picked on a "Popular sources" card (RAD-268) */
  preselectedFlavor?: FeedFlavor
  /**
   * Server-side rejection of the URL (a bot instead of a channel, a page with
   * no feed). Rendered next to the field it's about — a toast would put the
   * explanation in the opposite corner from the input that's wrong.
   */
  externalUrlError?: string
  /** Clear externalUrlError — RHF errors revalidate on change, so this must too. */
  onUrlChange?: () => void
}

export function FeedForm({
  initialData,
  onSubmit,
  onCancel,
  submitLabel = "Save",
  customCategoryPool,
  preselectedType,
  preselectedFlavor,
  externalUrlError,
  onUrlChange,
}: FeedFormProps) {
  const [brandInput, setBrandInput] = useState("")
  // Once the user hand-edits the feed URL it becomes theirs — stop auto-syncing
  // from the brand resolver (escape hatch for e.g. custom-domain Substacks)
  const [urlManuallyEdited, setUrlManuallyEdited] = useState(false)
  const lastAutoNameRef = useRef("")
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setValue,
    watch,
  } = useForm<SourceFormData>({
    // zodResolver's inferred input/output generics don't line up with RHF here;
    // the cast is the standard escape hatch (pre-existing).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(sourceSchema) as any,
    defaultValues: {
      url: initialData?.url || "",
      type: initialData?.type || preselectedType || (() => {
        if (typeof window === "undefined") return "RSS"
        const stored = localStorage.getItem(LAST_SOURCE_TYPE_KEY)
        // Migrate legacy INTEREST → EVENT_TRIGGER
        if (stored === "INTEREST") {
          localStorage.setItem(LAST_SOURCE_TYPE_KEY, "EVENT_TRIGGER")
          return "EVENT_TRIGGER"
        }
        return (stored as "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "EVENT_TRIGGER") || "RSS"
      })(),
      name: initialData?.name || "",
      coverUrl: initialData?.coverUrl || "",
      customPrompt: initialData?.customPrompt || "",
      isActive: initialData?.isActive ?? true,
      twitterType: initialData?.twitterType || "ACCOUNT",
      twitterValue: initialData?.twitterValue || "",
      interestQuery: initialData?.interestQuery || "",
      interestCadence: initialData?.interestCadence || undefined,
      includeRetweets: initialData?.includeRetweets ?? false,
      likedCategories: initialData?.likedCategories || [],
      dislikedCategories: initialData?.dislikedCategories || [],
    },
  })

  const type = watch("type")

  useEffect(() => {
    if (type && !initialData?.type) {
      localStorage.setItem(LAST_SOURCE_TYPE_KEY, type)
    }
  }, [type, initialData?.type])

  // Brand preset is RSS-only — switching the type Select away restores the
  // plain URL input
  const brandActive = type === "RSS" && !!preselectedFlavor
  const brandConfig = preselectedFlavor ? FLAVOR_CONFIGS[preselectedFlavor] : undefined
  const brandResolution =
    brandActive && preselectedFlavor ? resolveFlavorInput(preselectedFlavor, brandInput) : null
  // Suppressed once the user hand-fills the URL field — the form is valid
  // then, and a lingering red message would contradict it
  const brandError =
    brandActive &&
    brandInput.trim() !== "" &&
    !brandResolution &&
    !(urlManuallyEdited && !!watch("url"))

  // Optional-input presets (Product Hunt) resolve to their default feed on mount
  useEffect(() => {
    if (!brandActive || !preselectedFlavor || !brandConfig?.inputOptional) return
    if (watch("url")) return
    const resolved = resolveFlavorInput(preselectedFlavor, "")
    if (resolved) {
      setValue("url", resolved.url)
      if (resolved.name && !watch("name")) {
        setValue("name", resolved.name)
        lastAutoNameRef.current = resolved.name
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Canonicalize pasted input in any format (@handle, bare handle, URL with or
  // without protocol) — run on field blur and again right before validation so
  // paste-then-Enter also works
  function normalizePastedInputs() {
    const currentType = watch("type")
    const url = watch("url")
    if (url) {
      const normalized =
        currentType === "TELEGRAM"
          ? normalizeTelegramInput(url)
          : currentType === "YOUTUBE"
            ? normalizeYouTubeInput(url)
            : currentType === "RSS"
              ? normalizeFeedUrlInput(url)
              : null
      if (normalized && normalized !== url) setValue("url", normalized)
    }
    const twitterValue = watch("twitterValue")
    if (currentType === "TWITTER" && twitterValue) {
      const username = extractTwitterUsername(twitterValue)
      if (username && username !== twitterValue) setValue("twitterValue", username)
    }
  }

  function handleBrandInputChange(value: string) {
    setBrandInput(value)
    // The brand input rebuilds `url`, so it invalidates a server rejection just
    // as much as typing in the URL field does. Without this the old error stays
    // pinned under a URL it no longer describes.
    onUrlChange?.()
    if (!preselectedFlavor) return
    const resolved = resolveFlavorInput(preselectedFlavor, value)
    if (urlManuallyEdited) return
    setValue("url", resolved?.url ?? "")
    if (resolved?.name) {
      const currentName = watch("name")
      if (!currentName || currentName === lastAutoNameRef.current) {
        setValue("name", resolved.name)
        lastAutoNameRef.current = resolved.name
      }
    }
  }

  return (
    <form
      onSubmit={(e) => {
        normalizePastedInputs()
        handleSubmit(onSubmit)(e)
      }}
      className="space-y-6"
    >
      {/* Type */}
      <div className="space-y-2">
        <Label htmlFor="type">
          Feed type <span className="text-destructive">*</span>
        </Label>
        <Select
          value={type}
          onValueChange={(value) => {
            // A rejection is about a URL as a source of THIS type; switching type
            // makes it stale ("that's a bot" under an RSS field).
            onUrlChange?.()
            setValue("type", value as "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "EVENT_TRIGGER")
          }}
          disabled={isSubmitting}
        >
          <SelectTrigger id="type">
            <SelectValue placeholder="Select type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="RSS">RSS Feed</SelectItem>
            <SelectItem value="TELEGRAM">Telegram Channel</SelectItem>
            <SelectItem value="TWITTER">Twitter / X</SelectItem>
            <SelectItem value="YOUTUBE">YouTube Channel</SelectItem>
            <SelectItem value="EVENT_TRIGGER">Event Trigger</SelectItem>
          </SelectContent>
        </Select>
        {errors.type && (
          <p className="text-sm text-destructive">{errors.type.message}</p>
        )}
        {type === "TELEGRAM" && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Channel link or username — @channel, t.me/channel, or the full URL all work
          </p>
        )}
        {type === "YOUTUBE" && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Channel handle, URL, or a video link — @handle, /channel/UC…, or any
            video URL all work. AI reads the video transcripts for you.
          </p>
        )}
      </div>

      {/* Branded RSS preset input (RAD-268) — replaces the plain URL field */}
      {brandActive && brandConfig && (
        <div className="space-y-2">
          <Label htmlFor="brandInput">
            {brandConfig.label}
            {!brandConfig.inputOptional && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            id="brandInput"
            placeholder={brandConfig.placeholder}
            value={brandInput}
            onChange={(e) => handleBrandInputChange(e.target.value)}
            disabled={isSubmitting}
          />
          {brandError ? (
            <p className="text-sm text-destructive animate-shake">
              Couldn&apos;t build a {brandConfig.label} feed from this input.{" "}
              {brandConfig.helpText} Or paste a feed URL directly below.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {brandConfig.helpText}
            </p>
          )}

          {/* Resolved feed URL — transparency line + editable escape hatch */}
          <div className="space-y-1 pt-1">
            <Label htmlFor="url" className="text-xs font-normal text-muted-foreground">
              Feed URL
            </Label>
            <div className="relative">
              {!urlManuallyEdited && !!watch("url") && (
                <Check
                  className="pointer-events-none absolute left-3 top-1/2 z-10 h-[14px] w-[14px] -translate-y-1/2 text-primary"
                  aria-hidden="true"
                />
              )}
              <Input
                id="url"
                type="text"
                inputMode="url"
                placeholder="Resolved automatically — or paste a feed URL"
                className={cn(
                  "font-mono text-xs",
                  !urlManuallyEdited && !!watch("url") && "pl-9"
                )}
                {...register("url", {
                  onChange: () => {
                    setUrlManuallyEdited(true)
                    onUrlChange?.()
                  },
                  onBlur: () => normalizePastedInputs(),
                })}
                disabled={isSubmitting}
              />
            </div>
            {/* The brand branch owns the URL field when a preset is active, so it
                needs its own externalUrlError slot — otherwise a server rejection
                is set into state and rendered nowhere, and Add feed looks dead. */}
            {errors.url ? (
              <p className="text-sm text-destructive">{errors.url.message}</p>
            ) : externalUrlError ? (
              <p className="text-sm text-destructive animate-shake">{externalUrlError}</p>
            ) : null}
          </div>
        </div>
      )}

      {/* URL - only for RSS and TELEGRAM. type=text (not url) so pastes like
          "@channel" reach zod/normalization instead of the native URL bubble */}
      {type !== "TWITTER" && type !== "EVENT_TRIGGER" && !brandActive && (
        <div className="space-y-2">
          <Label htmlFor="url">
            {type === "TELEGRAM" || type === "YOUTUBE" ? "Channel" : "Feed URL"}{" "}
            <span className="text-destructive">*</span>
          </Label>
          <Input
            id="url"
            type="text"
            inputMode="url"
            placeholder={
              type === "TELEGRAM"
                ? "@channelname or t.me/channelname"
                : type === "YOUTUBE"
                  ? "@mkbhd or youtube.com/@mkbhd"
                  : "https://example.com/feed.xml"
            }
            {...register("url", {
              onBlur: () => normalizePastedInputs(),
              onChange: () => onUrlChange?.(),
            })}
            disabled={isSubmitting}
          />
          {errors.url ? (
            <p className="text-sm text-destructive">{errors.url.message}</p>
          ) : externalUrlError ? (
            <p className="text-sm text-destructive animate-shake">{externalUrlError}</p>
          ) : null}
        </div>
      )}

      {/* Twitter-specific fields */}
      {type === "TWITTER" && (
        <div className="space-y-2">
          <Label htmlFor="twitterValue">
            Account username <span className="text-destructive">*</span>
          </Label>
          <Input
            id="twitterValue"
            placeholder="@elonmusk"
            {...register("twitterValue", { onBlur: () => normalizePastedInputs() })}
            disabled={isSubmitting}
          />
          {errors.twitterValue && (
            <p className="text-sm text-destructive">{errors.twitterValue.message}</p>
          )}
          <p className="text-xs text-muted-foreground leading-relaxed">
            Username or profile link — @user, x.com/user, or the full URL all work.
            Keyword search is not supported.
          </p>
          <div className="flex items-center justify-between pt-2">
            <div className="space-y-0.5">
              <Label htmlFor="includeRetweets" className="text-sm font-normal">Include retweets</Label>
              <p className="text-xs text-muted-foreground">Parse retweets from this account</p>
            </div>
            <Switch
              id="includeRetweets"
              checked={watch("includeRetweets") ?? false}
              onCheckedChange={(checked) => setValue("includeRetweets", checked)}
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      {/* Interest-specific fields */}
      {type === "EVENT_TRIGGER" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="interestQuery">
              What to track? <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="interestQuery"
              placeholder="Describe what you want to track on the web. E.g. 'News about AI agent development and their use in software engineering'"
              rows={3}
              {...register("interestQuery")}
              disabled={isSubmitting}
            />
            {errors.interestQuery && (
              <p className="text-sm text-destructive">{errors.interestQuery.message}</p>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed">
              AI will search for relevant information based on this query
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="interestCadence">
              Check frequency <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watch("interestCadence")}
              onValueChange={(value) => setValue("interestCadence", value as "HOURLY" | "DAILY" | "WEEKLY")}
              disabled={isSubmitting}
            >
              <SelectTrigger id="interestCadence">
                <SelectValue placeholder="Select frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HOURLY">Every hour (~$0.07/day)</SelectItem>
                <SelectItem value="DAILY">Once a day (~$0.003/day)</SelectItem>
                <SelectItem value="WEEKLY">Once a week (~$0.0004/day)</SelectItem>
              </SelectContent>
            </Select>
            {errors.interestCadence && (
              <p className="text-sm text-destructive">{errors.interestCadence.message}</p>
            )}
          </div>
        </>
      )}

      {/* Separator between connection and metadata sections */}
      <div className="h-px bg-border" />

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="name"
          placeholder="Feed name"
          {...register("name")}
          disabled={isSubmitting}
        />
        {errors.name && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Cover URL */}
      <div className="space-y-2">
        <Label htmlFor="coverUrl">Cover URL (optional)</Label>
        <Input
          id="coverUrl"
          type="url"
          placeholder="https://example.com/image.jpg"
          {...register("coverUrl")}
          disabled={isSubmitting}
        />
        {errors.coverUrl && (
          <p className="text-sm text-destructive">{errors.coverUrl.message}</p>
        )}
      </div>

      {/* Content Categories */}
      <div className="space-y-2">
        <Label>Content categories (optional)</Label>
        <ContentCategoryPicker
          likedCategories={watch("likedCategories") || []}
          dislikedCategories={watch("dislikedCategories") || []}
          onLikedChange={(cats) => setValue("likedCategories", cats)}
          onDislikedChange={(cats) => setValue("dislikedCategories", cats)}
          customPool={customCategoryPool}
          disabled={isSubmitting}
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Select categories to fine-tune AI filtering for this feed
        </p>
      </div>

      {/* Custom Prompt */}
      <div className="space-y-2">
        <Label htmlFor="customPrompt">Filtering prompt (optional)</Label>
        <Textarea
          id="customPrompt"
          placeholder="Describe what interests you about this feed and the criteria for selecting materials..."
          rows={4}
          {...register("customPrompt")}
          disabled={isSubmitting}
        />
        {errors.customPrompt && (
          <p className="text-sm text-destructive">{errors.customPrompt.message}</p>
        )}
        <p className="text-xs text-muted-foreground leading-relaxed">
          Takes precedence over the global prompt — what you exclude here is filtered
          out for this source even if it matches your global criteria.
        </p>
      </div>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-6">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-[16px] w-[16px] animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
