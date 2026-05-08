/**
 * Generates the Tiago owner character sprite (char_6.png).
 * Run: npx ts-node scripts/generate-tiago.ts
 * Output: webview-ui/public/assets/characters/char_6.png
 *
 * Format: 112×96 PNG — 7 frames × 16px wide, 3 direction rows × 32px tall
 * Row 0 = down, Row 1 = up, Row 2 = right (left is flipped at runtime)
 * Frame order: walk1, walk2, walk3, type1, type2, read1, read2
 */
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Color palette ─────────────────────────────────────────────────────────────

const C: Record<string, [number, number, number, number]> = {
  '.': [0, 0, 0, 0], // transparent
  H: [28, 14, 5, 255], // dark locs
  h: [58, 26, 8, 255], // mid locs
  F: [92, 43, 10, 255], // dark skin
  f: [122, 58, 24, 255], // skin highlight
  G: [26, 26, 26, 255], // glasses frame
  L: [90, 122, 170, 255], // glasses lens (subtle blue)
  S: [26, 61, 43, 255], // shirt Verde Sentinela
  s: [13, 31, 22, 255], // shirt shadow
  P: [26, 26, 46, 255], // pants
  B: [10, 10, 10, 255], // shoes
};

function row(str: string): Array<[number, number, number, number]> {
  return str.split('').map((c) => C[c] ?? C['.']);
}

// ── Reusable building blocks ───────────────────────────────────────────────────

const PAD = '................';

// Upper body facing DOWN (rows 0–23) — shared by all down frames
const HEAD_DOWN = [
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD, // rows 0-7 top padding
  '.....HhHhH......', // row 8  bun top
  '....HhhhhhH.....', // row 9  bun mid
  '...HHhhhhhHH....', // row 10 bun base
  '...HhHhHHhHh....', // row 11 bun texture
  '.....FFFFFF.....', // row 12 forehead
  '.....GGGGGG.....', // row 13 glasses top
  '.....GLLLLG.....', // row 14 glasses lens
  '.....GGGGGG.....', // row 15 glasses bottom
  '.....Ff..fF.....', // row 16 nose/cheeks
  '.....FFFFFF.....', // row 17 chin
  '.....sSss.......', // row 18 neck
  '....sSSSSs......', // row 19 upper shirt
  '...sSSSSSSSs....', // row 20 shirt chest
  '...sSSSSSSSs....', // row 21 shirt body
  '...sSSSSSSSs....', // row 22 shirt lower
  '....sSSSSSs.....', // row 23 shirt hem
];

// Upper body facing UP (back of character) — bun prominent
const HEAD_UP = [
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  '....HHHHHHHH....', // row 8  back of bun
  '...HHHhhhHHHH...', // row 9  bun detail
  '..HHHhhhhhHHHH..', // row 10 bun wide
  '...HHhhhhhHHH...', // row 11 bun
  '....HHhhhHHH....', // row 12 bun narrows
  '.....HhHhHH.....', // row 13 top of head
  '.....FFFFFFF....', // row 14 back of neck/head
  '.....FFFFFFF....', // row 15
  '.....FFFFFFF....', // row 16
  '.....FFFFFF.....', // row 17 neck
  '.....sSss.......', // row 18
  '....sSSSSs......', // row 19
  '...sSSSSSSSs....', // row 20
  '...sSSSSSSSs....', // row 21
  '...sSSSSSSSs....', // row 22
  '....sSSSSSs.....', // row 23
];

// Upper body facing RIGHT (side profile)
const HEAD_RIGHT = [
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  PAD,
  '....HhHHHH......', // row 8  bun from side
  '....HhhhhHH.....', // row 9  bun
  '...HHhhhhhH.....', // row 10 bun base
  '....HhHhHH......', // row 11 hair side
  '.....FFFF.......', // row 12 forehead (narrower in profile)
  '.....FFFF.......', // row 13 upper face
  '.....FfGG.......', // row 14 glasses in profile (right side frame)
  '.....FFFF.......', // row 15 below glasses
  '.....FFFF.......', // row 16 cheeks
  '.....FFFF.......', // row 17 chin
  '.....sSs........', // row 18 neck
  '....sSSSSs......', // row 19
  '....sSSSSSSs....', // row 20
  '....sSSSSSSs....', // row 21
  '....sSSSSSSs....', // row 22
  '.....sSSSs......', // row 23
];

// ── Leg/feet variants ──────────────────────────────────────────────────────────

