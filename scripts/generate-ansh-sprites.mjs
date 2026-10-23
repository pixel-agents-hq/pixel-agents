#!/usr/bin/env node
/**
 * Generates Ansh's sprite sheet: the office owner drawn as a properly
 * proportioned human (a head about a quarter of his height, a navy blazer over
 * a white shirt, trousers, brown shoes, a gold watch) so he stands apart from
 * the chibi crowd. Same 112×96 format as assets/characters/char_N.png (3
 * direction rows down/up/right × 7 frames of 16×32), so the engine's frame
 * logic (webview-ui/src/office/sprites/spriteData.ts) is untouched:
 *
 *   frames 0 1 2 → walk (1 is also the standing pose; the cycle is 0 1 2 1)
 *   frames 3 4   → typing (seated)
 *   frames 5 6   → reading (seated, a sheet of paper, eyes scanning)
 *
 * Baselines follow the chibi sheets: standing feet end on row 30, seated
 * facing the viewer on row 31, seated facing away on row 25 (the chair back
 * shows in front of him). Left-facing frames are mirrored by the engine.
 *
 * Writes:
 *   webview-ui/public/assets/ansh/ansh_0.png          the sheet (for humans and packs)
 *   webview-ui/src/office/sprites/ansh-sheet.json     the same sheet, palette-keyed,
 *                                                     bundled into the webview
 *
 * Usage: node scripts/generate-ansh-sprites.mjs [--ascii] [--preview <png>]
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

/** Skin and hair match the chibi Ansh wore before (palette 1), so it's still him. */
const PALETTE = {
  O: '#1C1A22', // outline
  H: '#2A1B14', // hair
  h: '#4B3022', // hair highlight
  S: '#E3A582', // skin
  s: '#C4866A', // skin shade
  E: '#1A1212', // eyes
  m: '#A8574B', // mouth
  B: '#2F4A7A', // blazer
  b: '#22375C', // blazer shade
  L: '#5B7CC0', // lapel light
  W: '#F4F4F6', // shirt, paper
  w: '#C9CDD8', // shirt shade, paper lines
  P: '#2B2C33', // trousers
  p: '#1E1F25', // trousers shade
  F: '#6E3F24', // shoes
  f: '#8F5733', // shoe highlight
  G: '#E8C25A', // watch
};

// ── Drawing helpers ────────────────────────────────────────────

const blank = () => Array.from({ length: FRAME_H }, () => new Array(FRAME_W).fill('.'));

/** Stamp rows of art with their top-left at (x, y); '.' is transparent. */
function stamp(g, x, y, art) {
  art.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      const c = line[dx];
      if (c === '.') continue;
      const px = x + dx;
      const py = y + dy;
      if (py < 0 || py >= FRAME_H || px < 0 || px >= FRAME_W) {
        throw new Error(`pixel out of frame: (${px}, ${py})`);
      }
      g[py][px] = c;
    }
  });
}

const rows = (n, line) => new Array(n).fill(line);

// ── Front (facing the viewer) ──────────────────────────────────

const HEAD_FRONT = [
  '.....OOOOOO.....',
  '....OHHhhHHO....',
  '...OHHhhhHHHO...',
  '...OHShSShSHO...',
  '...OHSESSESHO...',
  '...OsSSSsSSsO...',
  '....OSSmmSSO....',
  '.....OsSSsO.....',
  '......OssO......',
];

/** Reading: eyes down at the page, glancing left (frame 5) or right (frame 6). */
function headFrontReading(frame) {
  const head = [...HEAD_FRONT];
  head[4] = '...OHSSSSSSHO...';
  head[5] = frame === 5 ? '...OsESSEsSsO...' : '...OsSSESSEsO...';
  return head;
}

const TORSO_FRONT = [
  '..OBBLWWWWLBBO..',
  '.OBbBBLWWLBBbBO.',
  '.OBbBBLwwLBBbBO.',
  '.OBbBBBLLBBBbBO.',
  '.OBbBBBBBBBBbBO.',
  '.OBbBBBBBBBBbGO.',
  '.OSbbBBBBBBbbSO.',
];

