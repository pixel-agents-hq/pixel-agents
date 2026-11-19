/**
 * Decode the wardrobe in the browser. Every core/src/characters/art PNG is inlined into the bundle as a data
 * URI: a canvas can read a data: image back, while one served from another origin (VS
 * Code's webview resource host) would taint it.
 */

import manifest from '../../../core/src/characters/art/wardrobe.json';
import { decodeSheet } from '../../../core/src/characters/sheet.js';
import { EYE_FOLDERS } from '../../../core/src/characters/slots.js';
import {
  decodeWardrobe,
  parseWardrobeManifest,
  type Rgba,
  type Wardrobe,
} from '../../../core/src/characters/wardrobe.js';

/** '../../../core/src/characters/art/hair/bob.png' → data URI. */
const pngs = import.meta.glob<string>('../../../core/src/characters/art/**/*.png', {
  eager: true,
  query: '?inline',
  import: 'default',
});

export async function decodePng(url: string): Promise<Rgba> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

let loading: Promise<Wardrobe> | null = null;

/** The wardrobe, decoded once. */
export function loadWardrobe(): Promise<Wardrobe> {
  loading ??= Promise.all(
    Object.entries(pngs).map(
      async ([file, url]) =>
        [
          file.replace(/^(\.\.\/)+core\/src\/characters\/art\//, '').replace(/\.png$/, ''),
          await decodePng(url),
        ] as const,
    ),
  ).then((files) => decodeWardrobe(parseWardrobeManifest(manifest), new Map(files), EYE_FOLDERS));
  return loading;
}

/** A custom item's base64 PNG as sheet pixels; null when it doesn't decode to a sheet (decodeSheet). */
export async function decodeItemPng(png: string): Promise<Uint8ClampedArray | null> {
  try {
    return decodeSheet(await decodePng(`data:image/png;base64,${png}`));
  } catch {
    return null;
  }
}