const DOWN_LEGS: Record<string, string[]> = {
  walk1: [
    '.....PPPPPP.....', // row 24 waist
    '.....PP..PP.....', // row 25
    '.....PP..PP.....', // row 26
    '.....PP..PP.....', // row 27
    '.....BB..PP.....', // row 28 left shoe early
    '....BBB..PP.....', // row 29
    '.........BB.....', // row 30 right shoe ahead
    PAD,
  ],
  walk2: [
    '.....PPPPPP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....BB..BB.....',
    '....BBB..BBB....',
    PAD,
    PAD,
  ],
  walk3: [
    '.....PPPPPP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..BB.....', // row 28 right shoe early
    '.....PP..BBB....',
    '.....BB.........',
    PAD,
  ],
  sit: ['.....PPPPPP.....', '.....PP..PP.....', '.....PP..PP.....', PAD, PAD, PAD, PAD, PAD],
};

const UP_LEGS: Record<string, string[]> = {
  walk1: [
    '.....PPPPPP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....BB..PP.....',
    '....BBB..PP.....',
    '.........BB.....',
    PAD,
  ],
  walk2: [
    '.....PPPPPP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....BB..BB.....',
    '....BBB..BBB....',
    PAD,
    PAD,
  ],
  walk3: [
    '.....PPPPPP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..PP.....',
    '.....PP..BB.....',
    '.....PP..BBB....',
    '.....BB.........',
    PAD,
  ],
  sit: ['.....PPPPPP.....', '.....PP..PP.....', '.....PP..PP.....', PAD, PAD, PAD, PAD, PAD],
};

const RIGHT_LEGS: Record<string, string[]> = {
  walk1: [
    '.....PPPPP......',
    '.....PP.PP......',
    '.....PP.PP......',
    '....PPP.PP......',
    '....PPP.BB......',
    '....PPP.BBB.....',
    '....BB..........',
    PAD,
  ],
  walk2: [
    '.....PPPPP......',
    '.....PP.PP......',
    '.....PP.PP......',
    '.....PP.PP......',
    '.....BB.BB......',
    '....BBB.BBB.....',
    PAD,
    PAD,
  ],
  walk3: [
    '.....PPPPP......',
    '.....PP.PP......',
    '.....PP.PP......',
    '.....PP.PPP.....',
    '.....BB.PPP.....',
    '.....BB.PPP.....',
    '.........BB.....',
    PAD,
  ],
  sit: ['.....PPPPP......', '.....PP.PP......', '.....PP.PP......', PAD, PAD, PAD, PAD, PAD],
};

// ── Assemble frames ────────────────────────────────────────────────────────────

function makeFrames(head: string[], legs: Record<string, string[]>): string[][] {
  return [
    [...head, ...legs.walk1], // frame 0: walk1
    [...head, ...legs.walk2], // frame 1: walk2
    [...head, ...legs.walk3], // frame 2: walk3
    [...head, ...legs.sit], // frame 3: type1
    [...head, ...legs.sit], // frame 4: type2
    [...head, ...legs.sit], // frame 5: read1
    [...head, ...legs.sit], // frame 6: read2
  ];
}

const FRAMES = {
  down: makeFrames(HEAD_DOWN, DOWN_LEGS),
  up: makeFrames(HEAD_UP, UP_LEGS),
  right: makeFrames(HEAD_RIGHT, RIGHT_LEGS),
};

// ── Render to PNG ──────────────────────────────────────────────────────────────

const FRAME_W = 16;
const FRAME_H = 32;
const NUM_FRAMES = 7;
const IMG_W = FRAME_W * NUM_FRAMES; // 112
const IMG_H = FRAME_H * 3; // 96

const png = new PNG({ width: IMG_W, height: IMG_H, filterType: -1 });

function paint(dirIndex: number, frameIndex: number, frameRows: string[]): void {
  const baseX = frameIndex * FRAME_W;
  const baseY = dirIndex * FRAME_H;
  for (let r = 0; r < FRAME_H; r++) {
    const rowStr = frameRows[r] ?? PAD;
    const pixels = row(rowStr);
    for (let c = 0; c < FRAME_W; c++) {
      const idx = ((baseY + r) * IMG_W + (baseX + c)) * 4;
      const [R, G, B, A] = pixels[c] ?? [0, 0, 0, 0];
      png.data[idx] = R;
      png.data[idx + 1] = G;
      png.data[idx + 2] = B;
      png.data[idx + 3] = A;
    }
  }
}

// DOWN = dir index 0, UP = 1, RIGHT = 2
const DIRS: Array<'down' | 'up' | 'right'> = ['down', 'up', 'right'];
for (let d = 0; d < DIRS.length; d++) {
  const dir = DIRS[d];
  for (let f = 0; f < NUM_FRAMES; f++) {
    paint(d, f, FRAMES[dir][f]);
  }
}

// ── Write output ───────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'characters');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'char_6.png');
writeFileSync(outFile, PNG.sync.write(png));
console.log(`✓ Wrote ${outFile}`);
