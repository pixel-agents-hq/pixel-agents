/**
 * Nakama conversion: four static character poses on a white canvas (front,
 * back, facing left, facing right) become office-sized SpriteData.
 *
 * Pure: takes decoded RGBA images, returns sprites. Decoding and file access
 * live in the server.
 */

import { rgbaToHex } from './colorUtils.js';
import {
  CHAR_FRAME_W,
  NAKAMA_COVERAGE_THRESHOLD,
  NAKAMA_FAR_PART_GAP_PX,
  NAKAMA_FAR_PART_RATIO,
  NAKAMA_HEIGHT_PX,
  NAKAMA_MAX_WIDTH_PX,
  NAKAMA_MIN_PART_RATIO,
  NAKAMA_OUTLINE_GAP_PX,
  NAKAMA_WHITE_TOLERANCE,
} from './constants.js';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

export type NakamaViewKey = 'down' | 'up' | 'left' | 'right';
export const NAKAMA_VIEW_KEYS: readonly NakamaViewKey[] = ['down', 'up', 'left', 'right'];
export type NakamaViews<T> = Record<NakamaViewKey, T>;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 1 where the pixel is transparent or near-white (could be background). */
function whiteMask(img: RgbaImage): Uint8Array {
  const { data } = img;
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    mask[i] =
      data[p + 3] === 0 ||
      (255 - data[p] <= NAKAMA_WHITE_TOLERANCE &&
        255 - data[p + 1] <= NAKAMA_WHITE_TOLERANCE &&
        255 - data[p + 2] <= NAKAMA_WHITE_TOLERANCE)
        ? 1
        : 0;
  }
  return mask;
}

/** Square dilation of a 0/1 mask by `r` pixels, as two separable passes. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const dst = new Uint8Array(src.length);
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    const at = (line: number, k: number) => (horizontal ? line * w + k : k * w + line);
    for (let line = 0; line < lines; line++) {
      // Running count of set pixels in the window [k - r, k + r].
      let count = 0;
      for (let k = 0; k < Math.min(r, len); k++) count += src[at(line, k)];
      for (let k = 0; k < len; k++) {
        if (k + r < len) count += src[at(line, k + r)];
        if (k - r - 1 >= 0) count -= src[at(line, k - r - 1)];
        dst[at(line, k)] = count > 0 ? 1 : 0;
      }
    }
    return dst;
  };
  return pass(pass(mask, true), false);
}

/** Pixels of `open` (0/1) reachable from the top, left and right edges. The
 *  bottom edge is not a source: art cropped at the feet would otherwise be
 *  flooded through the cut. */
function floodFromEdges(open: Uint8Array, w: number, h: number): Uint8Array {
  const reached = new Uint8Array(w * h);
  const stack: number[] = [];
  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (reached[i] || !open[i]) return;
    reached[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) visit(x, 0);
  for (let y = 0; y < h; y++) {
    visit(0, y);
    visit(w - 1, y);
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  return reached;
}

/** Copy of `img` with the white background made fully transparent.
 *
 *  The background is the near-white reachable from the edges, found with the
 *  outline first thickened by NAKAMA_OUTLINE_GAP_PX (a morphological closing):
 *  light hair or fur drawn inside an outline with small breaks would otherwise
 *  be flooded through the break. White enclosed by the outline (eyes,
 *  highlights, white clothes) is kept. */
function removeBackground(img: RgbaImage): Uint8Array {
  const { width: w, height: h } = img;
  const white = whiteMask(img);
  const solid = white.map((v) => 1 - v);
  const sealed = dilate(solid, w, h, NAKAMA_OUTLINE_GAP_PX);
  const outside = floodFromEdges(
    sealed.map((v) => 1 - v),
    w,
    h,
  );
  const background = dilate(outside, w, h, NAKAMA_OUTLINE_GAP_PX);
  const out = Uint8Array.from(img.data);
  for (let i = 0; i < white.length; i++) {
    if (white[i] && background[i]) out[i * 4 + 3] = 0;
  }
  return out;
}

interface Part {
  size: number;
  box: Box;
}

/** Gap in pixels between two boxes; 0 when they touch or overlap. */
function boxGap(a: Box, b: Box): number {
  return Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
}

/** Clear stray marks on the sheet: 8-connected opaque parts that are tiny next
 *  to the largest part, or small and floating away from it. A tail or a held
 *  object drawn apart from the body is close to it and stays. */
function removeSpecks(data: Uint8Array, w: number, h: number): void {
  const label = new Int32Array(w * h).fill(-1);
  const parts: Part[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || data[start * 4 + 3] === 0) continue;
    const id = parts.length;
    let size = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      size++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (label[n] !== -1 || data[n * 4 + 3] === 0) continue;
          label[n] = id;
          stack.push(n);
        }
      }
    }
    parts.push({ size, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
  }
  if (parts.length < 2) return;
  const main = parts.reduce((a, b) => (b.size > a.size ? b : a));
  const stray = parts.map(
    (p) =>
      p !== main &&
      (p.size < main.size * NAKAMA_MIN_PART_RATIO ||
        (p.size < main.size * NAKAMA_FAR_PART_RATIO &&
          boxGap(p.box, main.box) > NAKAMA_FAR_PART_GAP_PX)),
  );
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== -1 && stray[label[i]]) data[i * 4 + 3] = 0;
  }
}

