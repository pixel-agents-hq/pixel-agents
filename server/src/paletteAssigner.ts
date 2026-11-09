/**
 * Server-side look assignment.
 *
 * Gives agents their look (palette + repeat, core chooseLook) when they're
 * created, so every connected client draws the same character.
 */

import type { Directory } from '../../core/src/messages.js';
import { chooseLook } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getCharacterProfiles } from './characterProfilesStore.js';
import { readConfig } from './configPersistence.js';
import type { AgentState } from './types.js';

/**
 * Palettes are the character profiles (characters.json, owned by
 * characterProfilesStore) followed by any char_N.png sprites from external asset
 * directories, so the count moves when either changes. The external count mirrors the
 * setHookProvider / setTeamSwitch module-level setter pattern in transcriptParser.ts.
 */
let externalCount = 0;

/** Set after external asset directories are scanned for character sprites. */
export function setExternalCharacterCount(count: number): void {
  externalCount = Math.max(0, Math.floor(count));
}

/** Palettes an agent can wear (at least one: the profile list is never empty). */
export function getPaletteCount(): number {
  return getCharacterProfiles().length + externalCount;
}

/** Every character some Directory claims as a default: left for its own
 *  launches when another agent needs a character (see pickRandomPalette). */
function directoryDefaults(): Set<number> {
  const reserved = new Set<number>();
  for (const directory of readConfig().directories) {
    for (const palette of directory.characters ?? []) reserved.add(palette);
  }
  return reserved;
}

/** What a launch asks of a new agent's look. */
export interface LaunchLook {
  /** A character picked from the roster (a palette index). */
  picked?: number;
  /** The Directory launched into: its default characters. */
  directory?: Directory;
}

/**
 * Give an agent its look (core chooseLook: the roster pick, else a Directory
 * default no one wears, else a random character no one wears; a character
 * already in the office as its next repeat). A no-op for an agent that
 * already has one (restored, or a teammate that copied its lead's).
 */
export function assignPaletteIfNeeded(
  agent: AgentState,
  store: AgentStateStore,
  launch: LaunchLook = {},
): void {
  if (agent.palette !== undefined) return;
  const look = chooseLook({
    paletteCount: getPaletteCount(),
    worn: [...store.values()].filter((existing) => existing.id !== agent.id),
    picked: launch.picked,
    directory: launch.directory,
    reserved: directoryDefaults(),
  });
  agent.palette = look.palette;
  agent.repeat = look.repeat;
}
