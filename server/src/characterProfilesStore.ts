import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type CharacterProfile, parseCharacterProfiles } from '../../core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { parseWardrobeItems, type WardrobeItem } from '../../core/src/wardrobeItems.js';
import {
  CHARACTER_PROFILES_FILE_NAME,
  PIXEL_AGENTS_DIR,
  WARDROBE_ITEMS_FILE_NAME,
} from './constants.js';

/**
 * The cached cast: characters.json and wardrobe-items.json as last read or written. Only
 * the cache lives here (the palette count reads it); saving, answering the client messages
 * and watching the files is characterProfilesPersistence.ts, which also renumbers looks —
 * so this module depends on nothing that could depend back on it.
 */
export interface CachedJsonFile<T> {
  /** The file's value: read from disk once per path, then served from the cache. */
  get(): T;
  /** Cache `value` as the file's content (it was just written, or seen changed). */
  set(value: T, filePath?: string): void;
  /** The file's path under the current home directory. */
  path(): string;
  /** The file's validator. */
  parse(value: unknown): T | null;
  /** The file's name, for log lines. */
  fileName: string;
}

/**
 * One JSON file under ~/.pixel-agents/, validated by `parse` and cached. Keyed by path so a
 * different $HOME (tests) re-reads. Absent, malformed (warned) or unreadable (logged) = the
 * `fallback`.
 */
function cachedJsonFile<T>(opts: {
  fileName: string;
  label: string;
  parse: (value: unknown) => T | null;
  fallback: () => T;
}): CachedJsonFile<T> {
  let cache: { filePath: string; value: T } | null = null;
  const filePath = () => path.join(os.homedir(), PIXEL_AGENTS_DIR, opts.fileName);
  function readFromDisk(file: string): T {
    try {
      if (fs.existsSync(file)) {
        const value = opts.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
        if (value) return value;
        console.warn(`[Pixel Agents] Ignoring malformed ${opts.fileName}`);
      }
    } catch (err) {
      console.error(`[Pixel Agents] Failed to read ${opts.label}:`, err);
    }
    return opts.fallback();
  }
  return {
    get() {
      const file = filePath();
      if (cache?.filePath !== file) cache = { filePath: file, value: readFromDisk(file) };
      return cache.value;
    },
    set(value, file = filePath()) {
      cache = { filePath: file, value };
    },
    path: filePath,
    parse: opts.parse,
    fileName: opts.fileName,
  };
}

/** characters.json: the character profiles. Absent means the six defaults. */
export const characterProfilesFile = cachedJsonFile<CharacterProfile[]>({
  fileName: CHARACTER_PROFILES_FILE_NAME,
  label: 'character profiles',
  parse: parseCharacterProfiles,
  fallback: () => structuredClone([...DEFAULT_CHARACTER_PROFILES]),
});

/** wardrobe-items.json: the custom wardrobe items. Absent means none. */
export const wardrobeItemsFile = cachedJsonFile<WardrobeItem[]>({
  fileName: WARDROBE_ITEMS_FILE_NAME,
  label: 'wardrobe items',
  parse: parseWardrobeItems,
  fallback: () => [],
});

/** The saved profiles, or the defaults. Read from disk once, then served from the cache. */
export function getCharacterProfiles(): CharacterProfile[] {
  return characterProfilesFile.get();
}

/** The saved custom wardrobe items (none when absent). Read once, then served from the cache. */
export function getWardrobeItems(): WardrobeItem[] {
  return wardrobeItemsFile.get();
}
