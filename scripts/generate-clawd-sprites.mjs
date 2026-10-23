#!/usr/bin/env node
/**
 * Generates the Clawd sprite sheet: Claude Code's orange mascot as an agent
 * character, in the SAME 112×96 format as assets/characters/char_N.png (3
 * direction rows down/up/right × 7 frames of 16×32), so the engine's frame
 * logic (webview-ui/src/office/sprites/spriteData.ts) is untouched:
 *
 *   frames 0 1 2 → walk (1 is also the standing pose; the cycle is 0 1 2 1)
 *   frames 3 4   → typing (seated)
 *   frames 5 6   → reading (seated, eyes down and scanning)
 *
 * The art is drawn in the lower part of each frame so a Clawd stands on the
 * chibis' baseline (standing feet end on row 30, seated on row 31, and a
 * seated Clawd facing away ends on row 25 so the chair back shows in front of
 * it, as the chibi sheets do). Left-facing frames are mirrored by the engine.
 *
 * Writes:
 *   webview-ui/public/assets/clawd/clawd_0.png        the sheet (for humans and packs)
 *   webview-ui/src/office/sprites/clawd-sheet.json    the same sheet, palette-keyed,
 *                                                     bundled into the webview
 *
 * Tints and accessories are NOT baked in here: the webview tints the one base
 * sheet per repo at runtime (constants.ts CLAWD_TINTS) and composes the
 * accessory overlay on top (office/sprites/clawdSprites.ts).
 *
 * Usage: node scripts/generate-clawd-sprites.mjs [--ascii] [--preview <png>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const FRAME_W = 16;
const FRAME_H = 32;
const FRAMES = 7;
const DIRECTIONS = ['down', 'up', 'right'];
const SHEET_W = FRAME_W * FRAMES;
const SHEET_H = FRAME_H * DIRECTIONS.length;

/** The base palette (Claude orange). The eye colour is unique so the webview
 *  can find the eyes (blink overlay) without any extra metadata. */
const PALETTE = {
  o: '#D97757', // body: Claude orange
  s: '#C2613F', // shade along the bottom
  k: '#4A2C22', // outline
  e: '#1B1210', // eyes
};

// ── Drawing helpers ────────────────────────────────────────────

const blank = () => Array.from({ length: FRAME_H }, () => new Array(FRAME_W).fill('.'));

function put(g, x, y, c) {
  if (y < 0 || y >= FRAME_H || x < 0 || x >= FRAME_W) {
    throw new Error(`pixel out of frame: (${x}, ${y})`);
  }
  g[y][x] = c;
}

function hline(g, x0, x1, y, c) {
  for (let x = x0; x <= x1; x++) put(g, x, y, c);
}

/**
 * The body: a rounded block from column l to r (inclusive) and row top to
 * bottom (inclusive), 1 px outline, flat orange fill, one shade row at the
 * bottom. Corners are cut by two steps at the top and one at the bottom.
 */
function body(g, l, r, top, bottom) {
  hline(g, l + 2, r - 2, top, 'k');
  put(g, l + 1, top + 1, 'k');
  put(g, r - 1, top + 1, 'k');
  hline(g, l + 2, r - 2, top + 1, 'o');
  for (let y = top + 2; y <= bottom - 2; y++) {
    put(g, l, y, 'k');
    put(g, r, y, 'k');
    hline(g, l + 1, r - 1, y, y === bottom - 2 ? 's' : 'o');
  }
  put(g, l + 1, bottom - 1, 'k');
  put(g, r - 1, bottom - 1, 'k');
  hline(g, l + 2, r - 2, bottom - 1, 's');
  hline(g, l + 2, r - 2, bottom, 'k');
}

/** A 2×2 eye with its top-left at (x, y). */
function eye(g, x, y) {
  hline(g, x, x + 1, y, 'e');
  hline(g, x, x + 1, y + 1, 'e');
}