/** Seated at the desk: forearms come in, hands over the keyboard. */
const TORSO_FRONT_SEATED = [
  '..OBBLWWWWLBBO..',
  '.OBbBBLWWLBBbBO.',
  '.OBbBBLwwLBBbBO.',
  '.OBbBBBLLBBBbBO.',
  '.OBbBBBBBBBBbBO.',
  '.ObBBBBBBBBBBbO.',
  '..ObbBBBBBBbbO..',
];

const HIPS_FRONT = ['..OOPPPPPPPPOO..', '...OPPPPPPPPO...'];

/** One front leg at column x (5 wide incl. outlines), `len` trouser rows from y, then the shoe. */
function legFront(g, x, y, len, left) {
  stamp(g, x, y, rows(len, 'OPPpO'));
  stamp(g, x, y + len, ['OfFFO']);
  stamp(g, left ? x - 1 : x, y + len + 1, ['OFFFFO']);
  stamp(g, left ? x : x + 1, y + len + 2, ['OOOO']);
}

function frontStanding(frame) {
  const g = blank();
  const lifted = frame !== 1; // mid-stride: the body bobs up a px
  const top = lifted ? 0 : 1;
  stamp(g, 0, top, HEAD_FRONT);
  stamp(g, 0, top + 9, TORSO_FRONT);
  stamp(g, 0, top + 16, HIPS_FRONT);
  const legY = top + 18;
  if (!lifted) {
    legFront(g, 3, legY, 9, true);
    legFront(g, 8, legY, 9, false);
  } else {
    // The striding leg reaches the floor (row 30); the other is lifted.
    const leftLong = frame === 0;
    legFront(g, 3, legY, leftLong ? 10 : 8, true);
    legFront(g, 8, legY, leftLong ? 8 : 10, false);
  }
  return g;
}

function frontSeated(frame) {
  const g = blank();
  const typing = frame === 3 || frame === 4;
  stamp(g, 0, 7, typing ? HEAD_FRONT : headFrontReading(frame));
  stamp(g, 0, 16, TORSO_FRONT_SEATED);
  // Lap (thighs toward the viewer), shins, shoes: ends on row 31.
  stamp(g, 0, 23, ['..OOPPPPPPPPOO..', '..OPPPPPPPPPPO..']);
  legFront(g, 3, 25, 4, true);
  legFront(g, 8, 25, 4, false);
  if (typing) {
    // Hands over the keys, tapping in turn; the watch on his left wrist.
    const leftUp = frame === 4;
    stamp(g, 3, leftUp ? 21 : 22, ['SS']);
    stamp(g, 11, leftUp ? 22 : 21, ['GS']);
  } else {
    // A sheet of paper held up in both hands.
    stamp(g, 4, 19, ['OWWWWWWO', 'OWwwwwWO', 'SWwwwWWS', 'SWWWWWWG', '.OOOOOO.']);
  }
  return g;
}

// ── Back (facing away) ─────────────────────────────────────────

const HEAD_BACK = [
  '.....OOOOOO.....',
  '....OHHhhHHO....',
  '...OHHhhhHHHO...',
  '...OHHHhHHHHO...',
  '...OHHHHHHHHO...',
  '...OsHHHHHHsO...',
  '....OHHHHHHO....',
  '.....OsHHsO.....',
  '......OssO......',
];

const TORSO_BACK = [
  '..OBBBBwwBBBBO..',
  '.OBbBBBBBBBBbBO.',
  '.OBbBBBBBBBBbBO.',
  '.OBbBBBbbBBBbBO.',
  '.OBbBBBbbBBBbBO.',
  '.OGbBBBbbBBBbBO.',
  '.OSbbBBbbBBbbSO.',
];

/** Seated facing away: the arms reach forward, so the elbows show, no hands. */
function torsoBackSeated(frame) {
  const torso = [...TORSO_BACK];
  torso[5] = '.ObbBBBbbBBBbbO.';
  torso[6] = '..ObBBBbbBBBbO..';
  if (frame === 4) torso[5] = '.ObbBBBbbBBBbBO.';
  return torso;
}

