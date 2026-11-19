/**
 * The server's side of the character model: the wardrobe art decoded with pngjs, and a
 * profile drawn without an office open — its full sheet (core's CharacterRenderer, the
 * office's own) or a preview PNG (core's previewPixels: standing frames down, up, right).
 *
 * The art is core/src/characters/art. The build copies its PNGs and wardrobe.json next to
 * the bundles (dist/assets/wardrobe, shipped in the npm package and the .vsix through
 * package.json's dist/assets/); run from source, the module finds core's folder itself.
 * Decoded once, on first use.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { previewPixels } from '../../core/src/characters/preview.js';
import { CharacterRenderer } from '../../core/src/characters/renderer.js';
import { decodeSheet } from '../../core/src/characters/sheet.js';
import { EYE_FOLDERS } from '../../core/src/characters/slots.js';
import {
  decodeWardrobe,
  type ItemArt,
  parseWardrobeManifest,
  type Rgba,
  type Wardrobe,
  withItems,
} from '../../core/src/characters/wardrobe.js';
import type { WardrobeItem } from '../../core/src/wardrobeItems.js';
import { CHARACTER_PREVIEW_SCALE, WARDROBE_ART_DIST_DIR } from './constants.js';

const MANIFEST = 'wardrobe.json';

/** core's art folder, from a repo checkout's root. */
const SOURCE_ART = ['core', 'src', 'characters', 'art'];

/**
 * The folder holding the wardrobe art: beside the bundle (dist/, where __dirname is for
 * dist/cli.js and dist/extension.js alike), else core's source folder — from server/src
 * (tests, runs from source) or from dist/ in a checkout whose build didn't copy the art
 * (watch mode). Null when none has it.
 */
export function findWardrobeDir(): string | null {
  const candidates = [
    path.join(__dirname, WARDROBE_ART_DIST_DIR),
    path.resolve(__dirname, '..', '..', ...SOURCE_ART),
    path.resolve(__dirname, '..', ...SOURCE_ART),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, MANIFEST))) ?? null;
}

const decodePng = (bytes: Buffer): Rgba => {
  const img = PNG.sync.read(bytes);
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
};

/** The wardrobe from an art folder (wardrobe.json + <piece>/<part>.png); throws as decodeWardrobe does. */
export function loadWardrobeFrom(dir: string): Wardrobe {
  const manifest = parseWardrobeManifest(
    JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf-8')),
  );
  const files = new Map<string, Rgba>();
  for (const file of fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
    if (!file.endsWith('.png')) continue;
    const key = file
      .split(path.sep)
      .join('/')
      .replace(/\.png$/, '');
    files.set(key, decodePng(fs.readFileSync(path.join(dir, file))));
  }
  return decodeWardrobe(manifest, files, EYE_FOLDERS);
}

let wardrobe: Wardrobe | null = null;

/** The wardrobe, decoded once; throws when the art can't be found or doesn't decode. */
function serverWardrobe(): Wardrobe {
  if (!wardrobe) {
    const dir = findWardrobeDir();
    if (!dir) throw new Error('[Pixel Agents] wardrobe art not found');
    wardrobe = loadWardrobeFrom(dir);
  }
  return wardrobe;
}

/** A custom item's art, or null when its PNG isn't a sheet (it is left out, as the office leaves it). */
function itemArt(item: WardrobeItem): ItemArt | null {
  let data: Uint8ClampedArray | null;
  try {
    data = decodeSheet(decodePng(Buffer.from(item.png, 'base64')));
  } catch {
    data = null;
  }
  return data && { id: item.id, piece: item.piece, label: item.label, base: item.base, data };
}

/** The renderer for the newest item set asked for (an item never changes once made, so ids key it). */
let current: { key: string; renderer: CharacterRenderer } | null = null;

/** The character renderer over the wardrobe plus these custom items (the saved ones, usually). */
export function characterRenderer(items: readonly WardrobeItem[] = []): CharacterRenderer {
  const key = items.map((i) => i.id).join(',');
  if (current?.key !== key) {
    const art = items.flatMap((i) => itemArt(i) ?? []);
    current = { key, renderer: new CharacterRenderer(withItems(serverWardrobe(), art)) };
  }
  return current.renderer;
}

/** A profile's 128x96 RGBA sheet, as the office draws it. */
export function renderCharacterSheet(
  profile: CharacterProfile,
  items: readonly WardrobeItem[] = [],
): Uint8ClampedArray {
  return characterRenderer(items).sheet(profile);
}

/**
 * A profile's preview as a PNG: its standing frames facing down, up and right, side by
 * side on a transparent background, each pixel `scale` x `scale` (whole number).
 */
export function characterPreviewPng(
  profile: CharacterProfile,
  opts: { items?: readonly WardrobeItem[]; scale?: number } = {},
): Buffer {
  const { width, height, data } = previewPixels(
    renderCharacterSheet(profile, opts.items),
    opts.scale ?? CHARACTER_PREVIEW_SCALE,
  );
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return PNG.sync.write(png);
}
