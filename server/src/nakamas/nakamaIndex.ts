import * as fs from 'fs';
import * as path from 'path';

import type { NakamaViewKey, NakamaViews } from '../../../core/src/assets/nakamaConverter.js';
import { isNakamaTier, type NakamaTier } from '../../../core/src/modelTier.js';
import { NAKAMAS_ASSET_SUBDIR, NAKAMAS_MODELS_FILE, NAKAMAS_POSITIONS_FILE } from '../constants.js';

/** One Nakama found on disk. Only paths: the art is decoded when it is used. */
export interface NakamaEntry {
  /** `<collection>/<character>` folder names; stable across restarts. */
  id: string;
  name: string;
  collection: string;
  /** The model tier its collection (or an override) is reserved for; null = any model. */
  tier: NakamaTier | null;
  views: NakamaViews<string>;
}

/** File suffix of each pose: F = front, B = back, L/R = the side it faces. */
const VIEW_SUFFIX: Record<string, NakamaViewKey> = { F: 'down', B: 'up', L: 'left', R: 'right' };
const VIEW_FILE = /_([FBLR])\.png$/i;

interface TierMap {
  colecciones: Record<string, unknown>;
  personajes: Record<string, unknown>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTierMap(root: string): TierMap {
  const file = path.join(root, NAKAMAS_MODELS_FILE);
  const raw = readJson(file) as Partial<TierMap> | null;
  if (raw === null && fs.existsSync(file)) {
    console.warn(`[Nakamas] ${file} is not valid JSON; no collection has a model tier.`);
  }
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  return { colecciones: obj(raw?.colecciones), personajes: obj(raw?.personajes) };
}

function toTier(value: unknown, where: string): NakamaTier | null {
  if (value === null || value === undefined) return null;
  const tier = typeof value === 'string' ? value.toLowerCase() : value;
  if (isNakamaTier(tier)) return tier;
  console.warn(`[Nakamas] Unknown model "${String(value)}" for ${where}; treated as any model.`);
  return null;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function readViews(dir: string): NakamaViews<string> | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const views: Partial<NakamaViews<string>> = {};
  for (const file of files) {
    const match = VIEW_FILE.exec(file);
    if (match) views[VIEW_SUFFIX[match[1].toUpperCase()]] = path.join(dir, file);
  }
  return views.down && views.up && views.left && views.right
    ? (views as NakamaViews<string>)
    : null;
}

function displayName(dir: string, folder: string): string {
  const meta = readJson(path.join(dir, NAKAMAS_POSITIONS_FILE)) as { personaje?: unknown } | null;
  return typeof meta?.personaje === 'string' && meta.personaje.trim()
    ? meta.personaje.trim()
    : folder.replace(/_/g, ' ');
}

/**
 * Every complete Nakama under `<dir>/assets/nakamas/` of each asset directory.
 * Folders starting with `_` (original sheets) are skipped, and so is a character
 * missing any of its four poses. The first directory wins on a duplicate id.
 */
export function loadNakamaIndex(assetDirs: readonly string[]): NakamaEntry[] {
  const byId = new Map<string, NakamaEntry>();
  for (const assetDir of assetDirs) {
    const root = path.join(assetDir, 'assets', NAKAMAS_ASSET_SUBDIR);
    const collections = listDirs(root);
    if (collections.length === 0) continue;
    const tiers = readTierMap(root);
    for (const collection of collections) {
      const collectionTier = toTier(tiers.colecciones[collection], collection);
      for (const character of listDirs(path.join(root, collection))) {
        const id = `${collection}/${character}`;
        if (byId.has(id)) continue;
        const dir = path.join(root, collection, character);
        const views = readViews(dir);
        if (!views) continue;
        const override = tiers.personajes[id];
        byId.set(id, {
          id,
          name: displayName(dir, character),
          collection,
          tier: override === undefined ? collectionTier : toTier(override, id),
          views,
        });
      }
    }
  }
  return [...byId.values()];
}
