# Design

Visual system for Radaric (design context). Full reference: [STYLING_GUIDE.md](STYLING_GUIDE.md). Strategy: [PRODUCT.md](PRODUCT.md).

## Theme

Green-forward product UI on a **white canvas**, light + dark. Calm, expert, precise; the tool disappears into the curator's task. Green is the brand and carries state — it is not decoration. Hierarchy comes from surface + hairline + soft elevation, never layout borders.

**Register:** product. **Color strategy:** restrained-to-committed — neutral surfaces, green as a deliberate accent that reads stronger *because* the canvas is clean.

## Color

Engine: Radix-derived green + neutral, hex tokens in `app/globals.css` (`@theme inline`).

- **Two greens.** `--primary` deep grass (`#1f8043` light / `#3fae5b` dark) for solid fills + text (AA). `--green-bright` vivid grass (`#34a85a` / `#46c46a`) for non-text accents and state (dots, progress, focus ring, switch, active tab, selection).
- **Tonal:** `--primary-subtle` + `--primary-subtle-foreground` for soft green chips/badges/selected rows; `--primary-emphasis` for green text on tints.
- **Surfaces:** white `--background`/`--card`; very-light `--secondary` (inputs) and `--muted` (callouts); gray `--sidebar` panel; `--accent` hover.
- **Hairline:** `--hairline` (~9% ink / ~8% white) — the 1px edge that defines cards/inputs/chrome.
- **Semantic:** `--destructive` `#d42a32`, `--info` `#0073cc`, `--warning` `#99590a`, each with a `*-subtle` tint. All AA as text and as fills.

## Typography

Inter 4, self-hosted, is the house face — and since RAD-363 it finally renders as designed: `cv11` + `ss01` (single-storey a, open digits) and the `opsz` Display cut that tightens headings on its own, none of which the Google-served build ever showed. Scale + weight for hierarchy; `tracking-tight` + `text-balance` on headings, `text-pretty` on prose. Reading prose reads at the ink — the post and story bodies carry `prose-ink`, never Tailwind Typography's lighter gray default. Reading width capped ~65–75ch (`max-w-[720px]` on detail pages).

**Four roles, one choice each.** The UI is set in Headings, Text, Counters and Tags, and a user picks a font per role (Settings → Appearance → Typography) from eleven: Inter, Martian Grotesk, PT Root UI, Golos Text, IBM Plex Sans, SF Pro, SF Pro Rounded, Martian Mono, JetBrains Mono, IBM Plex Mono, SF Mono — any font in any role. Presets Inter (the default), Martian, Apple, PT Root and Plex are one click; any other mix reads "Custom". SF is the device's own font, never shipped; a non-Apple device shows Inter (SF Mono → its own monospace) and says so in the picker. JetBrains Mono's code ligatures stay off in every role (the `-tag` feature-disable syntax in `design.ts`); IBM Plex Mono is a four-weight static face (400/500/600/700) served byte-for-byte as IBM publishes it.

**Any combination stays harmonious because the fonts are adapted, not merely swapped** (`lib/typography/derive.ts`, from metrics measured with fontTools): every face is normalised to Inter's x-height, so a body line looks the same size whichever font sets it; counters and uppercase are normalised to Inter's cap height where a face deviates; every face gets Inter's line box with caps centred, so rows and buttons do not shift; weights are stem-matched, so `font-semibold` is the same darkness in every font; tags in Martian Grotesk use its narrow cut, and its counters borrow tabular digits from Martian Mono because the Grotesk has none. Features and tracking factors are chosen per font (`lib/typography/design.ts`). Detail: [STYLING_GUIDE.md → Typography](STYLING_GUIDE.md#typography); live specimen under `/design-system` → Typography → Roles.

## Depth & shape

