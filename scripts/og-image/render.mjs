// Renders og-image.html to public/og-image.png at 1200×630 (RAD-404).
// Usage: node scripts/og-image/render.mjs   (needs `npx playwright install chromium` once)
import { chromium } from "playwright"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, "../../public/og-image.png")

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(path.join(here, "og-image.html")).href)
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: out })
await browser.close()
console.log(`wrote ${path.relative(process.cwd(), out)}`)
