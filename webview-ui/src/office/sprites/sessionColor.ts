/**
 * Session color tint: dresses a character in the color the user picked for its
 * Claude Code session (`/color red` etc.).
 *
 * Only the top (shirt/jacket) is recolored. Skin, hair and outlines stay as drawn:
 * every color that occurs in the head rows of any frame of the sheet is treated
 * as "not clothing", which keeps long hair reaching the shoulders, eye whites and
 * the black outline untouched. Skin shades that only occur on hands and neck are
 * caught by their hue (isSkinTone).
 */
import type { SpriteData } from '../types.js';

interface Hsl {
  h: number;
  s: number;
  l: number;
}

// Named colors accepted by Claude Code's `/color` command. Lightness is the
// middle of the band the shirt's own shading is mapped onto.
const SESSION_COLORS: Record<string, Hsl> = {
  red: { h: 0, s: 0.72, l: 0.48 },
  orange: { h: 26, s: 0.88, l: 0.52 },
  yellow: { h: 48, s: 0.9, l: 0.55 },
  green: { h: 128, s: 0.55, l: 0.42 },
  cyan: { h: 186, s: 0.7, l: 0.46 },
  blue: { h: 214, s: 0.72, l: 0.48 },
  purple: { h: 274, s: 0.55, l: 0.5 },
  pink: { h: 326, s: 0.72, l: 0.62 },
};

/** Rows 0..HEAD_LAST_ROW are head/hair, TOP_FIRST_ROW..TOP_LAST_ROW the shirt (16x32 frames). */
const HEAD_LAST_ROW = 14;
/** Low-sitting faces reach into the shirt rows: up to here in front, further in side view */
const FRONT_HEAD_LAST_ROW = 16;
const SIDE_HEAD_LAST_ROW = 18;
const TOP_FIRST_ROW = 15;
const TOP_LAST_ROW = 23;
const SHADE_BELOW = 0.22;
const SHADE_ABOVE = 0.16;

export function resolveSessionColor(name: string | undefined): Hsl | null {
  if (!name) return null;
  return SESSION_COLORS[name.toLowerCase()] ?? null;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Light, moderately saturated orange hues: skin of hands and neck */
function isSkinTone(hex: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || max === min) return false;
  const s = (max - min) / max;
  let h: number;
  if (max === r) h = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) h = 60 * ((b - r) / (max - min)) + 120;
  else h = 60 * ((r - g) / (max - min)) + 240;
  return h >= 12 && h <= 40 && s >= 0.2 && s <= 0.55 && max >= 0.55;
}

function lightness(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return (Math.max(...rgb) + Math.min(...rgb)) / 2;
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(Math.min(1, Math.max(0, v + m)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Frames of one view direction: index 0..2 are walking (standing upright), the rest sitting */
const STANDING_FRAMES = 3;

/**
 * Build a color → color replacement map for one character sheet. Front/back and
 * side frames are passed separately (the side head sits lower), each in sheet
 * order so the standing frames come first.
 */
export function buildClothesColorMap(
  frames: SpriteData[],
  sideFrames: SpriteData[],
  target: Hsl,
): Map<string, string> {
  const collect = (list: SpriteData[], firstRow: number, lastRow: number) => {
    const colors = new Set<string>();
    for (const frame of list) {
      for (let y = firstRow; y <= lastRow && y < frame.length; y++) {
        for (const px of frame[y]) if (px) colors.add(px.toLowerCase());
      }
    }
    return colors;
  };
  // Head and shirt are told apart on the standing frames only: sitting (typing,
  // reading) moves the head down, its eyes would otherwise count as shirt
  const standing = (list: SpriteData[]) =>
    list.filter((_, i) => i % 7 < STANDING_FRAMES || list.length < 7);
  const standFront = standing(frames);
  const standSide = standing(sideFrames);
  const headColors = collect([...frames, ...sideFrames], 0, HEAD_LAST_ROW);
  const shirtCore = collect(standFront, FRONT_HEAD_LAST_ROW + 1, TOP_LAST_ROW);

  // Faces that sit low (long hair, side view) reach into the shirt rows. Their
  // colors (eye, cheek, chin) count as head only if the lower shirt doesn't use
  // them, otherwise the shoulders would lose the shirt's own colors.
  const faceEdge = [
    ...collect(standFront, TOP_FIRST_ROW, FRONT_HEAD_LAST_ROW),
    ...collect(standSide, TOP_FIRST_ROW, SIDE_HEAD_LAST_ROW),
  ];
  for (const c of faceEdge) {
    if (!shirtCore.has(c)) headColors.add(c);
  }

  const clothes = new Set<string>();
  const top = [
    ...collect(standFront, TOP_FIRST_ROW, TOP_LAST_ROW),
    ...collect(standSide, TOP_FIRST_ROW, TOP_LAST_ROW),
  ];
  for (const c of top) {
    if (!headColors.has(c) && !isSkinTone(c)) clothes.add(c);
  }

  // Keep the shirt's own shading (folds, collar, shadow) by mapping its lightness
  // range onto a band around the target lightness. A black or white shirt thus
  // becomes a dark or light variant of the session color instead of staying grey.
  let min = 1;
  let max = 0;
  for (const c of clothes) {
    const l = lightness(c);
    min = Math.min(min, l);
    max = Math.max(max, l);
  }
  const span = max - min;
  const result = new Map<string, string>();
  for (const c of clothes) {
    const t = span > 0.001 ? (lightness(c) - min) / span : 0.5;
    const l = target.l - SHADE_BELOW + t * (SHADE_BELOW + SHADE_ABOVE);
    // Semi-transparent pixels are #RRGGBBAA: keep their alpha
    const alpha = c.length === 9 ? c.slice(7) : '';
    result.set(c, hslToHex(target.h, target.s, Math.min(0.92, Math.max(0.08, l))) + alpha);
  }
  return result;
}

/** Sitting frames carry the body lower; the shirt may reach this many rows further */
const SITTING_EXTRA_ROWS = 2;

/** Apply a replacement map to the top rows of one frame (pixels below the shirt stay). */
export function recolorClothes(sprite: SpriteData, map: Map<string, string>): SpriteData {
  return sprite.map((row, y) =>
    y < TOP_FIRST_ROW || y > TOP_LAST_ROW + SITTING_EXTRA_ROWS
      ? row
      : row.map((px) => (px ? (map.get(px.toLowerCase()) ?? px) : px)),
  );
}