Soft elevation: `--shadow-card` (light = hairline ring + soft shadow; dark = outer ring + shadow). No top-edge highlight strip: emphasis comes from fill, shadow, rarely an outline. Radius `0.875rem` base, cards `rounded-xl` (18px), dialogs `rounded-2xl` (22px); the ladder is proportional, not evenly spaced — `xs` 6 / `sm` 8 / `md` 10 / `lg` 14 / `xl` 18 / `2xl` 22, with every control landing at roughly a quarter of its MEASURED height (0.22–0.31 across the set) (`--spacing` is `0.2rem`, so `h-10` is 32px, not 40) and square tiles taking the nearest rung to `0.2237 × edge`. Corners are a superellipse (k = 2.4, the house constant) on rectangles only; `rounded-full` keeps true circle and capsule geometry. `corner-shape` renders on no WebKit at all, so there the shape is a CSS mask: on surfaces it sits on a `::before` so the elevation `drop-shadow` on the host is not clipped by it, and every other rung — buttons, inputs, chips, badges, prose images — gets it directly from the `rounded-*` utilities, which carry both branches so every variant lands on its own element. A control's ring is painted on a masked `::after` (a box-shadow ring is cut off at the corners), focus rings sit inside the edge, and `Input`/`Textarea` draw on a `<span data-slot="field">` frame because a native control has no pseudo-elements. Anything with an outer shadow, a `border`, blur or a scroller is not masked yet and stays an arc on Safari. **No mask layer may be sized independently of its element:** the fill is one rectangle at `100% 100%` and only the four corner notches are absolute px, because a corner sized `calc(var(--sq-r) * 100)` is a ceiling past which the surface paints nothing (RAD-314). **The operator is `subtract`, never `exclude`/`xor`:** XOR equals subtraction only while the notches are disjoint, so under `2 × --sq-r` two of them cancel and the cut corner turns opaque. Masked surfaces drop `--shadow-card`'s 1px ring, because no box-shadow hairline survives a mask and the surface's one pseudo already carries the shape; `.corner-round` opts out where an outline carries meaning, and its paint lives in `@layer components` so the utilities it exists to preserve still win. **Never `overflow-hidden` on a masked surface:** an overflow clip follows `border-radius`, and an arc cuts more corner than the superellipse inside it, so the clip eats the shape — a child that must be clipped takes `.surface-mask` or `.surface-mask-top`. **Focus is an `outline`, never an inset ring:** the shape pseudo is a negative-`z` child and paints over anything the host draws itself. `.glow-primary` for brand moments.

## Motion

Four semantic curves (derived from transitions.dev / Jakub Antalik values): `--ease-snap` (structural movement), `--ease-bounce` (success-check confirmation only), `--ease-exit` (close/dismiss), `--ease-dismiss` (an element leaving for good — it accelerates away rather than decelerating into its own disappearance). `--ease-out-quart` aliases `--ease-snap` for backward compatibility. Duration scale: `--dur-fast` 150ms, `--dur-base` 200ms, `--dur-open` 250ms / `--dur-close` 150ms (asymmetric open/close), `--dur-slow` 300ms, `--dur-slower` 400ms (background reveals only, never interactive), `--dur-feedback` 350ms. Motion blur (2px) on modal entrance only. Bounce is reserved for the success check — never on structural transitions or navigation chrome. `prefers-reduced-motion` collapses everything. Native controls use `accent-color: var(--green-bright)`.

## Components

Solid-green primary `Button` (+ `tonal`); tonal `Badge`; elevated `Card`; hairline-defined inputs with green focus; green-tonal selected `FilterChip`; green `Switch`/`Tabs`; `EmptyState` with a green icon circle. shadcn/ui base. Icon sizes in pixels (14/16/20/24). Touch targets ≥ 44px. Live preview at `/design-system`.

## Accessibility

WCAG AA contrast on every surface (light + dark), verified at the token level. Color always paired with icon/label. Reduced-motion honored. Full keyboard focus (`ring-2 ring-ring`).
