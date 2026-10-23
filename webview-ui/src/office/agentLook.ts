/**
 * The agents' look: the classic chibi (the default) or Clawd (Claude Code's
 * orange mascot, opt-in). Pure and DOM-free (storage is injected), so it unit-tests in
 * the Node runner; the sprites themselves are in sprites/clawdSprites.ts.
 *
 * - NPCs (the greeter, Ansh, the Manager, the receptionist) keep the classic
 *   art whatever the setting: people and Claude sessions must tell apart.
 * - A Clawd's identity — its tint and its accessory — comes from a stable
 *   hash of the agent's repo (directoryName), so one repo keeps one colour
 *   across sessions and restarts, the way desks already bias by repo. With no
 *   repo it falls back to the palette index the office assigned.
 * - Sub-agents wear the parent's tint and no accessory: a plainer Clawd that
 *   reads as the parent's crew. Team leads wear their crown (funRender)
 *   instead of an accessory.
 * - The setting is a view preference, per browser (localStorage): a read-only
 *   wall display can flip it without a server round-trip.
 */

import {
  AGENT_LOOK_DEFAULT,
  AGENT_LOOK_STORAGE_KEY,
  ANSH_NPC_ID,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_HIT_HEIGHT,
  CIGARETTE_HAND_RISE_PX,
  CIGARETTE_REACH_FRONT_PX,
  CIGARETTE_REACH_SIDE_PX,
  CLAWD_BLINK_CLOSED_SEC,
  CLAWD_BLINK_PERIOD_SEC,
  CLAWD_BUBBLE_RISE_PX,
  CLAWD_BUBBLE_SITTING_OFFSET_PX,
  CLAWD_CONFETTI_RISE_PX,
  CLAWD_HAND_RISE_PX,
  CLAWD_HEAD_RISE_PX,
  CLAWD_HIT_HEIGHT_PX,
  CLAWD_LABEL_RISE_PX,
  CLAWD_LEAD_LABEL_LIFT_PX,
  CLAWD_MOUTH_BACK_EXTRA_RISE_PX,
  CLAWD_MOUTH_RISE_PX,
  CLAWD_MOUTH_SIDE_PX,
  CLAWD_MUGSHOT_CROP_TOP_ROW,
  CLAWD_REACH_FRONT_PX,
  CLAWD_REACH_SIDE_PX,
  CLAWD_TINTS,
  CONFETTI_ORIGIN_DY,
  GREETER_ID,
  MANAGER_NPC_ID,
  MUGSHOT_CROP_TOP_ROW,
  SMOKE_MOUTH_BACK_EXTRA_RISE_PX,
  SMOKE_MOUTH_RISE_PX,
  SMOKE_MOUTH_SIDE_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../constants.js';
import type { Character } from './types.js';

export type AgentLook = 'clawd' | 'classic';

export function isAgentLook(value: unknown): value is AgentLook {
  return value === 'clawd' || value === 'classic';
}

/** The accessories, one per repo (the art is in sprites/clawdSprites.ts). */
export const CLAWD_ACCESSORIES = ['cap', 'headset', 'beanie', 'bow', 'glasses', 'antenna'] as const;
export type ClawdAccessory = (typeof CLAWD_ACCESSORIES)[number];

// ── The setting ────────────────────────────────────────────────

type LookStorage = Pick<Storage, 'getItem' | 'setItem'>;

let currentLook: AgentLook = AGENT_LOOK_DEFAULT;
/** Bumped on every change that alters how an agent is drawn (the look, or a
 *  tint/accessory handed out), so the mug shots redraw. */
let lookVersion = 0;
const listeners = new Set<() => void>();

function notify(): void {
  lookVersion++;
  for (const listener of listeners) listener();
}

/** The look agents are drawn with right now. */
export function getAgentLook(): AgentLook {
  return currentLook;
}

/** Changes whenever an agent's drawing may have changed (useSyncExternalStore snapshot). */
export function getAgentLookVersion(): number {
  return lookVersion;
}

/** Change the look (the renderer reads it every frame) and tell the listeners. */
export function setAgentLook(
  look: AgentLook,
  storage: LookStorage | null = defaultStorage(),
): void {
  if (look === currentLook) return;
  currentLook = look;
  saveAgentLook(look, storage);
  notify();
}

/** Subscribe to look changes (useSyncExternalStore-shaped). */
export function subscribeAgentLook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The persisted look, or the default when nothing valid is stored. */
export function loadAgentLook(storage: LookStorage | null): AgentLook {
  try {
    const raw = storage?.getItem(AGENT_LOOK_STORAGE_KEY);
    return isAgentLook(raw) ? raw : AGENT_LOOK_DEFAULT;
  } catch {
    return AGENT_LOOK_DEFAULT;
  }
}

/** Persist the look; a storage that refuses (private mode, quota) is ignored. */
export function saveAgentLook(look: AgentLook, storage: LookStorage | null): void {
  try {
    storage?.setItem(AGENT_LOOK_STORAGE_KEY, look);
  } catch {
    // A view preference: losing it is harmless.
  }
}

/** Read the persisted look into the module (called once at startup). */
export function initAgentLook(storage: LookStorage | null = defaultStorage()): AgentLook {
  currentLook = loadAgentLook(storage);
  return currentLook;
}

function defaultStorage(): LookStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ── Who is drawn how ───────────────────────────────────────────

/** What the look of a character depends on; AgentAppearance (the mug shot) is one too. */
export type LookSubject = Pick<
  Character,
  'id' | 'palette' | 'hueShift' | 'directoryName' | 'isSubagent' | 'isTeamLead'
> &
  Partial<Pick<Character, 'isGreeter' | 'isReceptionist'>>;

/** An NPC: the greeter, Ansh, the Manager or the receptionist — never a Clawd. */
export function isNpcCharacter(ch: LookSubject): boolean {
  return (
    ch.isGreeter === true ||
    ch.isReceptionist === true ||
    ch.id === GREETER_ID ||
    ch.id === ANSH_NPC_ID ||
    ch.id === MANAGER_NPC_ID
  );
}

/** The look this character is drawn with under the current setting. */
export function lookOf(ch: LookSubject): AgentLook {
  return isNpcCharacter(ch) ? 'classic' : currentLook;
}

/** FNV-1a, 32-bit: a small stable hash for repo names. */
export function stableHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface ClawdIdentity {
  /** Index into CLAWD_TINTS. */
  tint: number;
  /** Index into CLAWD_ACCESSORIES, or null for a plain Clawd. */
  accessory: ClawdAccessory | null;
}

/** What a Clawd's identity is keyed by: its repo, else the office palette. */
export function identityKey(ch: Pick<LookSubject, 'directoryName' | 'palette'>): string {
  return ch.directoryName ? `repo:${ch.directoryName}` : `palette:${Math.abs(ch.palette)}`;
}

/** The slot (of `count`) a key would like: a stable hash of its repo, or its
 *  palette index (distinct for the first agents, like the chibi skins). */
export function preferredSlot(key: string, count: number, salt: string): number {
  if (key.startsWith('palette:')) return Number(key.slice('palette:'.length)) % count;
  return stableHash(`${key}${salt}`) % count;
}

/**
 * Hand out slots (tints, or accessories) so the keys on the board differ
 * while there are enough to go round. Sticky: a key keeps the slot it was
 * given while nobody present needs it back, so a repo's Clawd doesn't change
 * colour as others come and go. A new key takes its preferred slot when free,
 * else the next free one; with every slot taken, its preferred one. Mutates
 * `sticky`; returns whether anything changed.
 */
export function assignSlots(
  present: readonly string[],
  sticky: Map<string, number>,
  count: number,
  salt: string,
): boolean {
  let changed = false;
  const used = new Set<number>();
  const fresh: string[] = [];
  // Keys that already hold a slot keep it (the first holder wins a clash).
  for (const key of present) {
    const slot = sticky.get(key);
    if (slot !== undefined && !used.has(slot)) used.add(slot);
    else if (!fresh.includes(key)) fresh.push(key);
  }
  for (const key of fresh) {
    const want = preferredSlot(key, count, salt);
    let slot = want;
    for (let i = 0; i < count && used.has(slot); i++) slot = (want + i + 1) % count;
    if (used.has(slot)) slot = want; // all taken: share the preferred one
    used.add(slot);
    if (sticky.get(key) !== slot) {
      sticky.set(key, slot);
      changed = true;
    }
  }
  return changed;
}

const tintSlots = new Map<string, number>();
const accessorySlots = new Map<string, number>();
const TINT_SALT = '';
const ACCESSORY_SALT = '#accessory';

/**
 * Note who is on the board (the renderer calls this every frame): the Clawds
 * present get distinct tints and accessories. Only top-level agents count;
 * helpers wear their parent's tint, NPCs are never Clawds. Cheap when nothing
 * new arrived.
 */
export function noteLookSubjects(chars: Iterable<LookSubject>): void {
  const keys: string[] = [];
  for (const ch of chars) {
    if (ch.isSubagent || isNpcCharacter(ch)) continue;
    const key = identityKey(ch);
    if (!keys.includes(key)) keys.push(key);
  }
  const a = assignSlots(keys, tintSlots, CLAWD_TINTS.length, TINT_SALT);
  const b = assignSlots(keys, accessorySlots, CLAWD_ACCESSORIES.length, ACCESSORY_SALT);
  if (a || b) notify();
}

/** Forget every handed-out slot (tests). */
export function resetLookSlots(): void {
  tintSlots.clear();
  accessorySlots.clear();
}

/**
 * A Clawd's tint and accessory: the slots handed out for its repo (or, with
 * no repo, its office palette) — distinct among the agents present, stable per
 * repo. Before the board has seen it, the preferred slots. A sub-agent takes
 * its parent's tint and no accessory; a team lead wears the crown instead.
 */
export function clawdIdentity(ch: LookSubject, parent?: LookSubject): ClawdIdentity {
  if (ch.isSubagent) {
    const base = parent ? clawdIdentity(parent) : identityOf(ch);
    return { tint: base.tint, accessory: null };
  }
  const own = identityOf(ch);
  return ch.isTeamLead ? { tint: own.tint, accessory: null } : own;
}

function identityOf(ch: LookSubject): ClawdIdentity {
  const key = identityKey(ch);
  const tint = tintSlots.get(key) ?? preferredSlot(key, CLAWD_TINTS.length, TINT_SALT);
  const accessory =
    accessorySlots.get(key) ?? preferredSlot(key, CLAWD_ACCESSORIES.length, ACCESSORY_SALT);
  return { tint, accessory: CLAWD_ACCESSORIES[accessory] };
}

// ── Blinking ───────────────────────────────────────────────────

/** Eyes shut right now? Once per period, for a moment, offset per agent. */
export function blinkClosed(nowSec: number, seed: number): boolean {
  const offset = (stableHash(`blink:${seed}`) % 1000) / 1000;
  const phase = (nowSec / CLAWD_BLINK_PERIOD_SEC + offset) % 1;
  return phase >= 0 && phase < CLAWD_BLINK_CLOSED_SEC / CLAWD_BLINK_PERIOD_SEC;
}

// ── Geometry per look ──────────────────────────────────────────

/** Where things hang off a character, in sprite px from its feet anchor. */
export interface LookMetrics {
  /** The top of the head, standing. */
  headRise: number;
  /** The hand that holds a cigarette or a cup, and how far it reaches. */
  handRise: number;
  reachFront: number;
  reachSide: number;
  /** The mouth (the exhale), and how far it is from the body sideways; facing
   *  away the exhale shows this much higher, over the head. */
  mouthRise: number;
  mouthSide: number;
  mouthBackExtra: number;
  /** The label's anchor and the bubble's bottom above the feet. */
  labelRise: number;
  bubbleRise: number;
  /** The bubble drops this far when seated. */
  bubbleSitDrop: number;
  /** A team lead's label and bubble rise this much more, clear of its crown. */
  leadLift: number;
  /** The click box's height above the (seated) anchor. */
  hitHeight: number;
  /** The mug shot's crop starts on this frame row. */
  mugshotCropTop: number;
  /** Confetti launches this far above the feet. */
  confettiRise: number;
}

const CLASSIC_METRICS: LookMetrics = {
  headRise: 28,
  handRise: CIGARETTE_HAND_RISE_PX,
  reachFront: CIGARETTE_REACH_FRONT_PX,
  reachSide: CIGARETTE_REACH_SIDE_PX,
  mouthRise: SMOKE_MOUTH_RISE_PX,
  mouthSide: SMOKE_MOUTH_SIDE_PX,
  mouthBackExtra: SMOKE_MOUTH_BACK_EXTRA_RISE_PX,
  labelRise: TOOL_OVERLAY_VERTICAL_OFFSET,
  bubbleRise: BUBBLE_VERTICAL_OFFSET_PX,
  bubbleSitDrop: BUBBLE_SITTING_OFFSET_PX,
  leadLift: 0,
  hitHeight: CHARACTER_HIT_HEIGHT,
  mugshotCropTop: MUGSHOT_CROP_TOP_ROW,
  confettiRise: -CONFETTI_ORIGIN_DY,
};

const CLAWD_METRICS: LookMetrics = {
  headRise: CLAWD_HEAD_RISE_PX,
  handRise: CLAWD_HAND_RISE_PX,
  reachFront: CLAWD_REACH_FRONT_PX,
  reachSide: CLAWD_REACH_SIDE_PX,
  mouthRise: CLAWD_MOUTH_RISE_PX,
  mouthSide: CLAWD_MOUTH_SIDE_PX,
  mouthBackExtra: CLAWD_MOUTH_BACK_EXTRA_RISE_PX,
  labelRise: CLAWD_LABEL_RISE_PX,
  bubbleRise: CLAWD_BUBBLE_RISE_PX,
  bubbleSitDrop: CLAWD_BUBBLE_SITTING_OFFSET_PX,
  leadLift: CLAWD_LEAD_LABEL_LIFT_PX,
  hitHeight: CLAWD_HIT_HEIGHT_PX,
  mugshotCropTop: CLAWD_MUGSHOT_CROP_TOP_ROW,
  confettiRise: CLAWD_CONFETTI_RISE_PX,
};

export function lookMetrics(look: AgentLook): LookMetrics {
  return look === 'clawd' ? CLAWD_METRICS : CLASSIC_METRICS;
}

/** The metrics of the look a character is drawn with. */
export function metricsOf(ch: LookSubject): LookMetrics {
  return lookMetrics(lookOf(ch));
}
