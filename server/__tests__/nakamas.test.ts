import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import { convertNakamaViews, type RgbaImage } from '../../core/src/assets/nakamaConverter.js';
import { loadNakamaIndex } from '../src/nakamas/nakamaIndex.js';
import { NakamaSprites } from '../src/nakamas/nakamaSprites.js';

// Synthetic art only: the owner's characters are copyrighted and never enter the repo.

const WHITE = [255, 255, 255, 255] as const;
const OUTLINE = [20, 20, 30, 255] as const;
const BODY = [200, 40, 40, 255] as const;
/** How the converter writes an opaque colour. */
const hex = (c: readonly number[]) => rgbaToHex(c[0], c[1], c[2], 255);

/** A white canvas with a dark-outlined red body, a white "eye" inside it. */
function figure(
  canvas: number,
  body: { x: number; y: number; w: number; h: number },
  eye = true,
): RgbaImage {
  const data = new Uint8Array(canvas * canvas * 4);
  const put = (x: number, y: number, c: readonly number[]) => data.set(c, (y * canvas + x) * 4);
  for (let y = 0; y < canvas; y++) for (let x = 0; x < canvas; x++) put(x, y, WHITE);
  for (let y = body.y; y < body.y + body.h; y++) {
    for (let x = body.x; x < body.x + body.w; x++) {
      const edge =
        x === body.x || y === body.y || x === body.x + body.w - 1 || y === body.y + body.h - 1;
      put(x, y, edge ? OUTLINE : BODY);
    }
  }
  if (eye) {
    // A 4x4 white patch, fully enclosed by red: must survive background removal.
    for (let y = body.y + 4; y < body.y + 8; y++) {
      for (let x = body.x + 4; x < body.x + 8; x++) put(x, y, WHITE);
    }
  }
  return { width: canvas, height: canvas, data };
}

const views = (img: RgbaImage) => ({ down: img, up: img, left: img, right: img });

describe('convertNakamaViews', () => {
  it('makes the white background transparent and keeps white enclosed by the outline', () => {
    // Body 32 px tall maps 1:1 to the 32 px target, so pixels can be read directly.
    const out = convertNakamaViews(views(figure(64, { x: 10, y: 16, w: 16, h: 32 })));
    const down = out.down;
    expect(down).toHaveLength(32);
    expect(down[0][0]).toBe(hex(OUTLINE)); // outline corner
    expect(down[1][1]).toBe(hex(BODY)); // body
    expect(down[5][5]).toBe(hex(WHITE)); // the enclosed white eye stays
    const flat = down.flat();
    expect(flat).not.toContain('');
  });

  it('scales all four views by one factor and bottom-aligns them on one canvas', () => {
    const tall = figure(128, { x: 20, y: 0, w: 20, h: 128 }, false);
    const short = figure(128, { x: 20, y: 64, w: 20, h: 64 }, false);
    const out = convertNakamaViews({ down: tall, up: short, left: tall, right: tall });
    // Tallest view sets the scale: 128 -> 32, so the short view is 16 px tall.
    for (const key of ['down', 'up', 'left', 'right'] as const) {
      expect(out[key]).toHaveLength(32);
      expect(out[key][0]).toHaveLength(out.down[0].length);
    }
    const opaqueRows = out.up.filter((row) => row.some((px) => px !== '')).length;
    expect(opaqueRows).toBe(16);
    expect(out.up[31].some((px) => px !== '')).toBe(true); // feet on the ground
    expect(out.up[0].every((px) => px === '')).toBe(true);
  });

  it('keeps very wide characters inside the max width', () => {
    const wide = figure(256, { x: 0, y: 200, w: 256, h: 40 }, false);
    const out = convertNakamaViews(views(wide));
    expect(out.down[0].length).toBeLessThanOrEqual(32);
  });

  it('returns empty sprites for a blank (all white) image instead of throwing', () => {
    const blank: RgbaImage = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) };
    const out = convertNakamaViews(views(blank));
    expect(out.down.flat().every((px) => px === '')).toBe(true);
  });

  /** Blank white canvas plus a painter, for shapes `figure` can't draw. */
  function canvasOf(size: number) {
    const img: RgbaImage = { width: size, height: size, data: new Uint8Array(size * size * 4) };
    const put = (x: number, y: number, c: readonly number[]) => img.data.set(c, (y * size + x) * 4);
    const rect = (x0: number, y0: number, w: number, h: number, c: readonly number[]) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c);
    };
    rect(0, 0, size, size, WHITE);
    return { img, rect };
  }
  const LIGHT_HAIR = [240, 240, 250, 255] as const;
  const opaque = (sprite: string[][]) => sprite.flat().filter((px) => px !== '').length;

  it('keeps light hair drawn behind an outline with a small break', () => {
    const { img, rect } = canvasOf(64);
    // A 32x32 outlined box of near-white "hair"; its top edge has a 4 px break.
    rect(16, 16, 32, 32, OUTLINE);
    rect(17, 17, 30, 30, LIGHT_HAIR);
    rect(30, 16, 4, 1, WHITE);
    const out = convertNakamaViews(views(img));
    // Without sealing the break, the flood would empty the whole box.
    expect(out.down[16][16]).toBe(hex(LIGHT_HAIR));
    expect(opaque(out.down)).toBeGreaterThan(32 * 32 * 0.9);
  });

  it('keeps a body cropped at the bottom edge of the sheet', () => {
    const { img, rect } = canvasOf(64);
    // Outline on the top and sides only; the white body runs off the bottom.
    rect(16, 32, 32, 1, OUTLINE);
    rect(16, 32, 1, 32, OUTLINE);
    rect(47, 32, 1, 32, OUTLINE);
    const out = convertNakamaViews(views(img));
    expect(out.down[31][16]).toBe(hex(WHITE)); // white body, bottom row, kept
    expect(opaque(out.down)).toBe(32 * 32);
  });

  it('drops stray marks far from the character but keeps a detached part next to it', () => {
    const { img, rect } = canvasOf(128);
    rect(40, 64, 32, 64, BODY); // the character: 32x64
    rect(74, 110, 10, 18, BODY); // a "tail" 2 px away: 180 px, 8.8% -> kept
    rect(100, 4, 12, 12, BODY); // a mark far above: 144 px, 7% -> dropped
    rect(4, 4, 2, 2, BODY); // a tiny speck -> dropped
    const out = convertNakamaViews(views(img));
    // Only the character and tail set the box: 64 px tall -> scale 1/2, 32 rows.
    const rows = out.down.filter((row) => row.some((px) => px !== '')).length;
    expect(rows).toBe(32);
    // Character 16 px + 1 px gap + tail 5 px wide = 22 px canvas.
    expect(out.down[0]).toHaveLength(22);
  });
});

