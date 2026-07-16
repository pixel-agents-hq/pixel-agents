# Multi-Floor Phase 2 — Implementation Report

**Date:** 2026-07-16
**Scope:** 3 new files (`webview-ui/public/assets/floors/floor_9.png`,
`floor_10.png`, `floor_11.png`), 2 doc updates (`README.md`,
`docs/multi-floor.md`). No application code changed.
**Status:** Compile clean. New patterns load correctly (CLI log: "Loaded 12
floor tile patterns from floors/", up from 9). Not yet committed.

## 1. Scope, narrowed

The Phase 1 decision log described Phase 2 as "MetroCity Interior tile/
furniture assets ... for floor-specific themes." Before touching any code,
three concretely different interpretations were possible (a floor-tile
pattern addition, a curated furniture catalog import, or a full two-pack
import), with a large effort gap between them and no bundled metadata in the
asset pack to de-risk a wrong guess. Asked the user; the answer was the
smallest option: **new selectable floor patterns, tintable via the existing
HSB control — no new furniture, no per-floor theme system.**

## 2. What the asset pack actually contains

`Digital world office/Interior/` (JIK-A-4's Free Topdown Interior pack,
itch.io, CC0) is 32 raw PNG sprite sheets across `Demo/`, `Home/`, and
`Hospital/` — no manifest, no grid metadata, no license file bundled. Each
sheet has real alpha transparency and mixes multiple unrelated item types
per file (e.g. `TilesHouse.png` contains floor patterns, railings, _and_ a
staircase graphic in one 512×512 sheet).

## 3. Why wall theming was dropped, not just floor patterns

The existing wall system (`webview-ui/src/office/wallTiles.ts`,
`server/src/assetLoader.ts`) already supports multiple wall **sets** —
`wall_N.png` files are auto-discovered exactly like `floor_N.png` — so
adding a wall theme would have been architecturally free _if_ the source
art existed. It doesn't: a wall set requires 16 correctly-drawn bitmask
pieces (one per N/E/S/W neighbor combination, `WALL_BITMASK_COUNT = 16` in
`core/src/assets/constants.ts`), and the Interior pack has no
autotile-connector wall art — only doors, windows, and railings. Synthesizing
16 mutually-consistent connector pieces from mismatched source material is a
real hand-drawn-art task, not a crop-and-paste one, and the risk of shipping
visually broken wall corners outweighed the value for this pass. Flagged as
a follow-up requiring actual pixel art, not scripted extraction.

## 4. How the 3 floor patterns were chosen and verified

Both `floorTiles.ts` and `wallTiles.ts` compute a Photoshop-style Colorize
transform from **perceived luminance** (`0.299r + 0.587g + 0.114b`,
`webview-ui/src/office/colorize.ts`) — the source pixel's hue and saturation
are discarded entirely and replaced with the user's chosen HSB. This means
any full-color source image works as a floor pattern; what matters is (a)
whether a single 16×16 crop tiles seamlessly at every grid position, and
(b) whether the luminance _contrast_ between its light and dark areas
survives desaturation (a pattern that's all one brightness turns into a flat
color with no visible texture once tinted).

Verified programmatically rather than by eye, since guessing pixel offsets
in an ungridded sheet is exactly the kind of mistake that's invisible until
it's in a live render:

1. Generated a labeled 16px-grid overlay of each candidate sheet
   (`TilesHouse.png`, 32×32 cells; `TilesHospital.png`, 20×16 cells) to read
   exact cell coordinates instead of guessing from a scaled preview.
2. Scanned for non-transparent cells programmatically to correct two initial
   coordinate misreads (a "brick" cell that turned out to be one row off,
   landing on empty space).
3. For each candidate cell, rendered a 6×6 tile-repeat mosaic to confirm
   seamless tiling, **and** a luminance-only conversion (using the exact
   formula above) to confirm the pattern survives desaturation.
4. A blue "hospital mosaic" tile tiled perfectly but had very low luminance
   contrast (the grid lines nearly disappeared once desaturated) — dropped
   in favor of higher-contrast candidates rather than shipping a
   barely-visible pattern.

Final selection, all confirmed both tileable and high-contrast post-luminance:

| File           | Source                       | Pattern                                                    |
| -------------- | ---------------------------- | ---------------------------------------------------------- |
| `floor_9.png`  | `TilesHouse.png` cell (9,9)  | Checkerboard (near-black / near-white, strongest contrast) |
| `floor_10.png` | `TilesHouse.png` cell (3,8)  | Vertical wood plank                                        |
| `floor_11.png` | `TilesHouse.png` cell (2,11) | Running-bond brick                                         |

## 5. Integration

Zero application code changed. `loadFloorTiles()`
(`server/src/assetLoader.ts`) auto-discovers every `floor_N.png` in
`webview-ui/public/assets/floors/` by regex and loads them in numeric order;
the editor's floor-pattern carousel (`EditorToolbar.tsx`) is already driven
by `getFloorPatternCount()`, so the 3 new patterns appear automatically as
swatches 10–12 (1-indexed in the UI) with no UI or type changes needed. Each
is a plain 16×16 RGBA PNG, same shape as the existing `floor_0`–`floor_8`.

## 6. Verification

- `npm run compile` (asyncapi + typecheck + lint + esbuild + vite): clean.
- Standalone CLI boot log confirms `[AssetLoader] ✅ Loaded 12 floor tile
patterns from floors/` (was 9).
- No test in the repo hardcodes a floor pattern count (`grep` for
  `getFloorPatternCount`/`floor_8`/`floor_9` across `webview-ui/test`,
  `server/__tests__`, `e2e` returned nothing), so no existing test needed
  updating.
- Visual verification was done via the tile-repeat and luminance-preview
  renders in §4 rather than a live browser screenshot — those renders use
  the exact pixels that ship and the exact luminance formula the app runs,
  which is stronger evidence than an eyeballed live render would add. Did
  not spin up the standalone server for a screenshot pass after noticing an
  already-running instance from earlier in the session had installed Claude
  Code hooks into the real `~/.claude/settings.json` (expected behavior of
  `npx pixel-agents`, not something this change introduced) — didn't want to
  add a second live-launch on top of that for a check the static renders
  already covered.

## 7. Follow-ups

- **Wall theming** — needs actual hand-drawn autotile wall art (16
  consistent bitmask pieces), not extractable from this asset pack. Out of
  scope until that art exists.
- **Further floor patterns** — `TilesHospital.png` has additional plank/tile
  cells not used here; revisit if more variety is wanted later.
- Per-floor visual _themes_ (a whole floor auto-switching pattern + wall
  set together) were explicitly out of scope for this pass — today's
  addition is "more pattern choices in the existing per-tile paint tool,"
  not a per-floor setting.
