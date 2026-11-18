"use client"

import { useState } from "react"
import {
  FileText,
  Database,
  Settings,
  Search,
  Plus,
  Trash2,
  ExternalLink,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
  CheckCircle,
  Info,
  AlertTriangle,
  Rss,
  Send,
  Star,
} from "lucide-react"
import { FaTelegram } from "react-icons/fa6"
import { TbWorldSearch } from "react-icons/tb"
import { FaXTwitter } from "react-icons/fa6"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { CardCover } from "@/components/ui/card-cover"
import { MorphText } from "@/components/ui/morph-text"
import { FilterChip } from "@/components/ui/filter-chip"
import { TypographySpecimen } from "@/components/settings/typography-specimen"
import { useTypography } from "@/components/providers/typography-provider"
import { FONTS, ROLES } from "@/lib/typography/fonts"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------
function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-lg font-semibold mb-6">{title}</h2>
      {children}
    </section>
  )
}

function SubSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Color swatch
// ---------------------------------------------------------------------------
function Swatch({
  name,
  token,
  value,
}: {
  name: string
  token: string
  value: string
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-[60px] w-[60px] rounded-lg shrink-0"
        style={{ background: value }}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {token}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feed type card (from FeedTypeCards pattern)
// ---------------------------------------------------------------------------
function DemoFeedTypeCard({
  label,
  icon,
  style,
}: {
  label: string
  icon: React.ReactNode
  style: React.CSSProperties
}) {
  return (
    <button
      className="source-type-card group relative flex flex-col items-center gap-3 rounded-lg p-6 transition-colors"
      style={style}
    >
      <div
        className="surface-mask pointer-events-none absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="source-type-glow h-[140px] w-[140px] rounded-full blur-[70px]" />
      </div>
      <div className="source-type-icon-wrap relative z-10 flex h-[48px] w-[48px] items-center justify-center rounded-full transition-transform group-hover:scale-105">
        <span className="source-type-icon">{icon}</span>
      </div>
      <span className="relative z-10 text-sm font-medium">{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// TOC
// ---------------------------------------------------------------------------
const sections = [
  { id: "corners", label: "Corners" },
  { id: "colors", label: "Colors" },
  { id: "typography", label: "Typography" },
  { id: "buttons", label: "Buttons" },
  { id: "badges", label: "Badges" },
  { id: "cards", label: "Cards" },
  { id: "tabs", label: "Tabs" },
  { id: "filter-chips", label: "Filter Chips" },
  { id: "forms", label: "Form Elements" },
  { id: "accordion", label: "Accordion" },
  { id: "empty-state", label: "Empty State" },
  { id: "separator", label: "Separator" },
  { id: "feed-type-cards", label: "Feed Type Cards" },
  { id: "animations", label: "Animations" },
  { id: "progress", label: "Progress" },
  { id: "layout-examples", label: "Layout Examples" },
  { id: "content-pages", label: "Content Pages" },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const ROLE_LABELS = { heading: "Headings", text: "Text", counter: "Counters", tag: "Tags" } as const

export default function DesignSystemPage() {
  const { prefs: typography } = useTypography()
  const [activeFilter, setActiveFilter] = useState("all")
  const [switchOn, setSwitchOn] = useState(true)
  const [animKey, setAnimKey] = useState(0)
  const [dismissDemo, setDismissDemo] = useState(false)
  const [slideRightKey, setSideRightKey] = useState(0)
  const [logFadeKey, setLogFadeKey] = useState(0)
  const [staggerCount, setStaggerCount] = useState(8)
  const [staggerInterval, setStaggerInterval] = useState(50)
  const [shakeKey, setShakeKey] = useState(0)
  const [iconPopKey, setIconPopKey] = useState(0)
  const [successKey, setSuccessKey] = useState(0)
  const [countSwapVal, setCountSwapVal] = useState(3)
  const [morphVal, setMorphVal] = useState(1271)

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-16">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Design System</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-2xl">
          All components, tokens, and patterns used across Radaric. Neutral surfaces
          with a deep-grass green accent, crisp hairline definition, and a soft
          elevation system that holds in light and dark. Inter typography,
          Tailwind CSS v4, shadcn/ui.
        </p>

        {/* Jump links */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-xs px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>

      {/* ================================================================== */}
      {/* CORNERS                                                            */}
      {/* ================================================================== */}
      <Section id="corners" title="Corners">
        <div className="space-y-8">
          <p className="text-sm text-muted-foreground max-w-2xl">
            Corners are a superellipse, not a circular arc —{" "}
            <code className="text-xs">corner-shape: superellipse(2.4)</code>, the house
            constant. One exponent for every element: a badge and
            a card are the same shape at two sizes, never two different shapes. What
            scales is the radius. It is applied to rectangles only — circles and capsules
            keep their true geometry, because a superellipse is a rectangle treatment.
            Chromium renders the shape natively; other engines fall back to the same
            radius scale as a plain <code className="text-xs">border-radius</code>.
          </p>

          <SubSection title="A radius is proportional to its element">
            <p className="text-sm text-muted-foreground max-w-2xl">
              A corner reads as right at roughly a quarter of the shorter side, so the
              ladder is sized by the element rather than spaced evenly. Square tiles are
              the calibration: the iOS app-icon ratio,{" "}
              <code className="text-xs">0.2237 × edge</code>, is what each control rung is
              rounded to. Measured on the real components — the density unit is{" "}
              <code className="text-xs">0.2rem</code>, so <code className="text-xs">h-10</code>{" "}
              is 32px, not 40 — every control lands at roughly a quarter of its height,
              0.22–0.31 across the set. The ends are the smallest badges (0.31, because
              there is no rung below 6) and rows held open by a 36px minimum (0.22).
              Surfaces stop caring about the ratio once they are past ~120px and settle on
              a fixed rung.
            </p>
            <div className="flex flex-wrap items-end gap-6 pt-2">
              {[
                { cls: "rounded-xs", px: 6, h: 22, w: 64, use: "badges, counters, tags" },
                { cls: "rounded-sm", px: 8, h: 32, w: 88, use: "buttons, inputs, selects, menu items, 32px tiles" },
                { cls: "rounded-md", px: 10, h: 36, w: 112, use: "large + icon buttons, nav rows, 44px tiles" },
                { cls: "rounded-lg", px: 14, h: 64, w: 136, use: "popovers, menus, nested panels" },
                { cls: "rounded-xl", px: 18, h: 104, w: 168, use: "cards, panels" },
                { cls: "rounded-2xl", px: 22, h: 132, w: 192, use: "dialogs, sheets, feature tiles" },
              ].map((r) => (
                <div key={r.cls} className="space-y-2">
                  <div
                    className={`bg-primary ${r.cls}`}
                    style={{ height: r.h, width: r.w }}
                  />
                  <div className="text-xs font-medium">{r.cls}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {r.px}px · {(r.px / r.h).toFixed(2)} × height
                  </div>
                  <div className="text-xs text-muted-foreground" style={{ maxWidth: r.w }}>
                    {r.use}
                  </div>
                </div>
              ))}
            </div>
          </SubSection>

          <SubSection title="One radius for everything is the bug">
            <p className="text-sm text-muted-foreground max-w-2xl">
              The scale used to run 10 / 12 / 14 / 18 / 22 — near-flat across the small
              end, because it had been sized to make the superellipse visible on cards and
              then applied to everything. On a 22px badge a 10px corner is 0.45 of the
              height and the straight edge disappears; the element stops being a rectangle
              with soft corners and becomes a lozenge. Left column is the old radius, right
              is the new one, at each element&apos;s real size.
            </p>
            <div className="flex flex-wrap items-start gap-8 pt-2">
              {[
                { label: "badge", h: 22, w: 68, was: 10, now: 6 },
                { label: "menu item", h: 30, w: 128, was: 10, now: 8 },
                { label: "button", h: 32, w: 108, was: 12, now: 8 },
                { label: "input", h: 32, w: 168, was: 12, now: 8 },
                { label: "icon button", h: 36, w: 36, was: 14, now: 10 },
                { label: "card", h: 132, w: 176, was: 18, now: 18 },
              ].map((e) => (
                <div key={e.label} className="space-y-2">
                  <div className="flex items-start gap-3">
                    <div
                      className="rounded-xl bg-secondary"
                      style={{ height: e.h, width: e.w, borderRadius: e.was }}
                    />
                    <div
                      className="rounded-xl bg-primary"
                      style={{ height: e.h, width: e.w, borderRadius: e.now }}
                    />
                  </div>
                  <div className="text-xs font-medium">{e.label}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {e.h}px tall · {e.was} → {e.now}
                  </div>
                </div>
              ))}
            </div>
          </SubSection>

          <SubSection title="Rectangles superellipse, circles stay circles">
            <div className="flex flex-wrap items-start gap-6">
              <div className="space-y-2">
                <div className="h-24 w-24 rounded-2xl bg-primary" />
                <div className="text-xs font-medium">rounded-2xl</div>
                <div className="text-xs text-muted-foreground">superellipse(2.4)</div>
              </div>
              <div className="space-y-2">
                <div className="h-24 w-24 rounded-full bg-primary" />
                <div className="text-xs font-medium">rounded-full</div>
                <div className="text-xs text-muted-foreground">true circle — excluded</div>
              </div>
              <div className="space-y-2">
                <div className="h-10 w-32 rounded-full bg-primary-subtle" />
                <div className="text-xs font-medium">pill</div>
                <div className="text-xs text-muted-foreground">true capsule — excluded</div>
              </div>
              <div className="space-y-2">
                <div
                  className="icon-tile h-24 w-24 bg-primary"
                  style={{ "--tile-size": "6rem" } as React.CSSProperties}
                />
                <div className="text-xs font-medium">.icon-tile</div>
                <div className="text-xs text-muted-foreground">
                  app-icon ratio (0.2237 × size)
                </div>
              </div>
              <div className="space-y-2">
                <div className="h-24 w-24 rounded-2xl corner-round bg-secondary" />
                <div className="text-xs font-medium">.corner-round</div>
                <div className="text-xs text-muted-foreground">opt-out escape hatch</div>
              </div>
            </div>
          </SubSection>

          <SubSection title="Where the shape is actually visible">
            <p className="text-sm text-muted-foreground max-w-2xl">
              A superellipse and a circular arc are pixel-identical at 8px and only begin
              to diverge around 18px. That is why the character has to be carried by the
              surfaces, and why shrinking the control rungs costs nothing: at 6–10px there
              was never a visible superellipse to lose. Each pair below is the same radius,
              plain arc on the left and superellipse on the right.
            </p>
            <div className="flex flex-wrap items-start gap-6 pt-2">
              {[8, 12, 18, 24].map((r) => (
                <div key={r} className="space-y-2">
                  <div className="flex gap-2">
                    <div
                      className="h-20 w-20 bg-secondary corner-round"
                      style={{ borderRadius: `${r}px` }}
                    />
                    <div
                      className="h-20 w-20 rounded-xl bg-primary"
                      style={{ borderRadius: `${r}px` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">{r}px</div>
                </div>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* COLORS                                                             */}
      {/* ================================================================== */}
      <Section id="colors" title="Colors">
        <div className="space-y-8">
          <SubSection title="Surfaces">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              <Swatch name="Background" token="--background" value="var(--background)" />
              <Swatch name="Card" token="--card" value="var(--card)" />
              <Swatch name="Popover" token="--popover" value="var(--popover)" />
              <Swatch name="Secondary" token="--secondary" value="var(--secondary)" />
              <Swatch name="Muted" token="--muted" value="var(--muted)" />
              <Swatch name="Accent" token="--accent" value="var(--accent)" />
            </div>
          </SubSection>

          <SubSection title="Text">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              <Swatch name="Foreground" token="--foreground" value="var(--foreground)" />
              <Swatch name="Card Foreground" token="--card-foreground" value="var(--card-foreground)" />
              <Swatch name="Muted Foreground" token="--muted-foreground" value="var(--muted-foreground)" />
              <Swatch name="Accent Foreground" token="--accent-foreground" value="var(--accent-foreground)" />
            </div>
          </SubSection>

          <SubSection title="Accent Colors">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              <Swatch name="Primary (Green)" token="--primary" value="var(--primary)" />
              <Swatch name="Destructive (Red)" token="--destructive" value="var(--destructive)" />
              <Swatch name="Info (Blue)" token="--info" value="var(--info)" />
              <Swatch name="Warning (Yellow)" token="--warning" value="var(--warning)" />
            </div>
          </SubSection>

          <SubSection title="Border & Input">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              <Swatch name="Border" token="--border" value="var(--border)" />
              <Swatch name="Input" token="--input" value="var(--input)" />
              <Swatch name="Ring" token="--ring" value="var(--ring)" />
            </div>
          </SubSection>

          <SubSection title="Charts">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
              <Swatch name="Green" token="--chart-1" value="var(--chart-1)" />
              <Swatch name="Blue" token="--chart-2" value="var(--chart-2)" />
              <Swatch name="Teal" token="--chart-3" value="var(--chart-3)" />
              <Swatch name="Purple" token="--chart-4" value="var(--chart-4)" />
              <Swatch name="Amber" token="--chart-5" value="var(--chart-5)" />
            </div>
          </SubSection>

          <SubSection title="Radix Sage Scale (12 steps)">
            <p className="text-xs text-muted-foreground mb-3">
              Steps 1-2: backgrounds. 3-5: component states. 6-8: borders. 9-10: solid. 11-12: text.
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-12 gap-2">
              {[
                "#fbfdfc", "#f7f9f8", "#eef1f0", "#e6e9e8",
                "#dfe2e0", "#d7dad9", "#cbcfcd", "#b8bcba",
                "#868e8b", "#7c8481", "#5f6563", "#1a211e",
              ].map((hex, i) => (
                <div key={hex} className="flex flex-col items-center gap-1">
                  <div
                    className="h-12 w-full rounded-sm"
                    style={{ background: hex }}
                  />
                  <span className="text-[10px] font-mono text-muted-foreground">{i + 1}</span>
                </div>
              ))}
            </div>
          </SubSection>

          <SubSection title="Radix Grass Scale (12 steps)">
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-12 gap-2">
              {[
                "#fbfefb", "#f5fbf5", "#e9f6e9", "#daf1db",
                "#c9e8ca", "#b2ddb5", "#94ce9a", "#65ba74",
                "#46a758", "#3e9b4f", "#2a7e3b", "#203c25",
              ].map((hex, i) => (
                <div key={hex} className="flex flex-col items-center gap-1">
                  <div
                    className="h-12 w-full rounded-sm"
                    style={{ background: hex }}
                  />
                  <span className="text-[10px] font-mono text-muted-foreground">{i + 1}</span>
                </div>
              ))}
            </div>
          </SubSection>

          <SubSection title="Semantic Accents (step 9)">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <Swatch name="Grass" token="step 9" value="#46a758" />
              <Swatch name="Blue" token="step 9" value="#0090ff" />
              <Swatch name="Teal" token="step 9" value="#12a594" />
              <Swatch name="Purple" token="step 9" value="#8e4ec6" />
              <Swatch name="Amber" token="step 9" value="#ffc53d" />
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* TYPOGRAPHY                                                         */}
      {/* ================================================================== */}
      <Section id="typography" title="Typography">
        <div className="space-y-8">
          <SubSection title="Headings">
            <div className="space-y-4 py-2">
              <h1 className="text-3xl font-bold tracking-tight">Heading 1 — text-3xl font-bold</h1>
              <h2 className="text-2xl font-bold tracking-tight">Heading 2 — text-2xl font-bold</h2>
              <h3 className="text-xl font-bold">Heading 3 — text-xl font-bold</h3>
              <h4 className="text-lg font-semibold leading-snug">Heading 4 — text-lg font-semibold</h4>
              <h5 className="text-base font-semibold">Heading 5 — text-base font-semibold</h5>
              <h6 className="text-sm font-semibold">Heading 6 — text-sm font-semibold</h6>
            </div>
          </SubSection>

          <SubSection title="Body Text">
            <div className="space-y-4 py-2">
              <p className="text-sm leading-relaxed">
                <strong>Body (default)</strong> — text-sm leading-relaxed. The quick brown fox jumps
                over the lazy dog. Content curators process hundreds of items daily, requiring
                intelligent filtering with personalized heuristics.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                <strong>Muted</strong> — text-sm text-muted-foreground. Secondary information that
                supports the primary content but doesn&apos;t demand attention.
              </p>
              <p className="text-xs text-muted-foreground">
                <strong>Caption</strong> — text-xs text-muted-foreground. Timestamps, metadata, helper text.
              </p>
            </div>
          </SubSection>

          <SubSection title="Monospace">
            <div className="space-y-3 py-2">
              <p className="font-mono text-sm">
                font-mono text-sm — SFMono-Regular, &quot;SF Mono&quot;, Menlo
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                font-mono text-xs — #30a46c
              </p>
            </div>
          </SubSection>

          <SubSection title="Roles">
            <div className="space-y-4 py-2">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                {ROLES.map((role) => (
                  <div key={role} className="contents">
                    <dt className="text-muted-foreground">{ROLE_LABELS[role]}</dt>
                    <dd>{FONTS[typography[role]].label}</dd>
                  </div>
                ))}
              </dl>
              <TypographySpecimen />
            </div>
          </SubSection>

          <SubSection title="Text Colors">
            <div className="space-y-2 py-2">
              <p className="text-sm text-foreground">text-foreground — Primary text</p>
              <p className="text-sm text-muted-foreground">text-muted-foreground — Secondary text</p>
              <p className="text-sm text-primary">text-primary — Green accent text</p>
              <p className="text-sm text-destructive">text-destructive — Destructive/error text</p>
              <p className="text-sm text-info">text-info — Info text</p>
              <p className="text-sm text-warning">text-warning — Warning text</p>
            </div>
          </SubSection>

          {/* The IDS link treatment (RAD-366). Demonstrates the states a
              static swatch cannot: hover in/out asymmetry and the focus
              outline need a pointer and Tab. */}
          <SubSection title="Links — the IDS treatment">
            <div className="space-y-4 py-2">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Always underlined; the rule is a 20% tint of the link&apos;s own
                colour, so the words keep their contrast and the underline
                carries the affordance. Hover deepens the colour — instantly
                in, fading back over 150ms — and the rule follows. Tab to the
                third link to see the focus outline. A zone that recolours
                links remaps <code className="rounded bg-muted px-1.5 py-0.5 text-xs">--link</code>{" "}
                / <code className="rounded bg-muted px-1.5 py-0.5 text-xs">--link-hover</code>{" "}
                — never a bare green where the surface drops below AA.
              </p>

              <p className="text-sm leading-relaxed">
                Standalone:{" "}
                <a href="#" onClick={(e) => e.preventDefault()} className="link">
                  a link like this
                </a>{" "}
                sits in a sentence at text weight, green and ruled.
              </p>

              <div className="prose prose-sm max-w-none [&_a]:link">
                <p>
                  In prose —{" "}
                  <a href="#" onClick={(e) => e.preventDefault()}>
                    a link inside a paragraph
                  </a>{" "}
                  reads as one run of type; Typography keeps its link weight
                  (500), and the tinted rule does the signalling.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-sm bg-secondary px-3 py-1.5 text-sm">
                  On --secondary:{" "}
                  <a
                    href="#"
                    onClick={(e) => e.preventDefault()}
                    className="link link-on-tint"
                  >
                    the pair is remapped
                  </a>
                </span>
                <a href="#" onClick={(e) => e.preventDefault()} className="link text-sm">
                  Tab-reachable focus ring
                </a>
                <Button variant="link">Button variant link</Button>
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* BUTTONS                                                            */}
      {/* ================================================================== */}
      <Section id="buttons" title="Buttons">
        <div className="space-y-8">
          <SubSection title="Variants">
            <div className="flex flex-wrap gap-3 py-2">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="destructive-solid">Destructive Solid</Button>
            </div>
          </SubSection>

          <SubSection title="Sizes">
            <div className="flex flex-wrap items-center gap-3 py-2">
              <Button size="sm">Small</Button>
              <Button size="default">Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" aria-label="Search">
                <Search className="h-[16px] w-[16px]" />
              </Button>
            </div>
          </SubSection>

          <SubSection title="With Icons">
            <div className="flex flex-wrap gap-3 py-2">
              <Button>
                <Plus className="h-[16px] w-[16px]" />
                Add Feed
              </Button>
              <Button variant="outline">
                <ExternalLink className="h-[16px] w-[16px]" />
                Open
              </Button>
              <Button variant="destructive">
                <Trash2 className="h-[16px] w-[16px]" />
                Delete
              </Button>
            </div>
          </SubSection>

          <SubSection title="States">
            <div className="flex flex-wrap gap-3 py-2">
              <Button disabled>Disabled</Button>
              <Button variant="outline" disabled>Disabled Outline</Button>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* BADGES                                                             */}
      {/* ================================================================== */}
      <Section id="badges" title="Badges">
        <div className="space-y-8">
          <SubSection title="Variants">
            <div className="flex flex-wrap gap-3 py-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="subtle">Subtle</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="info">Info</Badge>
              <Badge variant="warning">Warning</Badge>
            </div>
          </SubSection>

          <SubSection title="Sizes">
            <div className="flex flex-wrap items-center gap-3 py-2">
              <Badge size="sm">Small</Badge>
              <Badge size="default">Default</Badge>
              <Badge size="lg">Large</Badge>
            </div>
          </SubSection>

          <SubSection title="With Icons">
            <div className="flex flex-wrap gap-3 py-2">
              <Badge variant="info" className="gap-1">
                <Info className="h-[14px] w-[14px]" />
                Parsing
              </Badge>
              <Badge variant="success" className="gap-1">
                <CheckCircle className="h-[14px] w-[14px]" />
                Approved
              </Badge>
              <Badge variant="destructive" className="gap-1">
                <AlertCircle className="h-[14px] w-[14px]" />
                Error
              </Badge>
              <Badge variant="warning" className="gap-1">
                <AlertTriangle className="h-[14px] w-[14px]" />
                Warning
              </Badge>
            </div>
          </SubSection>

          <SubSection title="Status Indicators (Material Card pattern)">
            <div className="flex flex-wrap gap-6 py-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-primary" />
                <span className="text-sm">Approved 87%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-destructive" />
                <span className="text-sm">Filtered 34%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                <span className="text-sm">Pending</span>
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* CARDS                                                              */}
      {/* ================================================================== */}
      <Section id="cards" title="Cards">
        <div className="space-y-8">
          <SubSection title="Standard Card">
            <Card>
              <CardHeader>
                <CardTitle>Card Title</CardTitle>
                <CardDescription>
                  Card description with supporting text. Uses text-sm
                  text-muted-foreground with leading-[1.7].
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">Card content area with p-4 pt-1 padding.</p>
              </CardContent>
              <CardFooter>
                <Button size="sm">Action</Button>
              </CardFooter>
            </Card>
          </SubSection>

          <SubSection title="Interactive Card">
            <Card interactive>
              <CardHeader>
                <CardTitle>Interactive Card</CardTitle>
                <CardDescription>
                  Hover to see bg-accent/50 transition. Has cursor-pointer and
                  focus-visible:ring-primary/50.
                </CardDescription>
              </CardHeader>
            </Card>
          </SubSection>

          <SubSection title="Card Grid (Feed-like)">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { title: "Tech News Daily", type: "RSS", count: 142 },
                { title: "@design_channel", type: "Telegram", count: 87 },
                { title: "@tech_wire", type: "X", count: 23 },
                { title: "AI Monitor", type: "Monitor", count: 56 },
              ].map((feed) => (
                <Card key={feed.title}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{feed.title}</CardTitle>
                      <Badge variant="subtle" size="sm">{feed.type}</Badge>
                    </div>
                    <CardDescription>{feed.count} materials</CardDescription>
                  </CardHeader>
                  <CardFooter className="gap-2">
                    <Button size="sm">Parse</Button>
                    <Button size="sm" variant="ghost">
                      <Settings className="h-[16px] w-[16px]" />
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </SubSection>

          <SubSection title="Cover band — never cropped, scrubs on hover">
            <p className="text-sm text-muted-foreground leading-[1.7] mb-3">
              <code className="text-xs">CardCover</code> owns one rule: a cover keeps its own
              aspect ratio and the band takes that height — no centre crop, so cards in a row no
              longer share a cover height. Give it 2+ frames and it becomes{" "}
              <code className="text-xs">HoverGallery</code> (a port of IDS{" "}
              <code className="text-xs">.ids__inline-gallery</code>): move the cursor across the
              band to scrub, swipe horizontally on touch. The band keeps the first frame&apos;s
              height throughout, and frames 2..N are only fetched once a pointer arrives.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card interactive>
                <CardCover src="/landing/story-demo-cover.webp" alt="Single cover" />
                <CardContent className="p-4">
                  <h3 className="font-semibold leading-snug">One image</h3>
                  <p className="text-sm text-muted-foreground">
                    A still. No listeners, no indicators.
                  </p>
                </CardContent>
              </Card>

              <Card interactive>
                <CardCover
                  src="/landing/posts-light.webp"
                  alt="Scrubbable cover"
                  images={[
                    "/landing/posts-light.webp",
                    "/landing/filters-light.webp",
                    "/landing/global-prompt-light.webp",
                    "/landing/feedback-light.webp",
                  ]}
                />
                <CardContent className="p-4">
                  <h3 className="font-semibold leading-snug">Four images</h3>
                  <p className="text-sm text-muted-foreground">
                    Hover left to right. The chip counts, the dashes place you.
                  </p>
                </CardContent>
              </Card>
            </div>
          </SubSection>

          <SubSection title="Content Cards (Material pattern)">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Approved card with thumbnail */}
              <Card interactive>
                <div className="surface-mask-top relative w-full h-48 bg-muted overflow-hidden">
                  <div className="w-full h-full bg-accent flex items-center justify-center">
                    <span className="text-muted-foreground text-xs">Thumbnail placeholder</span>
                  </div>
                </div>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0 bg-primary" />
                      <span className="text-xs text-muted-foreground">Approved</span>
                    </div>
                    <span className="text-xs text-muted-foreground">87%</span>
                  </div>
                  <h3 className="font-semibold leading-snug">
                    Acme AI announces a new reasoning model tuned for long-horizon tasks
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="hover:text-foreground transition-colors cursor-pointer">Tech News Daily</span>
                    <span>·</span>
                    <span>28 Mar 2026</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                    The latest model demonstrates significant improvements in multi-step reasoning,
                    code generation, and scientific analysis. Early benchmarks show a 40% improvement
                    over previous generation across key tasks...
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" size="sm">In Stories</Badge>
                  </div>
                  <div className="flex items-center gap-1 pt-1">
                    <Button size="sm" variant="ghost" aria-label="Like">
                      <ThumbsUp className="h-[14px] w-[14px]" />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Dislike">
                      <ThumbsDown className="h-[14px] w-[14px]" />
                    </Button>
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Archive">
                        <FileText className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Open link">
                        <ExternalLink className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="destructive" aria-label="Delete">
                        <Trash2 className="h-[14px] w-[14px]" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Filtered card without thumbnail */}
              <Card interactive>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0 bg-destructive" />
                      <span className="text-xs text-muted-foreground">Filtered</span>
                    </div>
                    <span className="text-xs text-muted-foreground">34%</span>
                  </div>
                  <h3 className="font-semibold leading-snug">
                    Weekly roundup: 15 new JavaScript frameworks you probably don&apos;t need
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="hover:text-foreground transition-colors cursor-pointer">@design_channel</span>
                    <span>·</span>
                    <span>27 Mar 2026</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                    Another week, another batch of frameworks promising to revolutionize web development.
                    Most of these are thin wrappers around existing tools with marginal improvements
                    in developer experience...
                  </p>
                  <div className="flex items-center gap-1 pt-1">
                    <Button size="sm" className="bg-primary/15 text-primary" aria-label="Liked">
                      <ThumbsUp className="h-[14px] w-[14px]" />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Dislike">
                      <ThumbsDown className="h-[14px] w-[14px]" />
                    </Button>
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Archive">
                        <FileText className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Open link">
                        <ExternalLink className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="destructive" aria-label="Delete">
                        <Trash2 className="h-[14px] w-[14px]" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Archived card */}
              <Card interactive>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0 bg-primary" />
                      <span className="text-xs text-muted-foreground">Approved</span>
                    </div>
                    <span className="text-xs text-muted-foreground">92%</span>
                  </div>
                  <h3 className="font-semibold leading-snug">
                    Northwind Design introduces AI-powered design systems that learn from your components
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="hover:text-foreground transition-colors cursor-pointer">@northwind_design</span>
                    <span>·</span>
                    <span>26 Mar 2026</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                    The new feature analyzes existing design tokens, spacing patterns, and component
                    variants to automatically suggest consistent designs across your team&apos;s projects.
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge variant="subtle" size="sm">Archived</Badge>
                    <Badge variant="outline" size="sm">In Notion</Badge>
                  </div>
                  <div className="flex items-center gap-1 pt-1">
                    <Button size="sm" variant="ghost" aria-label="Like">
                      <ThumbsUp className="h-[14px] w-[14px]" />
                    </Button>
                    <Button size="sm" className="bg-destructive/15 text-destructive" aria-label="Disliked">
                      <ThumbsDown className="h-[14px] w-[14px]" />
                    </Button>
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Open link">
                        <ExternalLink className="h-[14px] w-[14px]" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Telegram card with entities-style content */}
              <Card interactive>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0 bg-primary" />
                      <span className="text-xs text-muted-foreground">Approved</span>
                    </div>
                    <span className="text-xs text-muted-foreground">78%</span>
                  </div>
                  <h3 className="font-semibold leading-snug">
                    Sample headline for a material card in the gallery
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="hover:text-foreground transition-colors cursor-pointer">AI Monitor</span>
                    <span>·</span>
                    <span>28 Mar 2026</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                    Placeholder text used to preview the three-line clamp: line height, truncation
                    at the boundary, and muted contrast are all visible here. Swap in real content
                    when reviewing the layout.
                  </p>
                  <div className="flex items-center gap-1 pt-1">
                    <Button size="sm" variant="ghost" aria-label="Like">
                      <ThumbsUp className="h-[14px] w-[14px]" />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Dislike">
                      <ThumbsDown className="h-[14px] w-[14px]" />
                    </Button>
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Send to stories">
                        <Send className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Archive">
                        <FileText className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Open link">
                        <ExternalLink className="h-[14px] w-[14px]" />
                      </Button>
                      <Button size="sm" variant="destructive" aria-label="Delete">
                        <Trash2 className="h-[14px] w-[14px]" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* TABS                                                               */}
      {/* ================================================================== */}
      <Section id="tabs" title="Tabs">
        <div className="space-y-8">
          <SubSection title="Linear-style Underline Tabs">
            <div className="py-2">
              <Tabs defaultValue="inbox">
                <TabsList>
                  <TabsTrigger value="inbox">Inbox</TabsTrigger>
                  <TabsTrigger value="approved">Approved</TabsTrigger>
                  <TabsTrigger value="filtered">Filtered</TabsTrigger>
                  <TabsTrigger value="archive">Archive</TabsTrigger>
                </TabsList>
                <TabsContent value="inbox">
                  <p className="text-sm text-muted-foreground py-4">
                    Inbox content — new materials awaiting review.
                  </p>
                </TabsContent>
                <TabsContent value="approved">
                  <p className="text-sm text-muted-foreground py-4">
                    Approved content — materials that passed AI filtering.
                  </p>
                </TabsContent>
                <TabsContent value="filtered">
                  <p className="text-sm text-muted-foreground py-4">
                    Filtered content — materials rejected by AI.
                  </p>
                </TabsContent>
                <TabsContent value="archive">
                  <p className="text-sm text-muted-foreground py-4">
                    Archived materials.
                  </p>
                </TabsContent>
              </Tabs>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* FILTER CHIPS                                                       */}
      {/* ================================================================== */}
      <Section id="filter-chips" title="Filter Chips">
        <div className="space-y-8">
          <SubSection title="Interactive (with brand colors)">
            <div className="flex flex-wrap gap-2 py-2">
              <FilterChip
                active={activeFilter === "all"}
                onClick={() => setActiveFilter("all")}
                count={308}
              >
                All
              </FilterChip>
              <FilterChip
                active={activeFilter === "rss"}
                onClick={() => setActiveFilter("rss")}
                count={142}
                icon={<Rss className="h-[14px] w-[14px]" />}
                accentColor="#f76b15"
              >
                RSS
              </FilterChip>
              <FilterChip
                active={activeFilter === "telegram"}
                onClick={() => setActiveFilter("telegram")}
                count={87}
                icon={<FaTelegram className="h-[14px] w-[14px]" />}
                accentColor="#0090ff"
              >
                Telegram
              </FilterChip>
              <FilterChip
                active={activeFilter === "x"}
                onClick={() => setActiveFilter("x")}
                count={23}
                icon={<FaXTwitter className="h-[14px] w-[14px]" />}
                accentColor="#5f6563"
                accentBgOpacity={0.08}
              >
                X
              </FilterChip>
              <FilterChip
                active={activeFilter === "monitor"}
                onClick={() => setActiveFilter("monitor")}
                count={56}
                icon={<TbWorldSearch className="h-[14px] w-[14px]" />}
                accentColor="#8e4ec6"
              >
                Monitor
              </FilterChip>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* FORM ELEMENTS                                                      */}
      {/* ================================================================== */}
      <Section id="forms" title="Form Elements">
        <div className="space-y-8">
          <SubSection title="Input">
            <div className="space-y-4 py-2 max-w-md">
              <div className="space-y-2">
                <Label htmlFor="demo-input">Feed URL</Label>
                <Input id="demo-input" placeholder="https://example.com/feed.xml" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="demo-input-disabled">Disabled Input</Label>
                <Input id="demo-input-disabled" placeholder="Disabled" disabled />
              </div>
            </div>
          </SubSection>

          <SubSection title="Textarea">
            <div className="space-y-2 py-2 max-w-md">
              <Label htmlFor="demo-textarea">Global AI Prompt</Label>
              <Textarea
                id="demo-textarea"
                placeholder="Describe your filtering criteria..."
                rows={4}
              />
            </div>
          </SubSection>

          <SubSection title="Select">
            <div className="space-y-2 py-2 max-w-md">
              <Label>Feed Type</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select feed type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rss">RSS Feed</SelectItem>
                  <SelectItem value="telegram">Telegram Channel</SelectItem>
                  <SelectItem value="twitter">X / Twitter</SelectItem>
                  <SelectItem value="monitor">Event Trigger</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SubSection>

          <SubSection title="Switch">
            <div className="space-y-4 py-2 max-w-md">
              <div className="flex items-center justify-between">
                <Label htmlFor="demo-switch">Auto-parse on creation</Label>
                <Switch
                  id="demo-switch"
                  checked={switchOn}
                  onCheckedChange={setSwitchOn}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="demo-switch-off">Disabled switch</Label>
                <Switch id="demo-switch-off" disabled />
              </div>
            </div>
          </SubSection>

          <SubSection title="Feedback Buttons (Like/Dislike pattern)">
            <div className="flex gap-2 py-2">
              <Button size="icon" variant="ghost" aria-label="Like">
                <ThumbsUp className="h-[16px] w-[16px]" />
              </Button>
              <Button size="icon" variant="ghost" aria-label="Dislike">
                <ThumbsDown className="h-[16px] w-[16px]" />
              </Button>
              <Separator orientation="vertical" className="h-11 mx-2" />
              <Button
                size="icon"
                className="bg-primary/15 text-primary"
                aria-label="Liked"
              >
                <ThumbsUp className="h-[16px] w-[16px]" />
              </Button>
              <Button
                size="icon"
                className="bg-destructive/15 text-destructive"
                aria-label="Disliked"
              >
                <ThumbsDown className="h-[16px] w-[16px]" />
              </Button>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* ACCORDION                                                          */}
      {/* ================================================================== */}
      <Section id="accordion" title="Accordion">
        <div className="py-2">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="item-1">
              <AccordionTrigger>How does AI filtering work?</AccordionTrigger>
              <AccordionContent>
                Radaric uses Claude to evaluate each material against your
                personalized filtering criteria. The AI considers your global
                prompt, per-feed prompts, feedback history, and blacklists.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-2">
              <AccordionTrigger>What sources are supported?</AccordionTrigger>
              <AccordionContent>
                RSS feeds, Telegram channels (including private), X/Twitter
                accounts, and AI-powered web monitoring via Event Triggers.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-3">
              <AccordionTrigger>How does feedback learning work?</AccordionTrigger>
              <AccordionContent>
                Every Like/Dislike you provide is stored as context. The AI
                includes your recent feedback history in its evaluation prompt,
                continuously learning your preferences.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* EMPTY STATE                                                        */}
      {/* ================================================================== */}
      <Section id="empty-state" title="Empty State">
        <div className="space-y-8">
          <SubSection title="Standard">
            <EmptyState
              icon={<Database className="h-[20px] w-[20px] text-muted-foreground" />}
              title="No feeds yet"
              description="Add your first RSS feed, Telegram channel, or X account to start curating content."
              action={
                <Button>
                  <Plus className="h-[16px] w-[16px]" />
                  Add Feed
                </Button>
              }
            />
          </SubSection>

          <SubSection title="With Count Badge">
            <EmptyState
              icon={<FileText className="h-[20px] w-[20px] text-muted-foreground" />}
              title="All caught up"
              description="No new materials in your inbox. Check back after the next parsing cycle."
              count={0}
            />
          </SubSection>

          <SubSection title="Error State">
            <EmptyState
              icon={<AlertCircle className="h-[20px] w-[20px] text-destructive" />}
              title="Failed to load"
              description="Something went wrong while fetching materials. Please try again."
              action={<Button variant="outline">Retry</Button>}
            />
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* SEPARATOR                                                          */}
      {/* ================================================================== */}
      <Section id="separator" title="Separator">
        <div className="space-y-6 py-2">
          <div>
            <p className="text-sm mb-3">Horizontal (default)</p>
            <Separator />
          </div>
          <div className="flex items-center gap-4 h-8">
            <p className="text-sm">Vertical</p>
            <Separator orientation="vertical" />
            <p className="text-sm text-muted-foreground">Between items</p>
            <Separator orientation="vertical" />
            <p className="text-sm text-muted-foreground">Like this</p>
          </div>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* FEED TYPE CARDS                                                    */}
      {/* ================================================================== */}
      <Section id="feed-type-cards" title="Feed Type Cards">
        <p className="text-sm text-muted-foreground mb-4">
          Glow-effect cards with per-brand Radix hex custom properties. Each card has
          a radial glow blob behind the icon.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <DemoFeedTypeCard
            label="RSS Feed"
            icon={<Rss className="h-[24px] w-[24px]" />}
            style={{
              "--card-color": "#f76b15",
              "--card-color-dark": "#ff8b3e",
              "--card-border": "#f76b1533",
              "--card-border-hover": "#f76b1566",
              "--card-glow": "#f76b1533",
              "--card-glow-dark": "#f76b154d",
              "--card-icon-bg": "#f76b151f",
              "--card-icon-bg-dark": "#f76b1540",
            } as React.CSSProperties}
          />
          <DemoFeedTypeCard
            label="Telegram"
            icon={<FaTelegram className="h-[24px] w-[24px]" />}
            style={{
              "--card-color": "#0090ff",
              "--card-color-dark": "#70b8ff",
              "--card-border": "#0090ff33",
              "--card-border-hover": "#0090ff66",
              "--card-glow": "#0090ff33",
              "--card-glow-dark": "#0090ff4d",
              "--card-icon-bg": "#0090ff1f",
              "--card-icon-bg-dark": "#0090ff40",
            } as React.CSSProperties}
          />
          <DemoFeedTypeCard
            label="X / Twitter"
            icon={<FaXTwitter className="h-[24px] w-[24px]" />}
            style={{
              "--card-color": "#5f6563",
              "--card-color-dark": "#adb5b2",
              "--card-border": "#5f656333",
              "--card-border-hover": "#5f656366",
              "--card-glow": "#5f656326",
              "--card-glow-dark": "#5f656333",
              "--card-icon-bg": "#5f65631a",
              "--card-icon-bg-dark": "#5f656333",
            } as React.CSSProperties}
          />
          <DemoFeedTypeCard
            label="Monitor"
            icon={<TbWorldSearch className="h-[24px] w-[24px]" />}
            style={{
              "--card-color": "#8e4ec6",
              "--card-color-dark": "#d19dff",
              "--card-border": "#8e4ec633",
              "--card-border-hover": "#8e4ec666",
              "--card-glow": "#8e4ec633",
              "--card-glow-dark": "#8e4ec64d",
              "--card-icon-bg": "#8e4ec61f",
              "--card-icon-bg-dark": "#8e4ec640",
            } as React.CSSProperties}
          />
        </div>
      </Section>

      {/* ================================================================== */}
      {/* ANIMATIONS                                                         */}
      {/* ================================================================== */}
      <Section id="animations" title="Animations">
        <p className="text-sm text-muted-foreground mb-6">
          Interactive playground. Motion tokens derived from transitions.dev.
          Three curves: <code className="text-xs">--ease-snap</code> (structural),{" "}
          <code className="text-xs">--ease-bounce</code> (success feedback only),{" "}
          <code className="text-xs">--ease-exit</code> (close/dismiss).
          Duration scale: 150ms–400ms, open/close asymmetric.
        </p>

        <div className="space-y-8">
          {/* fade-in-up */}
          <SubSection title="fade-in-up — 0.2s, translateY(8px)">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAnimKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .will-animate .animate-fade-in-up
                </span>
              </div>
              <div key={`fiu-${animKey}`} className="will-animate animate-fade-in-up">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Slides up 8px + fades in</CardTitle>
                    <CardDescription>Used for sequential list items, page entry</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </div>
          </SubSection>

          {/* fade-in-scale */}
          <SubSection title="fade-in-scale — 0.15s, scale(0.98 -> 1)">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAnimKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .will-animate .animate-fade-in-scale
                </span>
              </div>
              <div key={`fis-${animKey}`} className="will-animate animate-fade-in-scale">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Scales up + fades in</CardTitle>
                    <CardDescription>Used for card reveals, modals appearing</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </div>
          </SubSection>

          {/* slide-in-right */}
          <SubSection title="slide-in-right — 0.2s, translateX(-8px)">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSideRightKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .will-animate .animate-slide-in-right
                </span>
              </div>
              <div key={`sir-${slideRightKey}`} className="will-animate animate-slide-in-right">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Slides in from left</CardTitle>
                    <CardDescription>Used for side panel content, navigation transitions</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </div>
          </SubSection>

          {/* dismiss */}
          <SubSection title="dismiss — 0.3s, scale(1 -> 0.85) + fade out">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDismissDemo(false)
                    requestAnimationFrame(() => setDismissDemo(true))
                  }}
                >
                  Trigger Dismiss
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-dismiss
                </span>
              </div>
              <div className={dismissDemo ? "animate-dismiss" : ""}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Dismissable Card</CardTitle>
                    <CardDescription>Scales to center + fades out. Used for archive/delete</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </div>
          </SubSection>

          {/* shake */}
          <SubSection title="shake — 200ms, input error rejection">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShakeKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-shake
                </span>
              </div>
              <div key={`shake-${shakeKey}`} className="max-w-xs">
                <input
                  className="flex h-10 w-full rounded-sm bg-secondary px-3 py-2 text-sm ring-2 ring-inset ring-destructive animate-shake"
                  defaultValue="invalid@"
                  readOnly
                />
              </div>
            </div>
          </SubSection>

          {/* icon-pop */}
          <SubSection title="icon-pop — 150ms, scale(0.25→1) + blur">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIconPopKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-icon-pop
                </span>
              </div>
              <div className="flex items-center gap-4">
                <ThumbsUp key={`ip-${iconPopKey}`} className="h-6 w-6 text-primary fill-primary animate-icon-pop" />
                <span className="text-sm text-muted-foreground">Like / dislike icon feedback</span>
              </div>
            </div>
          </SubSection>

          {/* success-check */}
          <SubSection title="success-check — 350ms, rotate + bob + path draw">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSuccessKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-success-check .animate-success-path
                </span>
              </div>
              <div key={`sc-${successKey}`} className="flex items-center gap-3 text-primary">
                <svg
                  className="h-8 w-8 animate-success-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 13l4 4L19 7" pathLength={1} className="animate-success-path" />
                </svg>
                <span className="text-sm font-medium animate-count-swap">Saved</span>
              </div>
            </div>
          </SubSection>

          {/* count-swap */}
          <SubSection title="count-swap — 150ms, opacity crossfade (appearance only)">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCountSwapVal((v) => v + 1)}
                >
                  Increment
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-count-swap (key on value)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Inbox:</span>
                <span key={countSwapVal} className="text-sm font-medium tabular-nums animate-count-swap">
                  {countSwapVal}
                </span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                For something appearing or disappearing. A value changing in
                place uses MorphText below.
              </p>
            </div>
          </SubSection>

          {/* morph-text */}
          <SubSection title="morph-text — torph, value changing in place (RAD-341)">
            <div className="py-2">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <Button variant="outline" size="sm" onClick={() => setMorphVal((v) => v + 1)}>
                  Increment
                </Button>
                <Button variant="outline" size="sm" onClick={() => setMorphVal((v) => v + 999)}>
                  +999
                </Button>
                <Button variant="outline" size="sm" onClick={() => setMorphVal(1271)}>
                  Reset
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  components/ui/morph-text.tsx
                </span>
              </div>
              {/* The toolbar's heading row, reproduced: the count matches the
                  word's font size, not its weight. */}
              <div className="flex items-center gap-1 text-xl font-bold md:text-2xl">
                <span>Archive</span>
                <MorphText className="ml-2 font-normal tabular-nums text-muted-foreground" timing="fast">
                  {morphVal}
                </MorphText>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Inbox:</span>
                <MorphText timing="fast" coalesceMs={120}>
                  {morphVal}
                </MorphText>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Digits roll by place value. Single-line tokens only (the root is
                nowrap); a11y attributes stay on the parent; reduced motion is
                handled by the library.
              </p>
            </div>
          </SubSection>

          {/* log-fade-in */}
          <SubSection title="log-fade-in — 0.3s, translateY(4px)">
            <div className="py-2">
              <div className="flex items-center gap-3 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLogFadeKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  .animate-log-fade-in
                </span>
              </div>
              <div key={`lfi-${logFadeKey}`} className="space-y-1">
                {[
                  "items_fetched: 24 new items",
                  "material_created: AI chip supply shortage",
                  "material_created: New React framework released",
                  "feed_complete: 3 approved, 21 filtered",
                ].map((line, i) => (
                  <p
                    key={`${logFadeKey}-${i}`}
                    className="text-xs font-mono text-muted-foreground animate-log-fade-in"
                    style={{ animationDelay: `${i * 100}ms`, opacity: 0 }}
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </SubSection>

          {/* shimmer */}
          <SubSection title="shimmer — 3s infinite, gradient sweep">
            <div className="py-2">
              <span className="text-xs font-mono text-muted-foreground block mb-4">
                .animate-shimmer — background-clip: text
              </span>
              <p className="text-sm animate-shimmer">
                Parsing: Tech News Daily (3/5) — fetching new items...
              </p>
              <p className="text-base font-medium animate-shimmer mt-2">
                Processing 142 materials with AI filtering...
              </p>
            </div>
          </SubSection>

          {/* Stagger playground */}
          <SubSection title="Stagger Playground">
            <div className="py-2">
              <div className="flex flex-wrap items-center gap-4 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAnimKey((k) => k + 1)}
                >
                  Replay
                </Button>
                <div className="flex items-center gap-2">
                  <Label htmlFor="stagger-count" className="text-xs">Items</Label>
                  <Select
                    value={String(staggerCount)}
                    onValueChange={(v) => setStaggerCount(Number(v))}
                  >
                    <SelectTrigger className="w-20 h-8 text-xs" id="stagger-count">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[4, 6, 8, 12, 16].map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="stagger-interval" className="text-xs">Interval</Label>
                  <Select
                    value={String(staggerInterval)}
                    onValueChange={(v) => setStaggerInterval(Number(v))}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs" id="stagger-interval">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[25, 50, 75, 100, 150].map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}ms</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span className="text-xs text-muted-foreground">
                  Total: {Math.min((staggerCount - 1) * staggerInterval, 500)}ms (capped at 500ms)
                </span>
              </div>
              <div
                className="grid grid-cols-2 sm:grid-cols-4 gap-3"
                key={`stagger-${animKey}-${staggerCount}-${staggerInterval}`}
              >
                {Array.from({ length: staggerCount }, (_, i) => {
                  const delay = Math.min(i * staggerInterval, 500)
                  return (
                    <div
                      key={i}
                      className="will-animate animate-fade-in-scale"
                      style={{ animationDelay: `${delay}ms` }}
                    >
                      <Card>
                        <CardContent className="p-3 flex items-center justify-between">
                          <span className="text-xs font-mono text-muted-foreground">
                            {delay}ms
                          </span>
                          <span className="text-xs text-muted-foreground">
                            #{i + 1}
                          </span>
                        </CardContent>
                      </Card>
                    </div>
                  )
                })}
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* PROGRESS                                                           */}
      {/* ================================================================== */}
      <Section id="progress" title="Progress">
        <div className="space-y-8">
          <SubSection title="Progress Bar (Parsing UI)">
            {/* The processing card's own bar (RAD-356): pale rounded track, vivid
                rounded fill, width-only transition. Keep the two in step — this
                block is the reference for that card, not a lookalike. */}
            <div className="space-y-4 py-2">
              {[25, 60, 100].map((pct) => (
                <div key={pct}>
                  <p className="text-xs text-muted-foreground mb-1.5">{pct}%</p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
                    <div
                      className="h-full rounded-full bg-green-bright transition-[width] duration-300 ease-out"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </SubSection>

          <SubSection title="Parsing Results Summary">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
              <div className="rounded-md bg-primary/10 p-4">
                <p className="text-2xl font-bold text-primary">24</p>
                <p className="text-sm text-muted-foreground">Approved</p>
              </div>
              <div className="rounded-md bg-muted p-4">
                <p className="text-2xl font-bold">18</p>
                <p className="text-sm text-muted-foreground">Filtered</p>
              </div>
            </div>
          </SubSection>

          <SubSection title="Icon Size Reference">
            <div className="flex items-end gap-6 py-2">
              <div className="flex flex-col items-center gap-2">
                <Star className="h-[14px] w-[14px]" />
                <span className="text-xs text-muted-foreground font-mono">14px</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Star className="h-[16px] w-[16px]" />
                <span className="text-xs text-muted-foreground font-mono">16px</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Star className="h-[20px] w-[20px]" />
                <span className="text-xs text-muted-foreground font-mono">20px</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Star className="h-[24px] w-[24px]" />
                <span className="text-xs text-muted-foreground font-mono">24px</span>
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* LAYOUT EXAMPLES                                                    */}
      {/* ================================================================== */}
      <Section id="layout-examples" title="Layout Examples">
        <p className="text-sm text-muted-foreground mb-6">
          Real UI patterns showing background hierarchy: gray page bg → white cards → sage-3 inputs.
        </p>

        <div className="space-y-8">
          <SubSection title="Settings Form (card on background)">
            <Card className="p-6 space-y-6">
              <div>
                <h3 className="text-base font-semibold">Feed Settings</h3>
                <p className="text-sm text-muted-foreground mt-1">Configure how this feed is parsed and filtered.</p>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="layout-name">Feed Name</Label>
                  <Input id="layout-name" defaultValue="Tech News Daily" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="layout-url">Feed URL</Label>
                  <Input id="layout-url" defaultValue="https://technews.example.com/rss" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="layout-prompt">AI Prompt</Label>
                  <Textarea id="layout-prompt" defaultValue="Filter for articles about AI, design systems, and developer tools. Exclude listicles and sponsored content." rows={3} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="layout-auto">Auto-parse on creation</Label>
                  <Switch id="layout-auto" checked />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline">Cancel</Button>
                <Button>Save Changes</Button>
              </div>
            </Card>
          </SubSection>

          <SubSection title="Toolbar + Content (typical page layout)">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Posts</h3>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-[14px] w-[14px] mr-1.5" />
                    Export
                  </Button>
                  <Button size="sm">
                    <Plus className="h-[14px] w-[14px] mr-1.5" />
                    Add Feed
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Input placeholder="Search posts..." wrapperClassName="flex-1" />
                <Button variant="outline" size="icon" aria-label="Search">
                  <Search className="h-[16px] w-[16px] -scale-x-100" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <FilterChip active count={24}>Inbox</FilterChip>
                <FilterChip count={142}>Approved</FilterChip>
                <FilterChip count={87}>Filtered</FilterChip>
                <FilterChip count={12}>Archive</FilterChip>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card interactive>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-primary" />
                      <span className="text-xs text-muted-foreground">Approved · 87%</span>
                    </div>
                    <h4 className="font-semibold text-sm">Sample headline for a compact post card</h4>
                    <p className="text-xs text-muted-foreground">Tech News Daily · 28 Mar 2026</p>
                  </CardContent>
                </Card>
                <Card interactive>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-destructive" />
                      <span className="text-xs text-muted-foreground">Filtered · 34%</span>
                    </div>
                    <h4 className="font-semibold text-sm">15 JavaScript frameworks you don&apos;t need</h4>
                    <p className="text-xs text-muted-foreground">@design_channel · 27 Mar 2026</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </SubSection>

          <SubSection title="Alert / Status Block">
            <div className="space-y-3">
              <div className="rounded-lg bg-primary/10 p-4 flex items-start gap-3">
                <CheckCircle className="h-[16px] w-[16px] text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Parsing complete</p>
                  <p className="text-xs text-muted-foreground mt-1">24 approved, 18 filtered. No errors.</p>
                </div>
              </div>
              <div className="rounded-lg bg-destructive/10 p-4 flex items-start gap-3">
                <AlertCircle className="h-[16px] w-[16px] text-destructive mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-destructive">3 feeds failed</p>
                  <p className="text-xs text-muted-foreground mt-1">Connection timeout on Tech News, @ai_channel, AI Monitor.</p>
                </div>
              </div>
              <div className="rounded-lg bg-info/10 p-4 flex items-start gap-3">
                <Info className="h-[16px] w-[16px] text-info mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Tip</p>
                  <p className="text-xs text-muted-foreground mt-1">Add more feedback to improve AI accuracy. Like/dislike materials to teach the filter.</p>
                </div>
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ================================================================== */}
      {/* CONTENT PAGES                                                      */}
      {/* ================================================================== */}
      <Section id="content-pages" title="Content Pages">
        <p className="text-sm text-muted-foreground mb-6">
          Full-width content layouts: post detail, story detail.
        </p>

        <div className="space-y-8">
          <SubSection title="Post Detail Page">
            <Card>
              {/* Sticky top bar */}
              <div className="surface-mask-top bg-background/80 backdrop-blur-sm px-6 py-3 flex items-center">
                <Button variant="ghost" size="sm" className="-ml-2">
                  <FileText className="h-[16px] w-[16px] mr-2" />
                  Posts
                </Button>
              </div>

              {/* Article content */}
              <article className="px-6 py-6 space-y-5">
                {/* Status */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    <span className="text-sm text-muted-foreground">Approved</span>
                    <Badge variant="outline" size="sm">In Stories</Badge>
                  </div>
                  <span className="text-sm text-muted-foreground">92%</span>
                </div>

                {/* Title */}
                <h2 className="text-2xl font-bold tracking-tight leading-tight">
                  Northwind Design introduces AI-powered design systems that learn from your components
                </h2>

                {/* Meta */}
                <div className="flex items-center gap-3 text-sm text-muted-foreground/70">
                  <span className="hover:text-foreground cursor-pointer">Tech News Daily</span>
                  <span>·</span>
                  <span>28 March 2026, 14:30</span>
                </div>

                {/* Feedback */}
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" aria-label="Like">
                    <ThumbsUp className="h-[16px] w-[16px]" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Dislike">
                    <ThumbsDown className="h-[16px] w-[16px]" />
                  </Button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="ghost" size="sm">
                    <ExternalLink className="mr-2 h-[14px] w-[14px]" />
                    Open original
                  </Button>
                  <Button variant="ghost" size="sm">
                    <Send className="mr-2 h-[14px] w-[14px]" />
                    Send to Stories
                  </Button>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="mr-2 h-[14px] w-[14px]" />
                    Delete
                  </Button>
                </div>

                {/* AI Reasoning */}
                <div className="rounded-lg bg-secondary p-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AI Reasoning</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    This article covers AI-powered design systems, which directly relates to the
                    user&apos;s interest in design tools and AI integration. The content is original,
                    from a reputable source, and provides practical insights about a new Northwind Design
                    feature. Score: 92% confidence.
                  </p>
                </div>

                {/* Body text */}
                <div className="prose prose-sm max-w-none text-foreground">
                  <p className="leading-relaxed">
                    Northwind Design has announced a groundbreaking update to its design platform that
                    introduces AI-powered design system management. The new feature, called
                    &quot;Pattern Intelligence,&quot;
                    analyzes existing design tokens, spacing patterns, and component variants to
                    automatically suggest consistent designs across your team&apos;s projects.
                  </p>
                  <p className="leading-relaxed mt-4">
                    &quot;We&apos;ve trained our models on millions of design files to understand what makes
                    a design system cohesive,&quot; said the Northwind team. &quot;Pattern Intelligence
                    doesn&apos;t replace designers — it amplifies their decisions by ensuring consistency
                    at scale.&quot;
                  </p>
                  <p className="leading-relaxed mt-4">
                    Key features include automatic component suggestions based on existing patterns,
                    real-time consistency scoring, and a &quot;Design Debt&quot; dashboard that highlights
                    areas where designs diverge from established tokens. The update also integrates
                    with popular code generation tools, making the design-to-development handoff
                    more seamless.
                  </p>
                </div>
              </article>
            </Card>
          </SubSection>

          <SubSection title="Story Detail Page">
            <Card>
              {/* Top bar */}
              <div className="surface-mask-top bg-background/80 backdrop-blur-sm px-6 py-3 flex items-center justify-between">
                <Button variant="ghost" size="sm" className="-ml-2">
                  <FileText className="h-[16px] w-[16px] mr-2" />
                  Stories
                </Button>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm">
                    <ExternalLink className="h-[14px] w-[14px]" />
                  </Button>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="h-[14px] w-[14px]" />
                  </Button>
                </div>
              </div>

              <div className="px-6 py-6 space-y-6">
                {/* Rubrics */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge>AI &amp; ML</Badge>
                  <Badge>Design Tools</Badge>
                  <Badge variant="outline">3 sources</Badge>
                </div>

                {/* Title */}
                <h2 className="text-2xl font-bold tracking-tight leading-tight">
                  AI Design Tools Are Getting Smarter: Northwind Design and Rivals Race to Ship
                </h2>

                {/* Summary */}
                <div className="rounded-lg bg-secondary p-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Summary</p>
                  <p className="text-sm leading-relaxed">
                    Three design tool companies announced AI features this week. Northwind Design&apos;s
                    Pattern Intelligence analyzes existing patterns, a challenger studio launched an AI
                    layout generator, and a legacy suite vendor added generative paint inside its editor.
                    The convergence suggests AI-assisted design is becoming table stakes.
                  </p>
                </div>

                {/* Source Materials */}
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Source Materials</p>
                  <div className="space-y-2">
                    {[
                      { title: "Northwind Design introduces AI-powered design systems", source: "Tech News Daily", confidence: 92 },
                      { title: "Challenger studio launches AI layout generation", source: "@design_channel", confidence: 87 },
                      { title: "Legacy suite vendor adds generative paint to its editor", source: "AI Monitor", confidence: 78 },
                    ].map((m) => (
                      <div key={m.title} className="rounded-lg bg-secondary p-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{m.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{m.source}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="h-2 w-2 rounded-full bg-primary" />
                          <span className="text-xs text-muted-foreground">{m.confidence}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </SubSection>
        </div>
      </Section>

      {/* Footer */}
      <footer className="pt-8 pb-16">
        <p className="text-xs text-muted-foreground">
          Radaric Design System. Radix Colors (Sage + Green), 12-step semantic
          scale, Inter typeface, 44px touch targets, hierarchy through
          backgrounds. See{" "}
          <a
            href="https://www.radix-ui.com/colors"
            target="_blank"
            rel="noopener noreferrer"
            className="link"
          >
            radix-ui.com/colors
          </a>{" "}
          for palette reference.
        </p>
      </footer>
    </div>
  )
}
