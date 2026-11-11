#!/usr/bin/env node
/**
 * Generates the bundled wall sets wall_1.png … wall_N.png in
 * webview-ui/public/assets/walls/ (wall_0.png is the original hand-drawn set
 * and is never touched).
 *
 * Every sheet is the format the loader reads: 64×128, a 4×4 grid of 16×32
 * pieces, piece N = the 4-bit neighbour mask (N=1, E=2, S=4, W=8). The art is
 * grayscale because walls are drawn through Colorize (luminance → the wall's
 * colour), like floors.
 *
 * All sets share one piece model, the one wall_0 is drawn in: an 8-row top cap
 * with the front face under it, a wall running south shows its top face down
 * the whole piece, and outlines close every side without a neighbour. A set
 * changes only its height (front-face rows; a lower wall leaves the top of
 * its pieces transparent, which is how the office tells heights apart: only
 * walls of the same height join) and the textures of its two faces.
 *
 *   node scripts/generate-wall-sets.mjs              write the sheets
 *   node scripts/generate-wall-sets.mjs --preview p  also render a preview PNG
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WALLS_DIR = path.join(ROOT, 'webview-ui/public/assets/walls');

const PW = 16; // piece width
const PH = 32; // piece height
const CAP = 8; // top-cap rows

const OUTLINE = 45;
const CAP_LUM = 200;
const FACE_LUM = 255;

/** A deterministic hash in [0, 1) for texture variation. */
function hash(...n) {
  let h = 2166136261;
  for (const v of n) {
    h ^= v + 0x9e3779b9;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 10007) / 10007;
}

// ── Textures ──────────────────────────────────────────────────────────────
// face(x, y, h): x 0..15, y 0..h-2 from the top of the front face (row h-1 is
// the bottom outline). Returns a luminance, or [luminance, alpha].
// cap(x, y, south): the top face; y counts from the top of the cap and runs
// on into a south-running wall's column (`south`), so keep it periodic in 16
// vertically there.

const flatCap = (lum) => () => lum;

/** A lighter rim along the cap's front edge (only where a front face follows). */
const rimCap = (lum, rim) => (_x, y, south) => (y === CAP - 1 && !south ? rim : lum);

function brickFace(x, y, h) {
  if (y >= h - 3) return 150; // plinth
  const course = Math.floor(y / 4);
  if (y % 4 === 3) return 150; // bed joint
  const shift = course % 2 === 0 ? 0 : 4;
  const bx = (x + shift) % 16;
  if (bx % 8 === 7) return 150; // head joint
  const brick = Math.floor((x + shift) / 8);
  const v = hash(course, brick);
  const base = v < 0.33 ? 205 : v < 0.66 ? 222 : 238;
  if (y % 4 === 0) return Math.min(255, base + 14); // lit top edge
  return base;
}

function plankFace(x, y, h) {
  if (y >= h - 3) return y === h - 3 ? 175 : 140; // skirting
  const plank = Math.floor(x / 4);
  if (x % 4 === 3) return 140; // seam
  const tone = [214, 232, 222, 240][plank];
  // Grain: short dark streaks, two per plank, at fixed spots.
  const g1 = Math.floor(hash(plank, 1) * (h - 5));
  const g2 = Math.floor(hash(plank, 2) * (h - 5));
  const gx = 1 + Math.floor(hash(plank, 3) * 2);
  if (x % 4 === gx && (y === g1 || y === g1 + 1 || y === g2)) return tone - 34;
  if (x % 4 === 0) return Math.min(255, tone + 12); // lit edge
  return tone;
}

const plankCap = (x) => (x % 4 === 3 ? 160 : [190, 204, 196, 210][Math.floor(x / 4)]);

function stoneFace(x, y, h) {
  if (y >= h - 2) return 120;
  const row = Math.floor(y / 7);
  const yy = y % 7;
  const shift = row % 2 === 0 ? 0 : 5;
  const bx = (x + shift) % 16;
  const block = Math.floor((x + shift) / 16) * 2 + (bx < 10 ? 0 : 1);
  const left = bx === 0 || bx === 10;
  const right = bx === 9 || bx === 15;
  if (yy === 6) return 120; // joint
  if (left && yy === 0) return 120;
  const v = hash(row, block);
  const base = 200 + Math.floor(v * 3) * 12;
  if (yy === 0 || left) return Math.min(255, base + 22); // lit top/left
  if (yy === 5 || right) return base - 30; // shade bottom/right
  if (hash(x, y, 7) < 0.06) return base - 18; // pits
  return base;
}

function wainscotFace(x, y, h) {
  const rail = Math.floor((h - 1) * 0.5);
  if (y < rail) return 248; // plaster
  if (y === rail) return 150; // chair rail shadow
  if (y === rail + 1) return 255; // chair rail
  if (y >= h - 3) return y === h - 3 ? 170 : 140; // skirting
  // Raised panels, 8 wide: lit left/top, shaded right/bottom.
  const px = x % 8;
  const py = y - (rail + 2);
  const ph = h - 3 - (rail + 2);
  if (px === 0 || px === 7 || py === 0 || py === ph - 1) return 205;
  if (px === 1 || py === 1) return 238;
  if (px === 6 || py === ph - 2) return 182;
  return 214;
}

