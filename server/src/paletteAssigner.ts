/**
 * Server-side look assignment.
 *
 * Gives agents their look (palette + repeat, core chooseLook) when they're
 * created, so every connected client draws the same character.
 */

import { chooseLook } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getCharacterProfiles } from './characterProfilesStore.js';
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

/**
 * Give an agent its look (core chooseLook: a random character no one wears;
 * a character already in the office as its next repeat). A no-op for an agent
 * that already has one (restored, or a teammate that copied its lead's).
 */
export function assignPaletteIfNeeded(agent: AgentState, store: AgentStateStore): void {
  if (agent.palette !== undefined) return;
  const look = chooseLook({
    paletteCount: getPaletteCount(),
    worn: [...store.values()].filter((existing) => existing.id !== agent.id),
  });
  agent.palette = look.palette;
  agent.repeat = look.repeat;
}
