import * as fs from 'fs';
import { PNG } from 'pngjs';

import {
  convertNakamaViews,
  NAKAMA_VIEW_KEYS,
  type NakamaViews,
  type RgbaImage,
} from '../../../core/src/assets/nakamaConverter.js';
import type { NakamaEntry } from './nakamaIndex.js';

export type NakamaSpriteSet = NakamaViews<string[][]>;

/**
 * Office-sized sprites for the Nakamas of one index, converted the first time
 * each is used. One instance per index: an asset reload builds a new index and
 * a new cache, so edited art is never served stale.
 */
export class NakamaSprites {
  private readonly entries: Map<string, NakamaEntry>;
  /** null = conversion failed; kept so a broken file is not re-read every time. */
  private readonly cache = new Map<string, NakamaSpriteSet | null>();

  constructor(index: readonly NakamaEntry[]) {
    this.entries = new Map(index.map((e) => [e.id, e]));
  }

  get(id: string): NakamaSpriteSet | null {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(id);
    if (!entry) return null;
    const sprites = convert(entry);
    this.cache.set(id, sprites);
    return sprites;
  }
}

function convert(entry: NakamaEntry): NakamaSpriteSet | null {
  try {
    const images = {} as NakamaViews<RgbaImage>;
    for (const key of NAKAMA_VIEW_KEYS) {
      const png = PNG.sync.read(fs.readFileSync(entry.views[key]));
      images[key] = { width: png.width, height: png.height, data: png.data };
    }
    return convertNakamaViews(images);
  } catch (err) {
    console.warn(
      `[Nakamas] Could not convert ${entry.id}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
