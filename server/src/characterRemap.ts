import type { AgentLook } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { readConfig, withDirectoryCharacters, writeConfig } from './configPersistence.js';
import { remapConversationLooks } from './conversations.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import type { AgentState } from './types.js';

/**
 * Keeping everything that names a character by its index (a palette) on the same character
 * when a save inserts, deletes or moves characters: `remap` (core characterRemap) takes an
 * old index to the new one, undefined for a deleted character.
 *
 * Two halves, because two processes (the VS Code extension and the standalone server) can
 * share ~/.pixel-agents: each renumbers its OWN agents when it sees the list change (its
 * save, or the file watcher), but only the process that saved renumbers the machine-wide
 * files, or a second process would renumber them twice.
 */
export type PaletteRemap = (palette: number) => number | undefined;

/**
 * Renumber this process's agents (and their persisted looks). An agent whose character was
 * deleted gets a new look the way a launch would (a teammate or spawn child copies its
 * lead's). Returns every agent whose look changed, for the office.
 */
export function remapAgentLooks(store: AgentStateStore, remap: PaletteRemap): AgentLook[] {
  const changed: AgentState[] = [];
  const lost: AgentState[] = [];
  for (const agent of store.values()) {
    if (agent.palette === undefined) continue;
    const next = remap(agent.palette);
    if (next === agent.palette) continue;
    if (next === undefined) {
      agent.palette = undefined;
      agent.repeat = undefined;
      lost.push(agent);
    } else {
      agent.palette = next;
      changed.push(agent);
    }
  }
  // leads first, so a follower can copy its lead's new look
  lost.sort((a, b) => Number(a.leadAgentId !== undefined) - Number(b.leadAgentId !== undefined));
  for (const agent of lost) {
    const lead = agent.leadAgentId !== undefined ? store.get(agent.leadAgentId) : undefined;
    if (lead?.palette !== undefined) {
      agent.palette = lead.palette;
      agent.repeat = lead.repeat;
    } else {
      assignPaletteIfNeeded(agent, store);
    }
    changed.push(agent);
  }
  if (changed.length === 0) return [];
  store.persist();
  const adapter = store.getAdapter();
  if (adapter) {
    const seats = adapter.loadSeats();
    for (const [id, seat] of Object.entries(seats)) {
      const agent = store.get(Number(id));
      if (agent?.palette !== undefined) {
        seat.palette = agent.palette;
        seat.repeat = agent.repeat;
      } else if (seat.palette !== undefined) {
        seat.palette = remap(seat.palette);
      }
    }
    adapter.saveSeats(seats);
  }
  return changed.map((a) => ({ id: a.id, palette: a.palette!, repeat: a.repeat ?? 0 }));
}

/** An index list renumbered, deleted characters left out (and no index twice). */
function remapList(list: readonly number[], remap: PaletteRemap): number[] {
  const out: number[] = [];
  for (const i of list) {
    const next = remap(i);
    if (next !== undefined && !out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * Renumber the machine-wide references: the Directories' default characters and the
 * roster's recency (config.json), and the looks remembered for past conversations.
 * Returns whether config.json changed (its Directories and recency need re-sending).
 */
export function remapSharedCharacterRefs(remap: PaletteRemap): boolean {
  remapConversationLooks(remap);
  const cfg = readConfig();
  // readConfig hands back canonical entries, so an entry changes exactly when
  // its list does (withDirectoryCharacters then drops an emptied list's order).
  let changed = false;
  cfg.directories = cfg.directories.map((d) => {
    if (!d.characters) return d;
    const characters = remapList(d.characters, remap);
    if (sameList(characters, d.characters)) return d;
    changed = true;
    return withDirectoryCharacters(d, { ...d, characters });
  });
  const recent = remapList(cfg.recentCharacters, remap);
  if (!sameList(recent, cfg.recentCharacters)) changed = true;
  cfg.recentCharacters = recent;
  if (!changed) return false;
  writeConfig(cfg);
  return true;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