function legBack(g, x, y, len, left) {
  stamp(g, x, y, rows(len, 'OPPpO'));
  stamp(g, x, y + len, ['OFFFO']);
  stamp(g, left ? x - 1 : x, y + len + 1, ['OFFFFO']);
  stamp(g, left ? x : x + 1, y + len + 2, ['OOOO']);
}

function backStanding(frame) {
  const g = blank();
  const lifted = frame !== 1;
  const top = lifted ? 0 : 1;
  stamp(g, 0, top, HEAD_BACK);
  stamp(g, 0, top + 9, TORSO_BACK);
  stamp(g, 0, top + 16, HIPS_FRONT);
  const legY = top + 18;
  if (!lifted) {
    legBack(g, 3, legY, 9, true);
    legBack(g, 8, legY, 9, false);
  } else {
    const leftLong = frame === 0;
    legBack(g, 3, legY, leftLong ? 10 : 8, true);
    legBack(g, 8, legY, leftLong ? 8 : 10, false);
  }
  return g;
}

function backSeated(frame) {
  const g = blank();
  stamp(g, 0, 7, HEAD_BACK);
  stamp(g, 0, 16, torsoBackSeated(frame));
  // The seat of his trousers; the chair back covers the rest (ends on row 25).
  stamp(g, 0, 23, ['..OOPPPPPPPPOO..', '..OPPPPPPPPPPO..', '...OOOOOOOOOO...']);
  return g;
}

// ── Side (facing right; the engine mirrors it for left) ────────

const HEAD_SIDE = [
  '......OOOOO.....',
  '.....OHHhhhO....',
  '....OHHHhhhHO...',
  '....OHHHHHhSO...',
  '....OHHsSSESO...',
  '....OHHsSSSSS...',
  '....OHHHSSSmO...',
  '.....OHsSSSO....',
  '......OssSO.....',
];

/** Reading: the eye drops to the page in his hands. */
const HEAD_SIDE_READING = HEAD_SIDE.map((line, i) =>
  i === 4 ? '....OHHsSSSSO...' : i === 5 ? '....OHHsSSESS...' : line,
);

/** Side torso; `hand` is the column of the hanging hand (the arm swings). */
function torsoSide(hand) {
  const t = [
    '.....OBBBBWO....',
    '....OBBBBBLWO...',
    '....OBBbBBBLO...',
    '....OBBbBBBBO...',
    '....OBBbBBBBO...',
    '....OBBbBBBBO...',
    '....OBBBBBBBO...',
  ];
  const out = t.map((l) => l.split(''));
  out[5][hand] = 'G';
  out[6][hand] = 'S';
  return out.map((r) => r.join(''));
}

/**
 * A side leg from (x, y): `len` trouser rows, each row shifted by `slope`
 * (columns per row, rounded) so a striding leg angles forward or back, then a
 * shoe pointing right.
 */
function legSide(g, x, y, len, slope, shade) {
  let col = x;
  for (let i = 0; i < len; i++) {
    col = x + Math.round(slope * i);
    stamp(g, col, y + i, [shade ? 'OppO' : 'OPpO']);
  }
  stamp(g, col, y + len, [shade ? 'OFFFO' : 'OfFFO']);
  stamp(g, col, y + len + 1, ['OFFFFO']);
  stamp(g, col + 1, y + len + 2, ['OOOO']);
}

function sideStanding(frame) {
  const g = blank();
  const lifted = frame !== 1;
  const top = lifted ? 0 : 1;
  const legY = top + 18;
  if (!lifted) {
    legSide(g, 6, legY, 9, 0, false);
  } else {
    // Stride: the far leg (shaded) behind, the near leg in front.
    const nearForward = frame === 0;
    legSide(g, 6, legY, 10, nearForward ? -0.3 : 0.3, true);
    legSide(g, 6, legY, 10, nearForward ? 0.3 : -0.3, false);
  }
  stamp(g, 0, top, HEAD_SIDE);
  stamp(g, 0, top + 9, torsoSide(lifted ? (frame === 0 ? 6 : 9) : 7));
  stamp(g, 0, top + 16, ['....OPPPPPPPO...', '.....OPPPPPO....']);
  return g;
}

