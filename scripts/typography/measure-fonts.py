#!/usr/bin/env python3
"""Measure every font the typography picker offers → lib/typography/font-metrics.json.

The adaptation engine (lib/typography/derive.ts) turns these numbers into CSS:
size normalisation, vertical-metric overrides, weight maps, tabular widths. Every
number it uses comes from here, never from a hand-typed constant.

Usage (dev-only, macOS for the SF faces, needs fontTools + brotli):
    python3 scripts/typography/measure-fonts.py

Shipped files are recorded with their sha256 and the unicode-range their cmap
covers; the test suite fails when a file changes without a re-measure. The SF
faces are read from /System/Library/Fonts — Apple's licence allows requesting
them as the system font, not shipping them, so only their numbers are stored.

All lengths are in em (divided by unitsPerEm) and rounded to 4 decimals.
"""
import hashlib
import json
import pathlib

from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "lib" / "typography" / "font-metrics.json"

INTER = [f"app/fonts/inter/InterVariable-{s}.woff2" for s in ("latin", "cyrillic", "ext")]
GROTESK = ["app/fonts/martian-grotesk/MartianGrotesk-VFVF.woff2"]
MONO = ["app/fonts/martian-mono/MartianMonoVF.woff2"]
PT_ROOT = ["app/fonts/pt-root-ui/PT-Root-UI-VF.woff2"]
GOLOS = ["app/fonts/golos-text/GolosText-VF.woff2"]
# IBM's official split of the variable Plex Sans, upright. Latin1 is FIRST:
# the static metrics are read from the first file, and Latin1 carries the
# Latin metrics the rest of the family shares.
PLEX_SANS = [f"app/fonts/ibm-plex-sans/IBMPlexSansVar-Roman-{part}.woff2" for part in
             ("Latin1", "Latin2", "Latin3", "Greek", "Cyrillic", "Pi")]
JETBRAINS = ["app/fonts/jetbrains-mono/JetBrainsMono-VF.woff2"]
# IBM Plex Mono ships static files only: one complete file per weight.
PLEX_MONO = {
    400: ["app/fonts/ibm-plex-mono/IBMPlexMono-Regular.woff2"],
    500: ["app/fonts/ibm-plex-mono/IBMPlexMono-Medium.woff2"],
    600: ["app/fonts/ibm-plex-mono/IBMPlexMono-SemiBold.woff2"],
    700: ["app/fonts/ibm-plex-mono/IBMPlexMono-Bold.woff2"],
}

# A face = one file set at one location. The Martian families appear twice:
# the Standard cut (wdth 100) for text, headings and counters, and the Narrow
# cut (wdth 87.5) for tags and the Martian Grotesk tabular figures.
# A static face (IBM Plex Mono) gives one file set per shipped weight instead
# of `files`; its metrics, widths and figures come from the 400 file.
FACES = {
    "inter": {"files": INTER, "location": {"opsz": 14}},
    "martian-grotesk": {"files": GROTESK, "location": {"wdth": 100}},
    "martian-grotesk-narrow": {"files": GROTESK, "location": {"wdth": 87.5}},
    "martian-mono": {"files": MONO, "location": {"wdth": 100}},
    "martian-mono-narrow": {"files": MONO, "location": {"wdth": 87.5}},
    "pt-root-ui": {"files": PT_ROOT, "location": {}},
    "golos-text": {"files": GOLOS, "location": {}},
    "ibm-plex-sans": {"files": PLEX_SANS, "location": {"wdth": 100}},
    "jetbrains-mono": {"files": JETBRAINS, "location": {}},
    "ibm-plex-mono": {"static": PLEX_MONO, "location": {}},
    "sf-pro": {"system": "/System/Library/Fonts/SFNS.ttf", "location": {"opsz": 17}},
    "sf-pro-rounded": {"system": "/System/Library/Fonts/SFNSRounded.ttf", "location": {}},
    "sf-mono": {"system": "/System/Library/Fonts/SFNSMono.ttf", "location": {}},
}

EN = dict(zip("etaoinshrdlcumwfgypbvkjxqz", [12.7, 9.1, 8.2, 7.5, 7.0, 6.7, 6.3, 6.1, 6.0, 4.3, 4.0, 2.8, 2.8, 2.4, 2.4, 2.2, 2.0, 2.0, 1.9, 1.5, 1.0, 0.8, 0.15, 0.15, 0.1, 0.07]))
RU = dict(zip("оеаинтсрвлкмдпуяыьгзбчйхжшюцщэфъё", [10.97, 8.45, 8.01, 7.35, 6.70, 6.26, 5.47, 4.73, 4.54, 4.40, 3.49, 3.21, 2.98, 2.81, 2.62, 2.01, 1.90, 1.74, 1.70, 1.65, 1.59, 1.44, 1.21, 0.97, 0.94, 0.73, 0.64, 0.48, 0.36, 0.32, 0.26, 0.04, 0.04]))
TALL = "ЙЁÅÉ"
DEEP = "gjpyЦЩДру"
WEIGHT_STEP = 25


