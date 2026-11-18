# Radaric — Styling Guide

**Status:** Active

Green-forward design system on a white canvas. Tailwind CSS v4 (`@theme inline` in [app/globals.css](../app/globals.css)) + shadcn/ui. Live preview: `/design-system`.

---

## Principles

1. **Green is the brand, not decoration.** The accent carries identity and state (selected, active, progress, success, focus), used with intent rather than sprinkled.
2. **Hierarchy through surface, hairline, and elevation — not borders.** White cards separate from the white canvas via a 1px hairline + a soft shadow (the Notion model). The sidebar is a distinct gray panel.
3. **Two greens.** A deep grass for anything that touches text or needs AA on white; a vivid grass for non-text accents and state where contrast-with-white is not a text concern.
4. **The tool disappears into the task.** Density where it helps the curator; calm where the eye rests.
5. **WCAG AA everywhere**, light and dark. Color is never the only signal (always paired with an icon or label).

---

## Color System

Tokens are plain hex (sRGB), defined in `:root` (light) and `.dark`, mapped to Tailwind colors in `@theme inline`. Add a color by defining the CSS var in both themes, then mapping `--color-<name>: var(--<name>)` in `@theme inline`.

### The green model

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--primary` | `#1f8043` (deep grass) | `#3fae5b` (bright grass) | Solid fills (buttons, switch-off-state n/a), green **text** + icons. AA: white text on light, near-black text on dark. |
| `--primary-foreground` | `#ffffff` | `#0a1410` | Text/icon on a solid `--primary` fill. |
| `--primary-hover` / `--primary-active` | darker / darkest | brighter / brightest | Solid-fill hover / pressed. |
| `--primary-emphasis` | `#18713a` | `#6fd388` | Strongest green text on tinted/subtle backgrounds. |
| `--primary-subtle` | `#e2f1e6` | `#16291c` | Tonal green background (tonal buttons, default/success badges, selected chips, selected sidebar row). |
| `--primary-subtle-foreground` | `#18713a` | `#74d68c` | Text on `--primary-subtle`. |
| `--green-bright` | `#34a85a` | `#46c46a` | **Vivid accent, non-text only:** status dots, progress fills, focus ring, switch-on, active tab underline, selection. |
| `--link` / `--link-hover` | `--primary` / `--primary-active` | same | The link pair, **aliases not hexes** — a retuned primary keeps its links. Light deepens on hover (4.97:1 → 8.07:1 on white), dark brightens. See [Links](#links--utility-link-appglobalscss). |

**Rule of thumb:** green text → `--primary` (on white/canvas) or `--primary-emphasis` / `--primary-subtle-foreground` (on a tint). Green that the eye just *sees* (dots, bars, glows) → `--green-bright`. Never put `text-primary` on `--secondary` (fails AA by a hair); use a subtle surface instead. Same for links: a link never sits on `--primary-subtle` / `--secondary` / `--accent` (light contrast drops below AA); on such a tint it wears `link-on-tint`, which remaps the pair — the AI-not-configured banner is the worked example.

### Surfaces (white-canvas, layered)

| Token | Light | Dark | Role |
|-------|-------|------|------|
| `--background` | `#ffffff` | `#0e100f` | App content canvas (white). |
| `--card`, `--popover` | `#ffffff` | `#181a19` / `#1d1f1e` | Cards / floating surfaces. On light they separate from the canvas via hairline + shadow. |
| `--secondary` | `#f0f1f3` | `#1f2120` | Input/soft-fill background. Very light, clean. |
| `--muted` | `#f4f5f6` | `#1f2120` | Callout / plaque background (AI Reasoning, info boxes). Very light — distinct from white without mud. |
| `--accent` | `#e6e9e8` | `#282a29` | Hover background (rows, ghost buttons). |
| `--sidebar` | `#f0f1f1` | `#141615` | The chrome: a gray panel, distinct from white content. |
| `--sidebar-accent` | `#e2f1e6` | `#16291c` | Selected sidebar row — green tonal (brand through selection). |
| `--foreground` | `#181c1a` | `#e9ebea` | High-contrast text. |
| `--muted-foreground` | `#5b6361` | `#a1a8a4` | Low-contrast text (AA on every surface above). |

### Lines & hairlines

- `--hairline` (light `#16201a17` ≈ 9% ink / dark `#ffffff14` ≈ 8% white) — the 1px edge that makes cards, inputs, and chrome read. Use `ring-1 ring-inset ring-hairline` or `border-hairline`.
- `--border` / `--input` — neutral subtle separators (Separator component, occasional dividers).
- `--ring` = `--green-bright` — the focus ring color.

### Semantic state

`--destructive` `#d42a32`, `--info` `#0073cc`, `--warning` `#99590a` (all AA as text **and** as solid fills on light), `--success` = `--primary`. Each has a `*-subtle` tint for tonal badges and callouts (`bg-destructive-subtle text-destructive`, etc.). Dark variants are brightened.

---

## Elevation

**Masked surfaces** float via `--filter-card` / `--filter-card-hover`, a `drop-shadow` chain on the host — `drop-shadow` traces the masked alpha, so the shadow follows the squircle. **Unmasked** surfaces still use `--shadow-card` (and `--shadow-card-hover`) as `shadow-[var(--shadow-card)]`.

- **Light:** layered blur, and on a masked surface no ring at all — `drop-shadow` has no spread and no hairline survives a mask. **Never pay the missing ring back by deepening the blur.** Losing the spread already costs `--shadow-card`'s negative shrink, so matching its *alphas* alone yields a heavier shadow than the box-shadow path; deepening on top of that reads as a halo, not an edge. `--background` and `--card` are both `#ffffff`, so this shadow is the only separator a masked card has — weight belongs at `--shadow-card`'s own level (measured white-on-white against five candidates, 2026-09-11).
- **Dark:** separation is primarily a lightness step, `--card` (`#1c1f1d`) over `--background` (`#0e100f`), not an outline; `--filter-card` adds a tight contact shadow beneath it. On unmasked surfaces `--shadow-card` still carries a `#ffffff1a` outline (hover `#ffffff26`). Don't weaken either without checking a dense list.
- **`drop-shadow()` takes three values, never four.** Spread is Filter Effects Level 2 and no engine ships it (`CSS.supports` is false in Chrome 154). A fourth value makes the entire `filter` declaration invalid at computed-value time and the surface renders with **no** shadow — silently, with nothing in the console. The dark tokens did exactly that from 2026-09-09 to 2026-09-11. Copying a `box-shadow` into a `drop-shadow` is how it gets in.

No top-edge highlight strip anywhere. Emphasis is carried by fill, shadow, and — rarely — an outline; a lighter 1px line along the top of a surface is not part of this system.

`.glow-primary` is a soft green halo for emphasised brand moments. `.elevation-card` is the mask itself and paints no shadow — a replaced element (`<img>`) has no `::before`, so it is masked directly and its shadow moves one level up, to `.elevation-shadow` on the wrapper.

---

## Typography

**House face:** Inter 4, self-hosted (`app/fonts/inter.ts`, `next/font/local`; latin preloaded, cyrillic and extended subsets by `unicode-range`), `cv11` + `ss01` and the `opsz` Display cut. Since RAD-363 the dashboard is set in **four roles**, each a per-user font choice (Settings → Appearance → Typography; registry `lib/typography/fonts.ts`, eleven fonts — Inter, Martian Grotesk, PT Root UI, Golos Text, IBM Plex Sans, SF Pro, SF Pro Rounded, Martian Mono, JetBrains Mono, IBM Plex Mono, SF Mono — any font in any role). Every element belongs to exactly one role:

| Role | Selector | Carries |
|---|---|---|
| text | `body`, `.type-text`, `[data-sonner-toaster]` | body, buttons, menus, forms — the default |
| heading | `h1`–`h6`, `.type-heading` | page, card and dialog titles |
| tag | `.type-tag` | badges, chips, small labels |
| counter | `.type-counter`, `[data-numeric]` | counts, percentages, prices, versions, "n of m"; sets `tabular-nums` |

The primitives already carry their role — CardTitle / DialogTitle / AlertDialogTitle / SheetTitle are `type-heading`; Badge, FilterChip, SelectLabel, DropdownMenuLabel / Shortcut are `type-tag`; MorphNumber and a numeric MorphText are `type-counter`. Role rules live in `@layer base` (`app/globals.css`); the per-font values they read (`--type-<role>-*`) are remapped by one unlayered `<style data-radaric-typography>` from `TypographyProvider`, so a choice repaints the page without a navigation. Only the `(dashboard)` route group is themed; landing, auth and onboarding always render house Inter.

- **Classification:** a quantity gets `type-counter`; **dates and times keep `tabular-nums` but stay in the text font** — a timestamp is read as words, not compared as a figure. A sentence containing a number gets the class on the number only, never on the sentence.
- **Weights are logical.** `font-*` utilities set `--type-w`; each element maps it through its own font (`calc(var(--type-w) * var(--type-wa) + var(--type-wb))`, stem-matched to Inter). Never hard-code a numeric `font-weight` in CSS.
- **Tracking scales by font.** Negative (display) tracking multiplies by `--type-df`, positive (caps) tracking by `--type-cf`; `tracking-tight`/`tracking-wide` already do. A new em literal is written `tracking-[calc(-0.01em*var(--type-df,1))]` or `tracking-[calc(0.06em*var(--type-cf,1))]`. Inter's display factor is 0.25 because its Display cut already tightens headings (`lib/typography/design.ts`).
- **`uppercase`** adds the `"case"` feature and the caps size-adjust; never toggle it off with a variant (`uppercase md:normal-case`) — `normal-case` does not undo them.
- **Code faces are not a role.** `code, kbd, pre, samp` and `font-mono` reset the map to identity.
- **`prose-ink`** re-expresses Tailwind Typography's weights through the map at (0,2,0), so a `prose-headings:` / `prose-strong:` weight variant beside it needs `!` (`prose-headings:font-semibold!`).
- Hierarchy through scale + weight; headings `font-semibold`/`font-bold` with `tracking-tight`, `text-balance` on h1–h3, `text-pretty` on prose.
- Body prose capped to a comfortable measure (~65–75ch); long-form detail pages use `max-w-[720px]`.
- **Reading prose reads at the ink.** The post and story bodies carry `prose-ink`, which points Tailwind Typography's `--tw-prose-body` (and its invert twin) at `--foreground` — the library's gray-700 default is a step lighter than the headline and costs legibility at reading length.

**Adding a font.** Files + `OFL.txt` under `app/fonts/<family>/`; source, version and sha256 in `app/fonts/SOURCES.md`; a registry entry in `lib/typography/fonts.ts` and a `DESIGN` entry in `lib/typography/design.ts`; the face in `scripts/typography/measure-fonts.py`, then run it (`lib/typography/font-metrics.json`) and `node --import tsx scripts/typography/build-css.ts` (`app/fonts/fonts.css`, `app/typography.css`); `vitest` guards the metrics hash, the generated CSS and the registry order. Then look at it on the typography harness (owner-only, not part of this repository).

- **Static faces.** A font that ships one file per weight (IBM Plex Mono: Regular/Medium/SemiBold/Bold) is declared as `{"static": {400: [...], 500: [...], 600: [...], 700: [...]}}` instead of `files`. Metrics, widths and figures are measured from the 400 file; `stems` come from each weight's own file; the JSON carries `"static": true`, `axes.wght = [min, 400, max]` and a `weight` on every file entry. `weightMap` is the identity (the browser's font matching sends each computed weight to its own file), and `resolveWeight` clamps to the axis then snaps to the nearest shipped weight. The generated CSS emits one `@font-face` per file with a single-value `font-weight` and no `font-stretch` (there is no `wdth` axis).
- **Disabling a feature.** A `DESIGN.features` entry prefixed with `-` is emitted as `"<tag>" 0` — JetBrains Mono carries `["kern", "-calt"]` so its code ligatures stay off in every role. `uppercase` composes on top (`var(--type-features), "case"`).
- **Licensing.** SF fonts are system-only (Apple licence) and never shipped. PT Root UI and IBM Plex (Sans and Mono) are served **byte-for-byte** as upstream publishes them — no subsetting, no conversion, no re-encoding, no renaming inside the font — because they carry Reserved Font Names ("PT Root UI VF", "Plex"); the `@font-face` family is our own alias ("Radaric …"), which only names the CSS face. IBM Plex Sans ships IBM's six official Roman splits (Latin1 first in the file list: metrics are read from the first file) so `unicode-range` downloads only the scripts a page needs. A font without a reserved name (Golos Text) may be converted and subset — record both the source and shipped hashes in `SOURCES.md`.