function sideSeated(frame) {
  const g = blank();
  const typing = frame === 3 || frame === 4;
  stamp(g, 0, 7, typing ? HEAD_SIDE : HEAD_SIDE_READING);
  const torso = [
    '.....OBBBBWO....',
    '....OBBBBBLWO...',
    '....OBBbBBBLO...',
    '....OBBbBBBBO...',
    '....OBBbbbbbbbO.',
    '....OBBBBBBBBGSO',
    '....OBBBBBBBOOO.',
  ];
  if (typing && frame === 4) {
    // The hand lifts a row to tap.
    torso[4] = '....OBBbbbbbbGSO';
    torso[5] = '....OBBBBBBBBOO.';
  }
  if (!typing) {
    // The page held up in front of him.
    torso[1] = '....OBBBBBLWOWW.';
    torso[2] = '....OBBbBBBLOwW.';
    torso[3] = '....OBBbBBBBOwW.';
    torso[4] = '....OBBbbbbbbSW.';
    torso[5] = '....OBBBBBBBBGO.';
  }
  stamp(g, 0, 16, torso);
  // Thigh forward to the knee, shin down, shoe: ends on row 31.
  stamp(g, 0, 23, ['....OPPPPPPPPO..', '....OPPPPPPPPO..']);
  stamp(g, 9, 25, rows(4, 'OPPpO'));
  stamp(g, 9, 29, ['OfFFFO', 'OFFFFFO']);
  stamp(g, 10, 31, ['OOOOO']);
  return g;
}

function frameFor(dir, frame) {
  const standing = frame <= 2;
  if (dir === 'down') return standing ? frontStanding(frame) : frontSeated(frame);
  if (dir === 'up') return standing ? backStanding(frame) : backSeated(frame);
  return standing ? sideStanding(frame) : sideSeated(frame);
}

// ── The sheet ──────────────────────────────────────────────────

function buildSheet() {
  const sheet = Array.from({ length: SHEET_H }, () => new Array(SHEET_W).fill('.'));
  DIRECTIONS.forEach((dir, di) => {
    for (let f = 0; f < FRAMES; f++) {
      const g = frameFor(dir, f);
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) sheet[di * FRAME_H + y][f * FRAME_W + x] = g[y][x];
      }
    }
  });
  return sheet.map((r) => r.join(''));
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function sheetToPng(sheetRows, zoom = 1) {
  const png = new PNG({ width: SHEET_W * zoom, height: SHEET_H * zoom });
  for (let y = 0; y < SHEET_H; y++) {
    for (let x = 0; x < SHEET_W; x++) {
      const key = sheetRows[y][x];
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
  const sheetRows = buildSheet();

  if (args.includes('--ascii')) {
    for (const row of sheetRows) console.log(row);
  }
  const previewAt = args.indexOf('--preview');
  if (previewAt >= 0 && args[previewAt + 1]) {
    fs.writeFileSync(args[previewAt + 1], sheetToPng(sheetRows, 8));
  }

  const pngPath = path.join(root, 'webview-ui', 'public', 'assets', 'ansh', 'ansh_0.png');
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, sheetToPng(sheetRows));

  const jsonPath = path.join(root, 'webview-ui', 'src', 'office', 'sprites', 'ansh-sheet.json');
  const json = {
    $comment: 'Generated by scripts/generate-ansh-sprites.mjs. Do not edit by hand.',
    frameW: FRAME_W,
    frameH: FRAME_H,
    frames: FRAMES,
    directions: DIRECTIONS,
    palette: PALETTE,
    rows: sheetRows,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, pngPath)} and ${path.relative(root, jsonPath)}`);
}

main();