def r4(v):
    return round(v, 4)


class Flatten(BasePen):
    """Outline → straight segments, to intersect a stem with a horizontal line."""

    def __init__(self, glyphset):
        super().__init__(glyphset)
        self.segments = []
        self.cur = self.start = None

    def _moveTo(self, p):
        self.cur = self.start = p

    def _lineTo(self, p):
        self.segments.append((self.cur, p))
        self.cur = p

    def _curveToOne(self, p1, p2, p3):
        p0, prev = self.cur, self.cur
        for i in range(1, 25):
            t = i / 24
            m = 1 - t
            pt = (m**3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t**3 * p3[0],
                  m**3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t**3 * p3[1])
            self.segments.append((prev, pt))
            prev = pt
        self.cur = p3

    def _qCurveToOne(self, p1, p2):
        p0, prev = self.cur, self.cur
        for i in range(1, 25):
            t = i / 24
            m = 1 - t
            pt = (m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0], m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1])
            self.segments.append((prev, pt))
            prev = pt
        self.cur = p2

    def _closePath(self):
        if self.cur != self.start:
            self.segments.append((self.cur, self.start))
        self.cur = self.start


class Face:
    """One or more files (Inter's unicode-range subsets) read at one location.

    Static metrics (bounds, advances) come from a real instance at the face's
    location with wght 400: `getGlyphSet(location=)` varies outlines but keeps
    the default advances, which hid the whole width axis. The weight curve only
    needs outlines, so it uses the cheap location glyph sets.
    """

    def __init__(self, paths, location):
        self.paths = paths
        self.fonts = [TTFont(p) for p in paths]
        self.main = self.fonts[0]
        self.upm = self.main["head"].unitsPerEm
        self.base_location = location
        self.cmaps = [f.getBestCmap() for f in self.fonts]
        self._static = None

    def static_glyphsets(self):
        if self._static is None:
            loc = self.location()
            fonts = [instancer.instantiateVariableFont(TTFont(p), loc) if loc else TTFont(p) for p in self.paths]
            self._static_fonts = fonts
            self._static = [f.getGlyphSet() for f in fonts]
        return self._static

    def axes(self):
        if "fvar" not in self.main:
            return {}
        return {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in self.main["fvar"].axes}

    def location(self, weight=None):
        loc = {}
        for tag, (lo, default, hi) in self.axes().items():
            v = self.base_location.get(tag, default)
            if tag == "wght":
                v = weight if weight is not None else 400
            loc[tag] = max(lo, min(hi, v))
        return loc

    def glyphsets(self, weight=None):
        loc = self.location(weight)
        return [f.getGlyphSet(location=loc) if loc else f.getGlyphSet() for f in self.fonts]

    def glyph(self, glyphsets, ch):
        for cmap, gs in zip(self.cmaps, glyphsets):
            name = cmap.get(ord(ch))
            if name is not None:
                return gs, name
        return None, None

    def bounds(self, glyphsets, ch):
        gs, name = self.glyph(glyphsets, ch)
        if gs is None:
            return None
        pen = BoundsPen(gs)
        gs[name].draw(pen)
        return pen.bounds

    def advance(self, glyphsets, ch):
        gs, name = self.glyph(glyphsets, ch)
        return gs[name].width if gs is not None else None


def tabular_zero_advance(face, glyphsets):
    """Advance of '0' under `tnum`, or None when the font has no tnum feature."""
    font = face._static_fonts[0]
    zero = face.cmaps[0].get(ord("0"))
    if "GSUB" not in font or zero is None:
        return None
    table = font["GSUB"].table
    for record in table.FeatureList.FeatureRecord:
        if record.FeatureTag != "tnum":
            continue
        for index in record.Feature.LookupListIndex:
            for sub in table.LookupList.Lookup[index].SubTable:
                mapping = getattr(sub, "mapping", None)
                if mapping is None and getattr(sub, "ExtSubTable", None) is not None:
                    mapping = getattr(sub.ExtSubTable, "mapping", None)
                if mapping and zero in mapping:
                    return glyphsets[0][mapping[zero]].width
        return glyphsets[0][zero].width  # tnum present, digits already tabular
    return None


def stem_ratio(face, weight):
    gss = face.glyphsets(weight)
    xh = face.bounds(gss, "x")[3]
    gs, name = face.glyph(gss, "n")
    pen = Flatten(gs)
    gs[name].draw(pen)
    y = xh * 0.45
    xs = sorted(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) for a, b in pen.segments if (a[1] - y) * (b[1] - y) < 0)
    return (xs[1] - xs[0]) / xh


