"use client"

/**
 * Settings → Appearance → Typography (RAD-363 slice 7). Reads and writes the
 * preference only through `useTypography()`; every change saves immediately.
 */
import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, Info } from "lucide-react"
import { useTypography } from "@/components/providers/typography-provider"
import { TypographySpecimen } from "@/components/settings/typography-specimen"
import { FilterChip } from "@/components/ui/filter-chip"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fontPreviewStyle } from "@/lib/typography/css"
import { FONT_IDS, FONTS, isFontId, ROLES, type FontEntry, type FontId, type Role } from "@/lib/typography/fonts"
import { appleFontSupport } from "@/lib/typography/platform"
import { matchPreset, PRESETS } from "@/lib/typography/presets"
import type { TypographyPrefs } from "@/lib/typography/prefs"
import { cn } from "@/lib/utils"

const ROLE_COPY: Record<Role, { label: string; description: string }> = {
  heading: { label: "Headings", description: "Page, card and dialog titles" },
  text: { label: "Text", description: "Body, buttons, menus and forms" },
  counter: { label: "Counters", description: "Counts, percentages and other numbers" },
  tag: { label: "Tags", description: "Badges, chips and small labels" },
}

const HINTS: Record<FontEntry["availability"], string | null> = {
  everywhere: null,
  apple: "Apple devices",
  "apple-safari": "Safari and iOS",
}

const SANS_IDS = FONT_IDS.filter((id) => FONTS[id].group === "sans")
const MONO_IDS = FONT_IDS.filter((id) => FONTS[id].group === "mono")

// The codebase's explicit mobile floor (posts-toolbar, processing-card).
const TOUCH = "min-h-[44px] sm:min-h-0"

const NOTE_MONO = "Monospaced text sets about 25% wider, so long reading is slower."
const NOTE_NO_ROUNDED = "SF Pro Rounded appears in Safari and on iOS — this browser shows SF Pro instead."

/** What a non-Apple device draws instead: the sans SF fonts fall back to Inter, SF Mono to the system monospace. */
function noSfNote(sans: boolean, mono: boolean): string | null {
  if (sans && mono) {
    return "SF fonts are only on Apple devices — this device shows Inter instead, and its own monospace font for SF Mono."
  }
  if (sans) return "SF fonts are only on Apple devices — this device shows Inter instead."
  if (mono) return "SF Mono is only on Apple devices — this device shows its own monospace font instead."
  return null
}

function FontOption({ id }: { id: FontId }) {
  const hint = HINTS[FONTS[id].availability]
  const hintId = React.useId()
  return (
    <SelectPrimitive.Item
      value={id}
      aria-describedby={hint ? hintId : undefined}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        TOUCH,
      )}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center text-primary">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-[16px] w-[16px]" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>
        <span style={fontPreviewStyle(id)}>{FONTS[id].label}</span>
      </SelectPrimitive.ItemText>
      {hint && (
        <span id={hintId} className="ml-auto pl-3 text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </SelectPrimitive.Item>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 h-[16px] w-[16px] shrink-0" aria-hidden />
      <p>{children}</p>
    </div>
  )
}

export function TypographySection() {
  const { prefs, setPrefs } = useTypography()
  const [support, setSupport] = React.useState<{ sf: boolean; rounded: boolean } | null>(null)

  React.useEffect(() => {
    setSupport(appleFontSupport(navigator.userAgent, navigator.maxTouchPoints))
  }, [])

  const apply = (next: TypographyPrefs) => setPrefs(matchPreset(next) === "inter" ? null : next)
  const activePreset = matchPreset(prefs)

  const chosen = ROLES.map((role) => prefs[role])
  const sfSans = chosen.some((id) => FONTS[id].availability !== "everywhere" && FONTS[id].group === "sans")
  const sfMono = chosen.some((id) => FONTS[id].availability !== "everywhere" && FONTS[id].group === "mono")
  const usesRounded = chosen.some((id) => FONTS[id].availability === "apple-safari")
  const notes: string[] = []
  if (FONTS[prefs.text].group === "mono") notes.push(NOTE_MONO)
  const noSf = support && !support.sf ? noSfNote(sfSans, sfMono) : null
  if (noSf) notes.push(noSf)
  else if (support && usesRounded && !support.rounded) notes.push(NOTE_NO_ROUNDED)

  return (
    <div className="space-y-6">
      <div role="group" aria-label="Presets" className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => (
          <FilterChip
            key={preset.id}
            active={activePreset === preset.id}
            onClick={() => apply({ ...preset.prefs })}
            className={TOUCH}
          >
            {preset.label}
          </FilterChip>
        ))}
        {activePreset === null && (
          <span className="flex items-center gap-1.5 px-2 text-sm text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
            Custom
          </span>
        )}
      </div>

      <div className="space-y-4">
        {ROLES.map((role) => (
          <div key={role} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
            <div className="space-y-1">
              <Label htmlFor={`typography-${role}`}>{ROLE_COPY[role].label}</Label>
              <p id={`typography-${role}-description`} className="text-sm text-muted-foreground">
                {ROLE_COPY[role].description}
              </p>
            </div>
            <Select
              value={prefs[role]}
              onValueChange={(value) => {
                if (isFontId(value)) apply({ ...prefs, [role]: value })
              }}
            >
              <SelectTrigger
                id={`typography-${role}`}
                aria-describedby={`typography-${role}-description`}
                className={TOUCH}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Sans</SelectLabel>
                  {SANS_IDS.map((id) => (
                    <FontOption key={id} id={id} />
                  ))}
                </SelectGroup>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Mono</SelectLabel>
                  {MONO_IDS.map((id) => (
                    <FontOption key={id} id={id} />
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      {/* Always mounted, so a note that appears after a change is announced;
          empty, it drops its share of the stack's spacing. */}
      <div role="status" className="space-y-2 empty:mb-0">
        {notes.map((note) => (
          <Note key={note}>{note}</Note>
        ))}
      </div>

      <TypographySpecimen />
    </div>
  )
}