function officePanelFace(x, y, h) {
  if (y >= h - 3) return y === h - 3 ? 150 : 120; // kick plate
  const rail = Math.floor((h - 3) / 3);
  if (y === rail) return 180;
  if (y === rail + 1) return 252;
  // Panel seam every 16 columns, with a lit edge after it.
  if (x === 15) return 175;
  if (x === 0) return 250;
  if (y < rail) return 236;
  return 228;
}

function glassFace(x, y, h) {
  const glass = 9; // rows of glass under the cap
  if (y < glass) {
    if (x === 15) return 150; // mullion
    // Highlight streaks across the pane.
    const d = (x + y) % 16;
    if (d === 3 || d === 4 || d === 10) return [255, 150];
    return [215, 90];
  }
  if (y === glass) return 150; // transom
  if (y >= h - 3) return y === h - 3 ? 150 : 120;
  if (x === 15) return 175;
  if (x === 0) return 246;
  return 232;
}

const glassCap = (x, y, south) => ((y === CAP - 1 && !south) || x === 7 ? 232 : 196);

function cubicleFace(x, y, h) {
  if (y === 0) return 255; // trim edge
  if (y >= h - 3) return y === h - 3 ? 150 : 120; // base
  if (x === 15) return 175; // panel joint
  // Woven fabric: a sparse two-tone weave.
  if ((x + y * 2) % 4 === 0) return 205;
  if ((x * 3 + y) % 7 === 0) return 238;
  return 222;
}

function lowPanelFace(x, y, h) {
  if (y >= h - 2) return 130;
  if (y === 0) return 255;
  if (x === 15) return 170;
  if (x === 0) return 250;
  // Wood veneer: faint horizontal grain.
  if ((y + Math.floor(hash(Math.floor(x / 5), y) * 3)) % 5 === 0) return 214;
  return 232;
}

/**
 * The bundled kinds after wall_0, in order (wall_1 is the first). `height` is
 * the front face's rows including its bottom outline; wall_0's is 24.
 */
const KINDS = [
  { name: 'Brick', height: 24, face: brickFace, cap: rimCap(196, 214) },
  { name: 'Wood planks', height: 24, face: plankFace, cap: plankCap },
  { name: 'Stone', height: 24, face: stoneFace, cap: rimCap(190, 210) },
  { name: 'Wainscot', height: 24, face: wainscotFace, cap: flatCap(CAP_LUM) },
  { name: 'Office panel', height: 24, face: officePanelFace, cap: rimCap(206, 230) },
  { name: 'Glass partition', height: 24, face: glassFace, cap: glassCap },
  { name: 'Half panel', height: 16, face: lowPanelFace, cap: rimCap(214, 240) },
  { name: 'Cubicle', height: 12, face: cubicleFace, cap: rimCap(222, 248) },
];

// ── The piece model ───────────────────────────────────────────────────────

/** One 16×32 piece as [lum, alpha] per pixel (alpha 0 = transparent). */
function drawPiece(mask, kind) {
  const n = (mask & 1) !== 0;
  const e = (mask & 2) !== 0;
  const s = (mask & 4) !== 0;
  const w = (mask & 8) !== 0;
  const top = PH - kind.height - CAP; // first row of the cap
  const faceTop = top + CAP;
  const px = [];
  for (let y = 0; y < PH; y++) {
    const row = [];
    for (let x = 0; x < PW; x++) {
      row.push(pixel(x, y));
    }
    px.push(row);
  }
  return px;

  function pixel(x, y) {
    if (y < top) return [0, 0];
    const inCap = y < faceTop;
    if (inCap || s) {
      // Top face: the cap, and a south-running wall's column under it.
      const capOutlined =
        (y === top && !n) || (x === 0 && (!w || !inCap)) || (x === PW - 1 && (!e || !inCap));
      if (capOutlined) return [OUTLINE, 255];
      return withAlpha(kind.cap(x, y - top, s));
    }
    // Front face.
    if (y === PH - 1 || (x === 0 && !w) || (x === PW - 1 && !e)) return [OUTLINE, 255];
    return withAlpha(kind.face(x, y - faceTop, kind.height));
  }
}

function withAlpha(v) {
  return Array.isArray(v) ? v : [v, 255];
}

function sheetPng(kind) {
  const png = new PNG({ width: PW * 4, height: PH * 4 });
  for (let mask = 0; mask < 16; mask++) {
    const piece = drawPiece(mask, kind);
    const ox = (mask % 4) * PW;
    const oy = Math.floor(mask / 4) * PH;
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const [lum, a] = piece[y][x];
        const i = ((oy + y) * png.width + ox + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = a === 0 ? 0 : lum;
        png.data[i + 3] = a;
      }
    }
  }
  return PNG.sync.write(png);
}

