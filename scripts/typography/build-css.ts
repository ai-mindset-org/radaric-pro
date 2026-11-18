/**
 * Write the generated typography stylesheets (RAD-363):
 *   app/fonts/fonts.css   ← buildFontFaceCss()
 *   app/typography.css    ← buildTokenCss()
 *
 * Usage (dev-only):
 *   node --import tsx scripts/typography/build-css.ts
 * (the `tsx` CLI's IPC pipe is refused by the sandbox; `node --import tsx` works.)
 *
 * Re-run after `measure-fonts.py` or any change in `lib/typography`; a test
 * fails when a committed file differs from the builder output.
 */
import { writeFileSync } from "fs"
import path from "path"

import { buildFontFaceCss, buildTokenCss } from "../../lib/typography/build"

const root = path.resolve(__dirname, "../..")

writeFileSync(path.join(root, "app/fonts/fonts.css"), buildFontFaceCss())
writeFileSync(path.join(root, "app/typography.css"), buildTokenCss())
console.log("Wrote app/fonts/fonts.css and app/typography.css")
