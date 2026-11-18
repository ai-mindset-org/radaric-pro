/**
 * club 2.0 x AI Mindset theme fonts (branch club20-theme).
 *
 * Playfair Display carries headings, Unbounded carries UI labels (buttons,
 * navigation, tags). Meta and counters reuse the self-hosted JetBrains Mono
 * that app/fonts/fonts.css already ships. Both Google families are variable
 * and cover Cyrillic, so Russian headings and labels render in the theme face.
 * The variables are consumed by app/club20-theme.css only.
 */
import { Playfair_Display, Unbounded } from "next/font/google"

export const clubDisplay = Playfair_Display({
  subsets: ["latin", "cyrillic"],
  weight: "variable",
  display: "swap",
  variable: "--font-club-display",
})

export const clubUi = Unbounded({
  subsets: ["latin", "cyrillic"],
  weight: "variable",
  display: "swap",
  variable: "--font-club-ui",
})