// ── Preview (dev aid): a small room per kind, colorized like the office ──

function readPieces(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const pieces = [];
  for (let mask = 0; mask < 16; mask++) {
    const ox = (mask % 4) * PW;
    const oy = Math.floor(mask / 4) * PH;
    const p = [];
    for (let y = 0; y < PH; y++) {
      const row = [];
      for (let x = 0; x < PW; x++) {
        const i = ((oy + y) * png.width + ox + x) * 4;
        row.push([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]);
      }
      p.push(row);
    }
    pieces.push(p);
  }
  return pieces;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
}

/** The office's Colorize (office/colorize.ts colorizeSprite), one pixel. */
function colorize([r, g, b, a], color) {
  let l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (color.c) l = 0.5 + (l - 0.5) * ((100 + color.c) / 100);
  if (color.b) l += color.b / 200;
  l = Math.max(0, Math.min(1, l));
  return [...hslToRgb(color.h, color.s / 100, l), a];
}

const ROOM = [
  '##########',
  '#........#',
  '#..#.....#',
  '#..#..##.#',
  '#........#',
  '##.###...#',
  '..........',
];

function renderPreview(out, sheets) {
  const colors = [
    { h: 214, s: 30, b: -100, c: -55 }, // the default office's walls
    { h: 30, s: 35, b: -10, c: 0 },
    { h: 0, s: 0, b: 0, c: 0 },
  ];
  const rw = ROOM[0].length * PW;
  const rh = ROOM.length * PW + PW;
  const gap = 8;
  const scale = 3;
  const width = (colors.length * (rw + gap) + gap) * scale;
  const height = (sheets.length * (rh + gap) + gap) * scale;
  const png = new PNG({ width, height });
  const put = (x, y, rgba) => {
    if (x < 0 || y < 0) return;
    const [r, g, b, a] = rgba;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const i = ((y * scale + dy) * width + x * scale + dx) * 4;
        const k = a / 255;
        png.data[i] = Math.round(r * k + png.data[i] * (1 - k));
        png.data[i + 1] = Math.round(g * k + png.data[i + 1] * (1 - k));
        png.data[i + 2] = Math.round(b * k + png.data[i + 2] * (1 - k));
        png.data[i + 3] = 255;
      }
    }
  };
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = 24;
    png.data[i + 1] = 24;
    png.data[i + 2] = 36;
    png.data[i + 3] = 255;
  }
  const isWall = (c, r) => ROOM[r]?.[c] === '#';
  sheets.forEach((pieces, si) => {
    colors.forEach((color, ci) => {
      const ox = gap + ci * (rw + gap);
      const oy = gap + si * (rh + gap) + PW;
      // Floor: a light checker.
      for (let r = 0; r < ROOM.length; r++) {
        for (let c = 0; c < ROOM[0].length; c++) {
          if (isWall(c, r)) continue;
          for (let y = 0; y < PW; y++) {
            for (let x = 0; x < PW; x++) {
              const v = (x === 0 || y === 0 ? 150 : 170) + ((r + c) % 2) * 8;
              put(ox + c * PW + x, oy + r * PW + y, [v, v - 10, v - 25, 255]);
            }
          }
        }
      }
      // Walls, top row first (the office's z order for walls).
      for (let r = 0; r < ROOM.length; r++) {
        for (let c = 0; c < ROOM[0].length; c++) {
          if (!isWall(c, r)) continue;
          let mask = 0;
          if (isWall(c, r - 1)) mask |= 1;
          if (isWall(c + 1, r)) mask |= 2;
          if (isWall(c, r + 1)) mask |= 4;
          if (isWall(c - 1, r)) mask |= 8;
          const p = pieces[mask];
          for (let y = 0; y < PH; y++) {
            for (let x = 0; x < PW; x++) {
              if (p[y][x][3] < 2) continue;
              put(ox + c * PW + x, oy + r * PW + y - PW, colorize(p[y][x], color));
            }
          }
        }
      }
    });
  });
  fs.writeFileSync(out, PNG.sync.write(png));
}

// ── Main ──────────────────────────────────────────────────────────────────

KINDS.forEach((kind, i) => {
  const file = path.join(WALLS_DIR, `wall_${i + 1}.png`);
  fs.writeFileSync(file, sheetPng(kind));
  console.log(`wall_${i + 1}.png  ${kind.name} (height ${kind.height})`);
});

const previewAt = process.argv.indexOf('--preview');
if (previewAt !== -1) {
  const out = process.argv[previewAt + 1];
  const sheets = [0, ...KINDS.map((_, i) => i + 1)].map((n) =>
    readPieces(path.join(WALLS_DIR, `wall_${n}.png`)),
  );
  renderPreview(out, sheets);
  console.log(`preview → ${out}`);
}