/**
 * Legs hanging from the body's bottom row: for each entry, a leg `w` px wide
 * starting at column x, `len` orange px long, ending in a dark foot px row.
 */
function legs(g, bottom, list) {
  for (const { x, w = 1, len } of list) {
    for (let i = 1; i <= len; i++) hline(g, x, x + w - 1, bottom + i, 'o');
    hline(g, x, x + w - 1, bottom + len + 1, 'k');
  }
}

/** A little arm: `w` orange px sticking out sideways at row y from column x. */
function arm(g, x, w, y) {
  hline(g, x, x + w - 1, y, 'o');
}

// ── Geometry ───────────────────────────────────────────────────

/** Front/back body: 12 wide (cols 2..13). Side body: 10 wide (cols 3..12). */
const FRONT = { l: 2, r: 13 };
const SIDE = { l: 3, r: 12 };
/** Body height (rows, outline included). */
const BODY_H = 11;
/** Standing: the body's bottom row; legs then end on row 30. */
const STAND_BOTTOM = 27;
/** Seated (typing, reading): drawn a row lower; the dangling legs end on row 31. */
const SIT_BOTTOM = 29;
/** Seated facing away: the chair back hides the legs; the body ends on row 25. */
const SIT_BACK_BOTTOM = 25;
/** Eyes sit this many rows under the body's top row. */
const EYE_DY = 3;
/** Front legs: two pairs, like the mascot's four little feet. Side: two 2-px legs. */
const FRONT_LEGS = [4, 6, 9, 11];
const SIDE_LEGS = [5, 9];

function frontStanding(frame, withEyes) {
  const g = blank();
  const lifted = frame !== 1; // mid-stride: the body bobs up a px
  const bottom = STAND_BOTTOM - (lifted ? 1 : 0);
  const top = bottom - BODY_H + 1;
  body(g, FRONT.l, FRONT.r, top, bottom);
  if (withEyes) {
    eye(g, 5, top + EYE_DY);
    eye(g, 9, top + EYE_DY);
  }
  if (!lifted) {
    legs(
      g,
      bottom,
      FRONT_LEGS.map((x) => ({ x, len: 2 })),
    );
  } else {
    // One pair strides (long, feet on row 30), the other swings (short).
    const leftLong = frame === 0;
    legs(g, bottom, [
      { x: 4, len: leftLong ? 3 : 2 },
      { x: 6, len: leftLong ? 3 : 2 },
      { x: 9, len: leftLong ? 2 : 3 },
      { x: 11, len: leftLong ? 2 : 3 },
    ]);
  }
  return g;
}

function frontSeated(frame, withEyes) {
  const g = blank();
  const bottom = withEyes ? SIT_BOTTOM : SIT_BACK_BOTTOM;
  const top = bottom - BODY_H + 1;
  body(g, FRONT.l, FRONT.r, top, bottom);
  const typing = frame === 3 || frame === 4;
  if (withEyes) {
    if (typing) {
      eye(g, 5, top + EYE_DY);
      eye(g, 9, top + EYE_DY);
    } else {
      // Reading: eyes down a row, scanning left then right.
      const dx = frame === 5 ? -1 : 1;
      eye(g, 5 + dx, top + EYE_DY + 1);
      eye(g, 9 + dx, top + EYE_DY + 1);
    }
    legs(
      g,
      bottom,
      FRONT_LEGS.map((x) => ({ x, len: 1 })),
    );
    // Little arms reaching for the desk: tapping lifts them a row.
    const armY = bottom - (frame === 4 ? 4 : 3);
    arm(g, 0, 2, armY);
    arm(g, 14, 2, armY);
  } else {
    // Facing away: the arms show as a px each side, no legs (chair back).
    const armY = bottom - (frame === 4 ? 4 : 3);
    arm(g, 1, 1, armY);
    arm(g, 14, 1, armY);
  }
  return g;
}

