/**
 * Typography design parameters (RAD-363) — the per-font choices that are not
 * measured: OpenType features, display/caps tracking factors, text leading.
 * Starting values, to be tuned on the visual matrix; not measurements.
 */
import type { FontId } from "./fonts"

export interface FontDesign {
  features: readonly string[]
  displayTracking: number
  capsTracking: number
  textLeading: number
}

/*
 * Inter's displayTracking is 0.25, not 1: the self-hosted Inter 4 keeps its
 * `opsz` axis, and with `font-optical-sizing: auto` its Display cut already
 * tightens text by itself — measured −0.011em per glyph at 20px, −0.018em at
 * 24px, −0.033em at 32px (wght 600). The call sites' −0.02/−0.025em were
 * written for the old opsz-less Inter; at 1 they would double up. 0.25 keeps
 * `tracking-tight` at text-2xl, the commonest heading, where it was:
 * −0.025 × 0.25 − 0.018 ≈ −0.024em.
 *
 * Martian Grotesk counters draw their digits from the Martian Mono Figures
 * face, whose weight axis stops at 800; a counter at font-extrabold or heavier
 * would set its letters above the digits' ceiling. No call site does.
 */
export const DESIGN: Record<FontId, FontDesign> = {
  inter: { features: ["cv11", "ss01"], displayTracking: 0.25, capsTracking: 1, textLeading: 1 },
  "martian-grotesk": { features: ["kern"], displayTracking: 1, capsTracking: 0.8, textLeading: 1 },
  "pt-root-ui": { features: ["kern"], displayTracking: 0.8, capsTracking: 1, textLeading: 1 },
  "golos-text": { features: ["kern"], displayTracking: 0.8, capsTracking: 1, textLeading: 1 },
  "ibm-plex-sans": { features: ["kern"], displayTracking: 0.8, capsTracking: 1, textLeading: 1 },
  "sf-pro": { features: ["kern"], displayTracking: 0.6, capsTracking: 1, textLeading: 1 },
  "sf-pro-rounded": { features: ["kern"], displayTracking: 0.6, capsTracking: 1, textLeading: 1 },
  "martian-mono": { features: ["kern"], displayTracking: 0.4, capsTracking: 0.5, textLeading: 1.04 },
  // `calt` is JetBrains Mono's code-ligature feature (`->`, `!=`, `===`, `<=`, `//`);
  // a `-tag` disables it, so counters and text read as typed characters.
  "jetbrains-mono": { features: ["kern", "-calt"], displayTracking: 0.4, capsTracking: 0.5, textLeading: 1.04 },
  "ibm-plex-mono": { features: ["kern"], displayTracking: 0.4, capsTracking: 0.5, textLeading: 1.04 },
  "sf-mono": { features: ["kern"], displayTracking: 0.4, capsTracking: 0.5, textLeading: 1.04 },
}