---

## Radius, corners, motion

- `--radius: 0.875rem` (14px) — the SURFACE anchor; derived `radius-xs` 6 / `sm` 8 / `md` 10
  / `lg` 14 / `xl` 18 / `2xl` 22. Badges, counters and tags `xs`; buttons, inputs, selects,
  textareas and menu items `sm`; large + icon buttons, nav rows and 44–51px tiles `md`;
  popovers, menus and nested panels `lg`; cards and panels `xl`; dialogs and sheets `2xl`.
- **A radius is proportional to its element, and the element is measured, not named.**
  Controls land at roughly a quarter of their height — 0.22–0.31 across the set, the two
  ends being the smallest badges (`xs` 6 on a 19px box = 0.31, there is no rung below 6)
  and rows held open by `min-h-[36px]` (0.22). `--spacing` is `0.2rem` here, so
  `h-8` is 25.6px, `h-10` is 32, `h-11` is 35.2, `h-12` is 38.4, `h-16` is 51.2 and `h-20`
  is 64 — sizing a corner off the Tailwind name instead of the rendered box is how a 32px
  button ended up wearing the corner of a 40px one. Square tiles take the nearest rung to
  `0.2237 × edge`; a nested block also stays concentric with its parent (inner ≈ outer −
  padding), which is why a field inside a `rounded-xl` card sits on `sm`, not `lg`.
