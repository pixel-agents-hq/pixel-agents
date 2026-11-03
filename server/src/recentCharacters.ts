import { MAX_CHARACTER_PROFILES } from '../../core/src/characterProfiles.js';
import { rosterPick } from '../../core/src/paletteUtils.js';
import { readConfig, writeConfig } from './configPersistence.js';
import { getPaletteCount } from './paletteAssigner.js';

/**
 * The launch roster's order: the characters launched most recently first. The
 * server keeps it (machine-wide, in config.json) so every office — desktop and
 * phone, either surface — lists the roster the same way. A launch that wears a
 * roster pick records it; both surfaces call recordCharacterUse for that.
 */

/** `recent` with `index` moved to the front. */
export function markUsed(recent: readonly number[], index: number): number[] {
  return [index, ...recent.filter((i) => i !== index)];
}

/** The message that tells a client the order. */
export function recentCharactersMessage() {
  return { type: 'recentCharactersLoaded', recent: readConfig().recentCharacters } as const;
}

/** Record a launch wearing `palette`. Returns the message to broadcast, or
 *  null when the launch wore no valid pick (nothing changed). */
export function recordCharacterUse(
  palette: unknown,
): ReturnType<typeof recentCharactersMessage> | null {
  const picked = rosterPick(palette, getPaletteCount());
  if (picked === undefined) return null;
  const cfg = readConfig();
  cfg.recentCharacters = markUsed(cfg.recentCharacters, picked).slice(0, MAX_CHARACTER_PROFILES);
  writeConfig(cfg);
  return recentCharactersMessage();
}