def unicode_range(path):
    cps = sorted(TTFont(path).getBestCmap())
    ranges, start, prev = [], cps[0], cps[0]
    for cp in cps[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        ranges.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        if cp is not None:
            start = prev = cp
    return ",".join(ranges)


def measure(spec):
    """A static face (one file per weight) is measured per file; a variable one as before."""
    if "static" in spec:
        return measure_static(spec)
    return measure_variable(spec)


def measure_static(spec):
    """Metrics, widths and figures from the 400 file; stems from every weight's own file."""
    weights = sorted(int(w) for w in spec["static"])
    files = {int(w): spec["static"][w] for w in spec["static"]}
    out = measure_variable({"files": files[400], "location": spec["location"]})
    out["stems"] = [[w, r4(stem_ratio(Face([str(ROOT / p) for p in files[w]], spec["location"]), w))]
                    for w in weights]
    out["static"] = True
    out["axes"] = {"wght": [weights[0], 400, weights[-1]]}
    out["files"] = [
        {"path": p, "sha256": hashlib.sha256((ROOT / p).read_bytes()).hexdigest(),
         "unicodeRange": unicode_range(ROOT / p), "weight": w}
        for w in weights for p in files[w]
    ]
    return out


def measure_variable(spec):
    paths = [ROOT / p for p in spec["files"]] if "files" in spec else [spec["system"]]
    face = Face([str(p) for p in paths], spec["location"])
    gss = face.static_glyphsets()
    # OS/2 and hhea from the instance, not the default master: MVAR varies them
    # with the axes (SF Pro's x-height changes with optical size).
    font, upm = face._static_fonts[0], face.upm
    os2, hhea = font["OS/2"], font["hhea"]
    em = lambda v: r4(v / upm)

    def weighted_width(freq):
        total = acc = 0
        for ch, f in freq.items():
            adv = face.advance(gss, ch)
            if adv is not None:
                total += f
                acc += f * adv
        return em(acc / total) if total else None

    digits = [em(face.advance(gss, str(d))) for d in range(10)]  # "0" … "9", in order
    tnum = tabular_zero_advance(face, gss)
    features = sorted({rec.FeatureTag for tag in ("GSUB", "GPOS") if tag in font and font[tag].table.FeatureList
                       for rec in font[tag].table.FeatureList.FeatureRecord})
    wght = face.axes().get("wght")
    lo, hi = (max(100, wght[0]), min(900, wght[2])) if wght else (400, 400)
    weights = [w for w in range(100, 901, WEIGHT_STEP) if lo <= w <= hi]
    if wght and hi not in weights:
        weights.append(hi)

    out = {
        "axes": face.axes(),
        "location": face.location(),
        "unitsPerEm": upm,
        "hhea": {"ascent": em(hhea.ascent), "descent": em(-hhea.descent), "lineGap": em(hhea.lineGap)},
        "typo": {"ascent": em(os2.sTypoAscender), "descent": em(-os2.sTypoDescender), "lineGap": em(os2.sTypoLineGap)},
        "win": {"ascent": em(os2.usWinAscent), "descent": em(os2.usWinDescent)},
        "useTypoMetrics": bool(os2.fsSelection & (1 << 7)),
        "capHeight": em(face.bounds(gss, "H")[3]),
        "capHeightOS2": em(getattr(os2, "sCapHeight", 0) or 0),
        "xHeight": em(face.bounds(gss, "x")[3]),
        "xHeightOS2": em(getattr(os2, "sxHeight", 0) or 0),
        "figureHeight": em(face.bounds(gss, "8")[3]),
        "tallestAccent": max(em(b[3]) for b in (face.bounds(gss, c) for c in TALL) if b),
        "deepestDescender": max(em(-b[1]) for b in (face.bounds(gss, c) for c in DEEP) if b),
        "lowercaseWidth": {"en": weighted_width(EN), "ru": weighted_width(RU)},
        "digitAdvances": digits,
        "tabularDigitAdvance": em(tnum) if tnum is not None else None,
        "features": features,
        "stems": [[w, r4(stem_ratio(face, w))] for w in weights],
    }
    if "files" in spec:
        out["files"] = [{"path": p, "sha256": hashlib.sha256((ROOT / p).read_bytes()).hexdigest(),
                         "unicodeRange": unicode_range(ROOT / p)} for p in spec["files"]]
    else:
        out["system"] = spec["system"]
    return out


def main():
    faces = {}
    for face_id, spec in FACES.items():
        faces[face_id] = measure(spec)
        m = faces[face_id]
        print(f"{face_id:24} x {m['xHeight']} cap {m['capHeight']} fig {m['figureHeight']} "
              f"tnum {m['tabularDigitAdvance']} weights {m['stems'][0][0]}–{m['stems'][-1][0]}", flush=True)
    OUT.write_text(json.dumps({"version": 1, "reference": "inter", "faces": faces}, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