- **One shape exponent, only the radius scales.** `k` is 2.4 for every element. Two
  exponents would make a badge and a card different *shapes* rather than the same shape at
  two sizes.
- **Superellipse corners**, `--corner-k: 2.4` — the house constant. It ships
  two ways, because `corner-shape` renders on
  **no WebKit at all** (`CSS.supports` is false in every syntax, measured in WKWebView on
  the Safari 26.6.1 engine, 2026-09-09):
  - **Surfaces** — cards, source-type tiles, icon tiles, figure images — are shaped by a
    CSS mask: one rectangle stretched to `100% 100%`, minus four fixed-size SVG corner
    notches. Cross-engine, and the geometry is identical everywhere: measured 45° bite
    8.40px against 8.51 predicted for k=2.4 and 9.94 for an arc. Regenerate the art with
    `node scripts/gen-superellipse.mjs 2.4 24`.
  - **Every other rung** — buttons, inputs, chips, badges, menu items, prose images and
    video — gets the same shape from the `rounded-*` utilities themselves (`@utility
    rounded-*` at the end of `app/globals.css`): `corner-shape` where the engine has it,
    the same notch mask applied directly where it does not. Until 2026-09-13 these stayed
    plain arcs on Safari on the theory that at 6–10px nothing is lost; on a 44px square
    button at dpr 3, beside squircle cards, it is (seen on the posts toolbar). The
    shape lives INSIDE the utility rather than on a `[class*="rounded-"]` match, because
    that matches the class attribute, not the element a variant targets —
    `prose-img:rounded-lg` sits on the article, `sm:rounded-2xl` on a dialog that is
    full-bleed on a phone. Pinned on Tailwind's compiled output by
    `__tests__/squircle-utilities.test.ts`.
  - **Not yet masked on WebKit**, and still an arc there: anything with a `shadow-*` (a
    mask deletes an outer shadow — except a Button, which gives up its 1px drop shadow on
    WebKit), a `border`, `backdrop-blur`, a scroller, a native `<input>`/`<textarea>`, a
    drawn surface, or a host that contains one of those or an embed. Overlays (popover,
    menu, select, dialog, sheet, toast) are all in this set; they move onto a lifted
    construction separately.
  - **Known difference between the engines:** the notch art is the superellipse with
    exponent 2.4, while Chromium's `superellipse(2.4)` uses exponent 2^2.4 ≈ 5.3, so
    Chrome's corners are squarer than Safari's at every rung. Measured 45° bite at 8px,
    dpr 4: 1.25px Chromium, 2.7–3.1px WebKit mask, 3.4–3.75px arc (2026-09-13). It predates
    this work (#103) and is the same on surfaces and controls; matching the two is a design
    decision, not a bug fix.
- **A mask and a `filter` on the SAME element cancel out.** Masking is applied after
  filtering in the rendering model, so a `drop-shadow` is generated and then clipped away
  by the very mask that shaped it — the element renders with no shadow at all. So the mask
  goes on a `::before` that carries the background, and the filter stays on the host, which
  gives a shadow that traces the masked alpha and therefore follows the squircle. It also
  means the mask no longer clips the card's CONTENT, so a badge may overhang again.
  `isolation: isolate` is required on the host: the pseudo sits at `z-index: -1`, and
  without a stacking context on the host that `-1` escapes behind the nearest ancestor's
  background. `filter` happens to create one too, but it must not be the only thing doing
  so — `.corner-round` sets `filter: none`. A replaced element (`<img>`) has no
  `::before`, so it is masked directly and its shadow moves one level up, to
  `.elevation-shadow`.
- **No box-shadow, border or filter hairline survives a mask.** An inset ring follows
  `border-radius`, which the mask zeroes, so it draws a square and the mask cuts its
  corners off; an outer ring is clipped away entirely; a 4× `drop-shadow` chain renders
  nothing, and a border-box gradient ring fades out through the curve — all measured in
  WebKit. **A painted ring does survive**, and controls use it: an `::after` at `inset: 0`
  with `padding` equal to the ring width, filled with `--tw-ring-color`, masked to the
  border box minus the content box's own squircle (four notches one ring-width smaller,
  `add ×4, subtract, add`), and clipped on the outside by the host's mask. Rays from the
  corner centre that miss every ring pixel, of 31: 9 / 13 / 17 for a box-shadow ring at r
  = 8 / 14 / 22, 0 / 0 / 0 painted — identical in both engines. The pseudo must declare
  `--tw-ring-color: inherit`: Tailwind registers it `inherits: false`, and without that the
  ring paints nothing. Its width comes from the same ring classes and states
  (`--sq-ring-w`), because Tailwind composes the width into `--tw-ring-shadow` and exposes
  it nowhere.
