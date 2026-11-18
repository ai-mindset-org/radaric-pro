#!/usr/bin/env python3
"""Subset the upstream Inter 4 variable font into the three files the app serves.

Inter is OFL without a Reserved Font Name, so subsetting is allowed. Both axes
(opsz, wght) and every feature the product uses are kept: the whole point of
self-hosting is to get the Display optical size, `case`, `tnum`, `cv11` and
`ss01`, which the Google Fonts build strips. The unused alternates (cv01–cv13
except cv11, ss02–ss08, salt, aalt, dlig) are dropped with their glyphs.

Usage (dev-only, needs fontTools + brotli):
    python3 scripts/typography/subset-inter.py path/to/InterVariable.ttf

Input: `InterVariable.ttf` from the rsms/inter release zip (v4.001, see
app/fonts/SOURCES.md). Output: app/fonts/inter/InterVariable-{latin,cyrillic,ext}.woff2.
Re-run scripts/typography/measure-fonts.py afterwards — the metrics file pins
each file's sha256 and unicode-range, and the tests fail until it is refreshed.
"""
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "app" / "fonts" / "inter"

FEATURES = [
    "kern", "calt", "liga", "rlig", "ccmp", "locl", "mark", "mkmk",
    "case", "tnum", "pnum", "zero", "frac", "numr", "dnom", "sups", "subs",
    "sinf", "ordn", "cv11", "ss01",
]

# The file every page preloads: Google Fonts' "latin" range plus the few symbols
# UI copy uses — basic arrows, comparison signs, keyboard glyphs, the ruble —
# so an "→" in a button never pulls the large ext file.
LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0301,"
    "U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+20BD,U+2122,U+2190-2199,U+21A9,"
    "U+21E7,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+2303,U+2318,U+2325,"
    "U+232B,U+238B,U+23CE,U+FEFF,U+FFFD"
)
CYRILLIC = "U+0400-052F,U+1C80-1C8F,U+2116,U+2DE0-2DFF,U+A640-A69F"
# Everything else the product can meet in user content: Latin Extended and
# Vietnamese, Greek, super/subscripts, letterlike symbols, math, shapes.
EXT = (
    "U+0100-024F,U+0259,U+02B0-02FF,U+0300-036F,U+0370-03FF,U+1E00-1EFF,U+1F00-1FFF,"
    "U+2070-209F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2200-22FF,"
    "U+2300-23FF,U+2460-24FF,U+25A0-25FF,"
    "U+A720-A7FF"
)


def parse_ranges(spec):
    out = set()
    for part in spec.split(","):
        part = part.strip().removeprefix("U+")
        lo, _, hi = part.partition("-")
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


def build(src, name, codepoints, exclude=()):
    font = TTFont(src)
    cmap = font.getBestCmap()
    keep = sorted((codepoints & set(cmap)) - set(exclude))
    options = subset.Options()
    options.layout_features = FEATURES
    options.flavor = "woff2"
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=keep)
    sub.subset(font)
    path = OUT / name
    font.flavor = "woff2"
    font.save(path)
    print(f"{path.relative_to(ROOT)}  {path.stat().st_size} bytes  {len(keep)} code points")
    return set(keep)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    OUT.mkdir(parents=True, exist_ok=True)
    latin = build(src, "InterVariable-latin.woff2", parse_ranges(LATIN))
    # No code point lives in two files: unicode-range then gives the browser
    # exactly one face per character.
    cyrillic = build(src, "InterVariable-cyrillic.woff2", parse_ranges(CYRILLIC), exclude=latin)
    build(src, "InterVariable-ext.woff2", parse_ranges(EXT), exclude=latin | cyrillic)


if __name__ == "__main__":
    main()
