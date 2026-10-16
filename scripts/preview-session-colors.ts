import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  buildClothesColorMap,
  recolorClothes,
  resolveSessionColor,
} from '../webview-ui/src/office/sprites/sessionColor.js';

const dir = path.join(import.meta.dirname, '..', 'webview-ui', 'public', 'assets', 'characters');
const out = process.argv[2] ?? 'session-colors.png';
const colors = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
const SCALE = 4;

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function readSheet(i: number): string[][][] {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, `char_${i}.png`)));
  const frames: string[][][] = [];
  for (let fy = 0; fy < 3; fy++) {
    for (let fx = 0; fx < 7; fx++) {
      const f: string[][] = [];
      for (let y = 0; y < 32; y++) {
        const row: string[] = [];
        for (let x = 0; x < 16; x++) {
          const o = ((fy * 32 + y) * png.width + fx * 16 + x) * 4;
          const a = png.data[o + 3];
          row.push(
            a < 2 ? '' : `#${hex(png.data[o])}${hex(png.data[o + 1])}${hex(png.data[o + 2])}`,
          );
        }
        f.push(row);
      }
      frames.push(f);
    }
  }
  return frames;
}

// Per sheet: front and side, standing (down 0, right 0) and typing (down 3, right 5), per color
const sheets = [0, 1, 2, 3, 4, 5].map(readSheet);
const W = colors.length * 4 * 18 * SCALE;
const H = sheets.length * 34 * SCALE;
const img = new PNG({ width: W, height: H });
img.data.fill(235);
sheets.forEach((frames, si) => {
  colors.forEach((c, ci) => {
    const hsl = resolveSessionColor(c);
    const map = hsl ? buildClothesColorMap(frames.slice(0, 14), frames.slice(14), hsl) : null;
    [frames[0], frames[14], frames[3], frames[19]].forEach((f, k) => {
      const fr = map ? recolorClothes(f, map) : f;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 16; x++) {
          const px = fr[y][x];
          if (!px) continue;
          const r = parseInt(px.slice(1, 3), 16);
          const g = parseInt(px.slice(3, 5), 16);
          const b = parseInt(px.slice(5, 7), 16);
          for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) {
              const X = ((ci * 4 + k) * 18 + 1 + x) * SCALE + dx;
              const Y = (si * 34 + 1 + y) * SCALE + dy;
              const o = (Y * W + X) * 4;
              img.data[o] = r;
              img.data[o + 1] = g;
              img.data[o + 2] = b;
              img.data[o + 3] = 255;
            }
          }
        }
      }
    });
  });
});
fs.writeFileSync(out, PNG.sync.write(img));
console.log('written', out);