- Surfaces keep dropping the ring: their shape is already an `::before`, so there is no
  pseudo left to paint one on.
  `--shadow-card`'s leading 1px ring is therefore dropped on masked surfaces, and its work
  handed to deeper blur layers in light and to a lightness step on `--card` in dark. A card
  whose outline carries MEANING (recommended plan, destructive warning) takes
  `.corner-round`, which turns the mask off and keeps the ring — and whose paint
  declarations therefore live in `@layer components`, not `utilities`: at `(0,2,0)` in the
  utilities layer it outranks the `bg-*` / `ring-*` utilities the call site is asking for
  and silently deletes them. **Only the paint moves.** `.corner-round`'s `filter: none`
  must stay in `@layer utilities`, because the rule it exists to beat —
  `.surface-card { filter: var(--filter-card) }` — is there too; follow the paint down to
  `components` and it loses to every rule in `utilities`, and the drop-shadow comes back on
  a surface that has no mask for it to trace. Layers cut BOTH ways, so a rule is only ever
  correct relative to what it must outrank. Nothing renders differently at the call site
  and no computed-style probe reports it — the layer guard in
  `__tests__/squircle-mask.test.ts` is the only thing that catches it.
- **Never `overflow-hidden` on a masked surface.** An overflow clip follows
  `border-radius` — an arc — and an arc cuts MORE corner than the superellipse inside it,
  so the clip eats the host's own `::before` and the squircle disappears. Measured on an
  18px rung at dpr 4: 4.5px boundary masked in both engines (superellipse predicts 4.51),
  5.5px in WebKit through an `overflow-hidden` host (an arc predicts 5.27) and a near
  square corner in Chromium. A child that has to be clipped takes `.surface-mask` (it
  spans the whole host, e.g. an absolutely positioned glow) or `.surface-mask-top` (a band
  flush with the top edge, e.g. a full-bleed cover image); both inherit `--sq-*` and
  `--sq-r`, so they follow the host's rung.
