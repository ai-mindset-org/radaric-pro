// Corner art for the squircle mask in app/globals.css.
//
//   node scripts/gen-superellipse.mjs [k] [steps]
//
// Prints the four `--sq-*` declarations. Paste them over the block in
// globals.css that carries the same names. No dependencies.
//
// WHAT IT EMITS, AND WHY EACH FILE IS ONE CORNER'S NOTCH
//
// Each SVG is the piece of ONE corner that gets REMOVED: a 100x100 square
// holding the sliver between the corner point and the superellipse arc. The
// mask lays the four of them at the four corners at `--sq-r` each, unions
// them, and SUBTRACTS that union from a full-box rectangle, so the corner
// stays a fixed number of pixels while the fill follows the element.
//
// The predecessor emitted the opposite: four images that were each a whole
// 100x100 box, opaque except one notched corner, INTERSECTED. That reads more
// naturally, and it is why the notch had to be 1 unit of 100 — the other 99
// were the flat run that had to reach across the element. Which is exactly
// where it broke: `mask-size` was `calc(var(--sq-r) * 100)`, i.e. a fixed
// 1800px at Radaric's 18px `--radius-xl`, so the flat run stopped at 1800px.
// An element taller than that lost the overlap the intersection needed and
// painted only the band [height - 1800, 1800]; past 3600px it painted nothing
// at all. A production list shipped that form and lost its background.
// Subtracting
// fixed corners from a stretched rectangle has no such ceiling — see `no mask
// layer is sized independently of its element` in __tests__/squircle-mask.test.ts.
//
// TWO DETAILS THAT LOOK COSMETIC AND ARE NOT
//
// 1. ONE STRETCHED RECTANGLE, not corner wedges plus filler bands. `source-over`
//    composites alpha as a1 + a2 - a1*a2, so two anti-aliased edges meeting at
//    0.5 each give 0.75, not 1 — a visible hairline everywhere two layers
//    abut. The four notches never abut each other, so unioning THEM is free;
//    it is the fill that must not be assembled from pieces.
//
//    The operator is `subtract` (Porter-Duff `source-out`), not `exclude`/`xor`.
//    XOR agrees with subtraction only while the notches are DISJOINT, which
//    stops being true the moment an element is narrower or shorter than
//    2 * --sq-r. Radaric's default `--sq-r` is 18px, so anything under 36px in
//    either axis is in range — icon tiles are the obvious candidates.
//    Measured at 26x26 with r=24, at the point where the top-left and top-right
//    notches overlap: subtract leaves (209,26,26) over a red ground, XOR leaves
//    (228,118,118), in both WebKit and Chromium.
//
// 2. OVERSHOOT. The notch's two straight edges are pushed outside the 100x100
//    viewport. An edge lying exactly ON the boundary rasterises at ~50%
//    coverage, which under-removes and leaves a half-strength outline tracing
//    the whole element. The overshoot is clipped by the viewport, so the
//    geometry is unchanged and the boundary pixels are fully covered.
//
// k=2.4 is the house constant. An older variant of this generator still
// emits the old intersect form; this file is Radaric's own and the two are
// not interchangeable.

const k = Number(process.argv[2] || 2.4);
const STEPS = Number(process.argv[3] || 24);
const S = 100; // the box the arc spans, so the art is resolution-independent
const O = 5; // overshoot, in the same units; clipped by the SVG viewport

const p = (v) => Number(v.toFixed(4));
const se = (t) => Math.pow(Math.cos(t), 2 / k);
const sf = (t) => Math.pow(Math.sin(t), 2 / k);

// t sweeps 0 -> pi/2, giving STEPS + 1 points along the arc.
const arc = (fn) =>
  Array.from({ length: STEPS + 1 }, (_, i) => fn((Math.PI / 2) * (i / STEPS)))
    .map(([x, y]) => `L${p(x * S)},${p(y * S)}`)
    .join("");

// Each path starts just outside where the arc starts, traces the arc, then
// closes around the OUTSIDE of the two straight edges. The enclosed area is
// the corner sliver that gets subtracted.
const corners = {
  // corner (0,0), arc (0,S) -> (S,0)
  tl: `M${-O},${S}${arc((t) => [1 - se(t), 1 - sf(t)])}L${S},${-O}L${-O},${-O}Z`,
  // corner (S,0), arc (0,0) -> (S,S)
  tr: `M0,${-O}${arc((t) => [sf(t), 1 - se(t)])}L${S + O},${S}L${S + O},${-O}Z`,
  // corner (S,S), arc (S,0) -> (0,S)
  br: `M${S + O},0${arc((t) => [se(t), sf(t)])}L0,${S + O}L${S + O},${S + O}Z`,
  // corner (0,S), arc (S,S) -> (0,0)
  bl: `M${S},${S + O}${arc((t) => [1 - sf(t), se(t)])}L${-O},0L${-O},${S + O}Z`,
};

const svg = (d) =>
  `url('data:image/svg+xml;utf-8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22${S}%22 height=%22${S}%22><path d=%22${d}%22/></svg>')`;

for (const [name, d] of Object.entries(corners)) {
  console.log(`    --sq-${name}: ${svg(d)};`);
}