function opaqueBounds(data: Uint8Array, w: number, h: number): Box | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Area-average `box` of the source down to tw×th. Colours are averaged with
 *  premultiplied alpha, so the removed background never tints the edges; a
 *  target pixel is drawn only when enough of its area was opaque. */
function downscale(
  data: Uint8Array,
  srcW: number,
  box: Box,
  tw: number,
  th: number,
): Array<Array<[number, number, number] | null>> {
  const rows: Array<Array<[number, number, number] | null>> = [];
  for (let ty = 0; ty < th; ty++) {
    const sy0 = box.y + Math.floor((ty * box.h) / th);
    const sy1 = Math.max(sy0 + 1, box.y + Math.floor(((ty + 1) * box.h) / th));
    const row: Array<[number, number, number] | null> = [];
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = box.x + Math.floor((tx * box.w) / tw);
      const sx1 = Math.max(sx0 + 1, box.x + Math.floor(((tx + 1) * box.w) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * srcW + sx) * 4;
          const alpha = data[p + 3];
          r += data[p] * alpha;
          g += data[p + 1] * alpha;
          b += data[p + 2] * alpha;
          a += alpha;
        }
      }
      const coverage = a / ((sy1 - sy0) * (sx1 - sx0));
      row.push(
        coverage >= NAKAMA_COVERAGE_THRESHOLD
          ? [Math.round(r / a), Math.round(g / a), Math.round(b / a)]
          : null,
      );
    }
    rows.push(row);
  }
  return rows;
}

function blankSprite(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => new Array<string>(width).fill(''));
}

/**
 * Convert the four poses of one Nakama. All views share ONE scale (so the
 * character keeps its size when it turns) and one canvas, bottom-centred
 * (feet on the floor), NAKAMA_HEIGHT_PX tall and at most NAKAMA_MAX_WIDTH_PX
 * wide. A blank image yields an empty sprite rather than an error.
 */
export function convertNakamaViews(views: NakamaViews<RgbaImage>): NakamaViews<string[][]> {
  const cleaned = NAKAMA_VIEW_KEYS.map((key) => {
    const img = views[key];
    const data = removeBackground(img);
    removeSpecks(data, img.width, img.height);
    return { key, img, data, box: opaqueBounds(data, img.width, img.height) };
  });

  const boxes = cleaned.flatMap((c) => (c.box ? [c.box] : []));
  if (boxes.length === 0) {
    const blank = blankSprite(CHAR_FRAME_W, NAKAMA_HEIGHT_PX);
    return { down: blank, up: blank, left: blank, right: blank };
  }
  const maxH = Math.max(...boxes.map((b) => b.h));
  const maxW = Math.max(...boxes.map((b) => b.w));
  const scale = Math.min(NAKAMA_HEIGHT_PX / maxH, NAKAMA_MAX_WIDTH_PX / maxW);

  const sized = cleaned.map((c) => {
    if (!c.box)
      return { key: c.key, pixels: [] as Array<Array<[number, number, number] | null>>, w: 0 };
    const tw = Math.max(1, Math.min(NAKAMA_MAX_WIDTH_PX, Math.round(c.box.w * scale)));
    const th = Math.max(1, Math.min(NAKAMA_HEIGHT_PX, Math.round(c.box.h * scale)));
    return { key: c.key, pixels: downscale(c.data, c.img.width, c.box, tw, th), w: tw };
  });

  const canvasW = Math.max(...sized.map((s) => s.w));
  const out = {} as NakamaViews<string[][]>;
  for (const s of sized) {
    const sprite = blankSprite(canvasW, NAKAMA_HEIGHT_PX);
    const left = Math.floor((canvasW - s.w) / 2);
    const top = NAKAMA_HEIGHT_PX - s.pixels.length;
    s.pixels.forEach((row, y) => {
      row.forEach((px, x) => {
        if (px) sprite[top + y][left + x] = rgbaToHex(px[0], px[1], px[2], 255);
      });
    });
    out[s.key] = sprite;
  }
  return out;
}