function writePng(file: string, img: RgbaImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function writeCharacter(root: string, collection: string, name: string, views = 'FBLR'): void {
  const dir = path.join(root, 'assets', 'nakamas', collection, name);
  for (const v of views) {
    writePng(path.join(dir, `${name}_${v}.png`), figure(32, { x: 8, y: 4, w: 12, h: 24 }));
  }
}

describe('loadNakamaIndex', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-nakamas-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every complete character, skipping _ folders and characters missing a view', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    writeCharacter(root, '01_Alpha', 'Half_Done', 'FB');
    writeCharacter(root, '01_Alpha', '_Laminas');
    writeCharacter(root, '_Extra', 'Hidden');
    const index = loadNakamaIndex([root]);
    expect(index.map((n) => n.id)).toEqual(['01_Alpha/Hero_One']);
    expect(index[0].name).toBe('Hero One');
    expect(Object.keys(index[0].views).sort()).toEqual(['down', 'left', 'right', 'up']);
  });

  it('reads the display name from posiciones.json when present', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    fs.writeFileSync(
      path.join(root, 'assets', 'nakamas', '01_Alpha', 'Hero_One', 'posiciones.json'),
      JSON.stringify({ personaje: 'Hero Uno' }),
    );
    expect(loadNakamaIndex([root])[0].name).toBe('Hero Uno');
  });

  it('takes the tier from modelos.json: collection first, then per-character overrides', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    writeCharacter(root, '01_Alpha', 'Hero_Two');
    writeCharacter(root, '02_Beta', 'Hero_Three');
    writeCharacter(root, '03_Gamma', 'Hero_Four');
    fs.writeFileSync(
      path.join(root, 'assets', 'nakamas', 'modelos.json'),
      JSON.stringify({
        colecciones: { '01_Alpha': 'haiku', '02_Beta': null, '03_Gamma': 'GPT' },
        personajes: { '01_Alpha/Hero_Two': 'Opus' },
      }),
    );
    const tiers = Object.fromEntries(loadNakamaIndex([root]).map((n) => [n.id, n.tier]));
    expect(tiers).toEqual({
      '01_Alpha/Hero_One': 'haiku',
      '01_Alpha/Hero_Two': 'opus',
      '02_Beta/Hero_Three': null,
      '03_Gamma/Hero_Four': null, // not a known tier
    });
  });

  it('treats a missing or broken modelos.json as no categories', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    expect(loadNakamaIndex([root])[0].tier).toBeNull();
    fs.writeFileSync(path.join(root, 'assets', 'nakamas', 'modelos.json'), '{ not json');
    expect(loadNakamaIndex([root])[0].tier).toBeNull();
  });

  it('merges several asset directories; the first one wins on a duplicate id', () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-nakamas-'));
    try {
      writeCharacter(root, '01_Alpha', 'Hero_One');
      writeCharacter(second, '01_Alpha', 'Hero_One');
      writeCharacter(second, '02_Beta', 'Hero_Two');
      const index = loadNakamaIndex([root, second]);
      expect(index.map((n) => n.id)).toEqual(['01_Alpha/Hero_One', '02_Beta/Hero_Two']);
      expect(index[0].views.down.startsWith(root)).toBe(true);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('is empty when no directory has a nakamas folder', () => {
    expect(loadNakamaIndex([root, path.join(root, 'missing')])).toEqual([]);
  });
});

describe('NakamaSprites', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-nakamas-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('converts a Nakama on first use and serves it from the cache after that', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    const sprites = new NakamaSprites(loadNakamaIndex([root]));
    const first = sprites.get('01_Alpha/Hero_One');
    expect(first?.down).toHaveLength(32);
    expect(sprites.get('01_Alpha/Hero_One')).toBe(first);
    expect(sprites.get('nope/none')).toBeNull();
  });

  it('returns null for a Nakama whose files became unreadable', () => {
    writeCharacter(root, '01_Alpha', 'Hero_One');
    const index = loadNakamaIndex([root]);
    fs.writeFileSync(index[0].views.up, 'not a png');
    expect(new NakamaSprites(index).get('01_Alpha/Hero_One')).toBeNull();
  });
});
