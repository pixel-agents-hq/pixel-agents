/**
 * Pure state rules behind task titles and background agents (DOM-free, so they
 * run on the Node runner). useExtensionMessages wires them to the messages.
 *
 * Titles: agentCreated.title, existingAgents.titles and agentTitle each set an
 * agent's task title; agentClosed drops it.
 *
 * Background agents (headless sessions the server flags via
 * agentCreated.background, existingAgents.backgroundAgents or agentKind) get
 * no office character — they show as tiles in the Remote Workers panel. An
 * agent can switch either way while it runs, so the office keeps, per
 * background agent, what it needs to make the character again.
 */

/** Task title per agent id. */
export type AgentTitles = Record<number, string>;

/** What turning a background agent back into a character needs: the same
 *  look and seat preference it had, its Directory, and whether it is headless. */
export interface BackgroundAgentInfo {
  palette?: number;
  hueShift?: number;
  seatId?: string;
  directoryName?: string;
  isHeadless?: boolean;
}

/** Background agents by id. Membership is what "background" means. */
export type BackgroundAgents = Record<number, BackgroundAgentInfo>;

/** Drop one key, keeping identity when it is absent (React skips the render). */
export function withoutKey<T>(record: Record<number, T>, id: number): Record<number, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

/** Set (or, for a blank or missing title, clear) one agent's title. Keeps
 *  identity when nothing changes. */
export function withTitle(titles: AgentTitles, id: number, title: unknown): AgentTitles {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (!clean) return withoutKey(titles, id);
  if (titles[id] === clean) return titles;
  return { ...titles, [id]: clean };
}

/** Merge a snapshot's titles (existingAgents.titles: JSON keys are strings).
 *  Agents the snapshot has no title for keep the one they have. */
export function withTitles(titles: AgentTitles, snapshot: unknown): AgentTitles {
  if (!snapshot || typeof snapshot !== 'object') return titles;
  let next = titles;
  for (const [key, title] of Object.entries(snapshot as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isFinite(id) || typeof title !== 'string' || !title.trim()) continue;
    next = withTitle(next, id, title);
  }
  return next;
}

/** The ids a snapshot flags background (existingAgents.backgroundAgents). */
export function backgroundIds(flags: unknown): Set<number> {
  const ids = new Set<number>();
  if (!flags || typeof flags !== 'object') return ids;
  for (const [key, on] of Object.entries(flags as Record<string, unknown>)) {
    const id = Number(key);
    if (on === true && Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

/** What a kind report asks of the office for one agent. */
export type KindTransition = 'toWorker' | 'toCharacter' | 'none';

/**
 * 'toWorker': the agent turned background — its character (if any) goes,
 * a tile comes. 'toCharacter': it turned interactive — the tile goes, a
 * character comes. 'none': nothing changed (a repeat report).
 */
export function kindTransition(isBackground: boolean, wantBackground: boolean): KindTransition {
  if (wantBackground === isBackground) return 'none';
  return wantBackground ? 'toWorker' : 'toCharacter';
}

/** The parts of a character (or a restore entry) a background agent keeps. */
export interface CharacterLike {
  palette?: number;
  hueShift?: number;
  seatId?: string | null;
  directoryName?: string;
  isHeadless?: boolean;
}

/** Snapshot what a character needs to come back as itself. */
export function backgroundInfoOf(ch: CharacterLike | undefined): BackgroundAgentInfo {
  if (!ch) return {};
  const info: BackgroundAgentInfo = {};
  if (ch.palette !== undefined) info.palette = ch.palette;
  if (ch.hueShift !== undefined) info.hueShift = ch.hueShift;
  if (ch.seatId) info.seatId = ch.seatId;
  if (ch.directoryName) info.directoryName = ch.directoryName;
  if (ch.isHeadless) info.isHeadless = true;
  return info;
}

/** The agents that get an office character (and a card): every agent but
 *  the background ones, in the same order. */
export function officeAgentIds(agents: readonly number[], background: BackgroundAgents): number[] {
  return agents.filter((id) => !(id in background));
}