- **The focus ring is an `outline`, never an inset `box-shadow`.** The pseudo is a
  negative-`z` child, and a negative-`z` child paints AFTER the host's own background and
  box-shadow, so an inset ring is drawn and then covered — computed style says the ring is
  there, the screen is blank. Outlines paint last of all; `outline-offset: -2px` keeps the
  ring inside the box, where an outer ring would be cut off by the mask. Controls shaped
  by the utilities work the other way round: `focus-visible:ring-inset` everywhere, and on
  WebKit the ring is repainted on the masked `::after` while the outline is made
  transparent (an outline is clipped by a mask like everything outside the box). Forced
  colours strip backgrounds and would take the painted ring with them, so there the mask
  is dropped and the outline returns.
- **`Input` and `Textarea` are a frame around the native control.** A native control has
  no pseudo-elements, so `<span data-slot="field">` carries the rung, the fill and the
  ring (`focus-within:`), and the control inside is transparent. `className`, the ref,
  `id`/`htmlFor`, `register()` spreads and every attribute still reach the native element;
  outer sizing (`flex-1`, grid placement) goes on `wrapperClassName`. `range`, `checkbox`,
  `radio`, `hidden`, `file` and `color` render unwrapped. **An absolutely positioned icon
  that comes BEFORE the field in the DOM needs `z-10`:** the frame is positioned, and a
  later positioned sibling paints over an earlier one (the search icon on `/posts` went
  blank this way).
- **No mask layer may be sized independently of its element.** The fill layer is
  `100% 100%`; only the four corner notches carry an absolute length. What this replaced
  sized all four layers `calc(var(--sq-r) * 100)` and intersected them — a fixed 1800px at
  the `xl` rung, so an element taller than that painted only the band
  `[height − 1800, 1800]` and one taller than 3600px painted nothing at all, with every
  test green because nothing in the repo rendered anything. Radaric caught it before
  merging (RAD-314). Guarded by `__tests__/squircle-mask.test.ts`.
- **The operator is `subtract`, never `exclude`/`xor`.** XOR is the obvious spelling and
  renders identically — until an element is narrower or shorter than `2 × --sq-r`, at which
  point two notches overlap, the first cancels the region to 0 and the second brings it
  back to 1, and the cut corner renders **opaque**. Measured in both engines at 20×20 with
  `--sq-r: 18px`: 48 pixels wrong, max delta 243/255; identical at exactly `2 × --sq-r`.
- **`border-radius: 0` is mandatory wherever the mask paints directly.** An arc cuts more
  corner than the superellipse inside it, so a surviving radius clips the notch away and
  the mask becomes invisible.
- **The SURFACE rungs are sized to make the shape visible.** A superellipse and a circular
  arc are pixel-identical at 8px and only diverge around 18px, so the character is carried
  by `xl` 18 and `2xl` 22. Do not shrink those without removing the corner system too —
  they are one decision. The control rungs are the opposite case: at 6–10px there is no
  visible superellipse to lose, so they are free to follow proportion instead.