function sideStanding(frame) {
  const g = blank();
  const lifted = frame !== 1;
  const bottom = STAND_BOTTOM - (lifted ? 1 : 0);
  const top = bottom - BODY_H + 1;
  body(g, SIDE.l, SIDE.r, top, bottom);
  eye(g, 9, top + EYE_DY);
  if (!lifted) {
    legs(
      g,
      bottom,
      SIDE_LEGS.map((x) => ({ x, w: 2, len: 2 })),
    );
  } else {
    const backLong = frame === 0;
    legs(g, bottom, [
      { x: 5, w: 2, len: backLong ? 3 : 2 },
      { x: 9, w: 2, len: backLong ? 2 : 3 },
    ]);
  }
  return g;
}

function sideSeated(frame) {
  const g = blank();
  const bottom = SIT_BOTTOM;
  const top = bottom - BODY_H + 1;
  body(g, SIDE.l, SIDE.r, top, bottom);
  const typing = frame === 3 || frame === 4;
  if (typing) {
    eye(g, 9, top + EYE_DY);
  } else {
    eye(g, frame === 5 ? 9 : 10, top + EYE_DY + 1);
  }
  legs(
    g,
    bottom,
    SIDE_LEGS.map((x) => ({ x, w: 2, len: 1 })),
  );
  // The arm reaches forward to the desk; tapping lifts it a row.
  arm(g, 13, 2, bottom - (frame === 4 ? 4 : 3));
  return g;
}

function frameFor(dir, frame) {
  const standing = frame <= 2;
  if (dir === 'down') return standing ? frontStanding(frame, true) : frontSeated(frame, true);
  if (dir === 'up') return standing ? frontStanding(frame, false) : frontSeated(frame, false);
  return standing ? sideStanding(frame) : sideSeated(frame);
}

// ── The sheet ──────────────────────────────────────────────────

function buildSheet() {
  const rows = Array.from({ length: SHEET_H }, () => new Array(SHEET_W).fill('.'));
  DIRECTIONS.forEach((dir, di) => {
    for (let f = 0; f < FRAMES; f++) {
      const g = frameFor(dir, f);
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) rows[di * FRAME_H + y][f * FRAME_W + x] = g[y][x];
      }
    }
  });
  return rows.map((r) => r.join(''));
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function sheetToPng(rows, zoom = 1) {
  const png = new PNG({ width: SHEET_W * zoom, height: SHEET_H * zoom });
  for (let y = 0; y < SHEET_H; y++) {
    for (let x = 0; x < SHEET_W; x++) {
      const key = rows[y][x];
      if (key === '.') continue;
      const [r, g, b] = hexToRgb(PALETTE[key]);
      for (let zy = 0; zy < zoom; zy++) {
        for (let zx = 0; zx < zoom; zx++) {
          const i = ((y * zoom + zy) * png.width + x * zoom + zx) * 4;
          png.data[i] = r;
          png.data[i + 1] = g;
          png.data[i + 2] = b;
          png.data[i + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

function main() {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const rows = buildSheet();

  if (args.includes('--ascii')) {
    for (const row of rows) console.log(row);
  }
  const previewAt = args.indexOf('--preview');
  if (previewAt >= 0 && args[previewAt + 1]) {
    fs.writeFileSync(args[previewAt + 1], sheetToPng(rows, 6));
  }

  const pngPath = path.join(root, 'webview-ui', 'public', 'assets', 'clawd', 'clawd_0.png');
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, sheetToPng(rows));

  const jsonPath = path.join(root, 'webview-ui', 'src', 'office', 'sprites', 'clawd-sheet.json');
  const json = {
    $comment: 'Generated by scripts/generate-clawd-sprites.mjs. Do not edit by hand.',
    frameW: FRAME_W,
    frameH: FRAME_H,
    frames: FRAMES,
    directions: DIRECTIONS,
    palette: PALETTE,
    rows,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, pngPath)} and ${path.relative(root, jsonPath)}`);
}

main();