- **Rectangles only.** Only the rung utilities carry the shape — `rounded`, `rounded-xs` …
  `rounded-2xl`, the directional `rounded-t-*` / `-b-*` / `-l-*` / `-r-*`, arbitrary lengths
  — each setting its own corners' `--sq-*-r`; `rounded-none` zeroes them and `rounded-full`
  sets none. A superellipse is a rectangle treatment; applied to `border-radius: 9999px` it turns avatars into app-icon
  squircles and pills into flat-sided lozenges. `rounded-full` therefore keeps true circle
  and capsule geometry, and `.corner-round` is the per-element opt-out for both systems.
- **Square icon tiles** use `.icon-tile` with `--tile-size`, which derives the radius from
  the iOS app-icon ratio (`--icon-radius-ratio: 0.2237` × size) so a 24px and a 48px tile
  read as the same shape. Fixed tokens cannot do this. It feeds `--sq-r` (the mask), not
  `border-radius`.
- **Motion** (derived from [transitions.dev](https://transitions.dev) / Jakub Antalik):
  - **Curves:** `--ease-snap` (`cubic-bezier(0.22, 1, 0.36, 1)`) — primary structural. `--ease-bounce` (`cubic-bezier(0.34, 1.36, 0.64, 1)`) — success-check confirmation ONLY. `--ease-exit` (`cubic-bezier(0.4, 0, 0.2, 1)`) — close/dismiss, symmetric. `--ease-dismiss` (`cubic-bezier(0.4, 0, 1, 1)`) — an element **leaving for good**, accelerating away; distinct from `--ease-exit` because a thing that is departing should not decelerate into its own disappearance. `--ease-out-quart` aliases `--ease-snap`.
  - **Durations:** `--dur-fast` 150ms · `--dur-base` 200ms · `--dur-open` 250ms · `--dur-close` 150ms · `--dur-slow` 300ms · `--dur-slower` 400ms (background reveals only) · `--dur-feedback` 350ms.
  - **Motion blur:** `--motion-blur: 2px` — single callsite: modal entrance (`fadeInScale`). Never on staggered lists or large-travel sheets.
  - **Utilities:** `.animate-shake` (input rejection) · `.animate-icon-pop` (like/dislike) · `.animate-success-check` + `.animate-success-path` (SVG check draw) · `.animate-count-swap` (opacity crossfade — appearance/disappearance only).
  - **Value morphing (RAD-341):** `components/ui/morph-text.tsx` wraps [torph](https://torph.lochie.me) and is the continuity primitive for a value that changes **in place** — counters, badges, short labels. `timing="fast"` (150ms) for streamed values / `"base"` (200ms) otherwise, both on `--ease-snap`, no scale, reduced motion handled by the library, `coalesceMs` where a stream drives the value. Single-line tokens only (the root is `nowrap`), a11y attributes stay on the parent, and it is the only module allowed to import torph (`__tests__/torph-import-hygiene.test.ts`). The opacity crossfade stays for things appearing or disappearing — the two do different jobs. Do not put a morph root on a line that carries another multi-digit number: torph's per-character boxes make its own advance approximate (RAD-353).
  - **Number rolling (RAD-355):** `components/ui/morph-number.tsx` wraps [NumberFlow](https://number-flow.barvan.me) for a **number** that changes in place where the digits themselves must stay put — the processing summary's counts, where two numbers share a line and are compared with each other. NumberFlow measures each digit and rolls it inside a masked slot, so the spacing inside the number does not move; measured at DPR 2 against plain text, its glyph columns and rows matched exactly, settled and after an update. It renders plain text wherever the engine cannot roll (SSR, first render, jsdom, reduced motion) and pairs with a plain `sr-only` twin, because its shadow DOM exposes the digits individually. `.morph-number` in `globals.css` carries the two line-box overrides this needs. It is the only module allowed to import `@number-flow/react`.
  - **Enter/exit animations:** `tw-animate-css` (pure CSS import, replaces deprecated `tailwindcss-animate`). Provides `animate-in`/`animate-out`, `fade-in-0`/`fade-out-0`, `zoom-in-95`/`zoom-out-95`, `slide-in-from-*`/`slide-out-to-*`, `animate-accordion-down`/`animate-accordion-up`.
  - **Token syntax in Tailwind v4:** always use `var()` wrapper in arbitrary values: `duration-[var(--dur-open)]`, `ease-[var(--ease-snap)]`. Bare `duration-[--dur-open]` compiles to invalid CSS.
  - **Tokens from JavaScript:** `lib/motion.ts` (`getMotionTokens()`) resolves `--dur-*` / `--ease-*` off the document root, memoised. **Any JS-driven (WAAPI) animation must read tokens through it, never copy the value** — the Posts grid previously hard-coded `setTimeout(..., 330)` against `--dur-slow: 300ms`, in four places, kept in sync by nothing. It also exposes `prefersReducedMotion()`, which WAAPI needs because the CSS guard below cannot reach a JS-started animation.
  - **Grid reflow:** `components/materials/animated-grid.tsx` animates enter, exit **and sibling reflow** for the Posts / per-source grid. Removing a card doesn't snap the survivors: the departing card is pinned out of flow at its last rect and faded, while the neighbours FLIP into their new positions. Both **start** on the same frame; they deliberately do not **end** together.
    - **Exit** — `--dur-base` (200ms) on `--ease-dismiss`, scale to `0.85`. Short and decisive, because it clears the frame before the siblings settle.
    - **Sibling reflow** — a spring, not an eased curve: `REFLOW_SPRING` in `lib/motion.ts` (`stiffness 400, damping 30`, damping ratio 0.75), settling around 390ms with a ~3% overshoot. What the eye reads is the *start*: the old `--ease-snap` reflow was 51% of the way there after 40ms, the spring is at 21% — across a wide grid that is the difference between a card being flung and one being carried. Carried as a CSS `linear()` easing (`springEasing()`) so each card keeps a two-keyframe transform instead of ~60 sampled keyframes; falls back to `--ease-snap` / `--dur-slow` where `linear()` is unsupported.
    - Survivors only ever translate, never scale, so there's no text stretching or border-radius correction to worry about. Reflow is skipped above 200 survivors (a filter switch replaces the whole set and reads better as a clean cut) and outside the viewport ±1 screen. The pinned exit wrapper sets `box-sizing: border-box` explicitly — its width comes from a border-box measurement, so an ambient `content-box` would make the departing card flare by its own padding + border.
    - Sequencing follows Koch: the thing the user acted on responds first, the surrounding layout adapts, the system settles.
  - **Rule:** `--ease-bounce` = confirmation feedback only (success check). Never on structural transitions or navigation chrome. Motion-blur = single low-travel surface entrances only (modal).
  - **`prefers-reduced-motion` collapses every animation/transition** (global guard in `@layer base`) — **durations *and* delays**. Collapsing only the duration leaves a staggered entrance staggered: nothing moves, but the grid still reveals itself card by card across the `Math.min(index * 50, 500)` ladder — 700ms end to end with `--dur-base` — which is the motion the setting asks to remove. `!important` on `*` is what makes it reach: the `.delay-*` ladder and the `.animate-*` classes are in `@layer utilities`, a **later** layer than the guard, and the stagger itself is inline (`animationDelay` in AnimatedGrid and the stories list). The delay collapses to `-1ms`, not `0.01ms` — a positive delay leaves the animation at `currentTime: 0` for one painted frame, so `.will-animate`'s `opacity: 0` blinks the whole grid before it appears. Guarded by `__tests__/reduced-motion-guard.test.ts` (source shape) and a real-engine check in Chromium and WebKit (owner-only harness, not part of this repository). Consequence worth knowing: `/design-system`'s stagger demo still prints its per-card `0ms…500ms` labels while the cards all appear at once — a demo of motion is not exempt from the setting. Native controls adopt the brand via `accent-color: var(--green-bright)`.

---

## Components

### Button (`components/ui/button.tsx`)
- `default` — **solid green** primary action (`bg-primary text-primary-foreground`) with a soft drop shadow; no inset top-highlight.
- `tonal` — soft green (`bg-primary-subtle text-primary-subtle-foreground`) for secondary green actions.
- `secondary` — neutral fill. `outline` — transparent + 1px `ring-border`. `ghost` — hover-only.
- `destructive` — inline ghost-red (list rows). `destructive-solid` — solid red (dialogs only).
- `link` — the shared link treatment below (green, ruled, deepening on hover); still a control, so it keeps the inset focus ring, not the link outline, and its own transition pair so the rule fades with the text — colour + rule at `--dur-fast` / `--ease-snap`, declared in the variant so they sort after the base's `duration-150` / `ease-[var(--ease-out-quart)]` (emission-order assertion in `__tests__/link-treatment.test.tsx`).
- Optional `loading` prop (spinner + disabled). Focus: `ring-2 ring-ring/55`. Sizes `sm/default/lg/icon/icon-sm`.

### Links — `@utility link` (`app/globals.css`)
One treatment, ported from IDS (RAD-366), worn bare (`className="link"`) or by a prose container (`[&_a]:link`): `--link` green, always underlined, the rule a 20% tint of the link's own colour (`color-mix(in oklab, currentColor 20%, transparent)`) at thickness 1px, offset 0.2em, `text-decoration-skip-ink: none` so the rule runs unbroken under descenders. Hover deepens to `--link-hover` instantly (`:hover` sets `transition-duration: 0s`, wrapped in `@media (hover: hover)` — a raw `&:hover` in a custom utility is not media-gated like Tailwind's `hover:` variant) and the return fades over `--dur-fast` / `--ease-snap`. Focus-visible is a 2px `--ring` outline at offset 2px, written `&:where(:focus-visible)` so a Button keeps its inset ring by specificity. No `:visited`, no `:active` (IDS parity). Weight is not the utility's business: Typography keeps its link at 500 in prose, and a headline resets it to inherit (`[&_a]:[font-weight:inherit]`).
Where it lands: prose containers (post, story, detail dialog, living answer), the Telegram-entity and derived-title link renderers (compact card excerpts keep their quiet hover), the Button `link` variant, auth/legal/landing/settings/billing/feed-card links, the story source / related-coverage / extracted-URL links, the media chip, the landing footer. Deliberately left quiet: muted card chrome — feed names, bylines, saved-excerpt meta — the list cards' headline links (story cards `hover:text-primary-emphasis`, grid cards `hover:text-primary` — the card-title affordance stays theirs), the collapsed-quote “Show more / Show less” toggle, the accordion trigger and the queue filters.
A link that must sit on a tint wears `link-on-tint` beside `link` (RAD-366): the pair remaps to `--primary-emphasis` / `--primary-active`, and the dark hover to `--primary-subtle-foreground` so the step keeps its direction per theme; the dark override is class-scoped (`.dark &`) inside the utility rather than a `dark:` utility, so the pair stays one declaration set. Worked example: the AI-not-configured banner on `--secondary`.
Two cascade facts, both pinned by `__tests__/link-treatment.test.tsx`: a custom utility carries no order advantage, and the core colour/decoration utilities sort *after* it, so a leftover `text-primary` / `underline-offset-*` / `transition-colors` on a converted element silently wins — the old classes are deleted, not joined. And on a prose container `[&_a]:link` compiles to a descendant selector at (0,1,1), which beats Typography's `.prose :where(a)` at (0,1,0) by specificity, not by layer — the plugin emits into the same utilities layer.

### Badge — tonal by default (`bg-primary-subtle text-primary-subtle-foreground`); `solid`, `secondary`, `destructive`, `info`, `warning`, `outline` (ring), `subtle`. `rounded-xs` (`rounded-md` at `size="lg"`, which is 44px tall), never `rounded-full`.

### Card — `rounded-xl bg-card` + `shadow-[var(--shadow-card)]`. `interactive` lifts on hover (`-translate-y-0.5` + stronger shadow) and gains a focus ring. No clip-path (so shadows show).

### Inputs (Input / Textarea / Select) — `bg-secondary` + `ring-1 ring-inset ring-hairline` (defined edge) + `focus-visible:ring-2 ring-ring/60` + `focus:bg-card`. Select check mark is green.

### Tabs — underline only (no rail border); active = `border-green-bright` + `text-foreground` + `font-semibold`.

### FilterChip — selected status chips are **green tonal** (green = active filter); source-type chips keep their brand accent via `accentColor`.

### Switch — `--green-bright` track when on, white thumb. **EmptyState** — `bg-card` + shadow, green-tonal icon circle, `--green-bright` count badge.

### Sidebar — selected source row: `bg-sidebar-accent` (green tonal) + a 2px `inset 2px 0 0 var(--green-bright)` leading-edge bar. (Previously `hsl(var(--primary))` which never rendered — `--primary` is hex.)

---

## Icon sizes

Always pixel values, never Tailwind scale (`h-4`): **14px** badges/inline, **16px** buttons/nav/actions, **20px** large standalone, **24px** feed-type cards.

---

## Checklist: new component

- [ ] Uses tokens (no hard-coded colors)
- [ ] Tested in light **and** dark
- [ ] Hierarchy via surface / hairline / elevation, not layout borders
- [ ] Green text uses `--primary` (on white) or `--primary-emphasis` (on tint); vivid accents use `--green-bright`
- [ ] Focus: `ring-2 ring-ring/55–60`
- [ ] Icon sizes in pixels; touch targets ≥ 44px
- [ ] Quantities carry `type-counter`; dates and times `tabular-nums` only (text font); no numeric `font-weight` in CSS
- [ ] Non-interactive elements have no focus ring; icon-only buttons have `aria-label`
- [ ] Contrast ≥ AA (verify text on the actual surface)

---

**References:** [Radix Colors](https://www.radix-ui.com/colors) (green source) · [Tailwind v4](https://tailwindcss.com/docs) · [shadcn/ui](https://ui.shadcn.com/)
