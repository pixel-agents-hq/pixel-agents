/**
 * Loop detector: does an agent look like it is going in circles?
 *
 *  - `repeat`: the same tool with the same input LOOP_REPEAT_COUNT times within
 *    LOOP_REPEAT_WINDOW_MS (counted since the last progress).
 *  - `stall`: LOOP_STALL_ACTIVE_MS of active time with no new file edited and
 *    no phase change.
 *
 * Progress -- a file this agent hasn't edited before, or a tool that moves it to
 * another phase (explore / build / test / ship, see progress/phase.ts) -- clears
 * the flag and starts both counts afresh. Going to sleep clears it too.
 *
 * Inputs are reduced to a short hash (repeatKey) and never kept.
 */

import { createHash } from 'crypto';

import type { AgentLoop, LoopReason, WorkPhase } from '../../../core/src/messages.js';
import { toPathKey } from '../pathKey.js';
import { classifyTool, editedFileOf } from '../progress/phase.js';
import {
  LOOP_IGNORED_INPUT_KEYS,
  LOOP_REPEAT_COUNT,
  LOOP_REPEAT_WINDOW_MS,
  LOOP_STALL_ACTIVE_MS,
} from './constants.js';

/** A value with object keys sorted, ignored keys dropped and strings trimmed
 *  with runs of whitespace collapsed, so cosmetic differences don't hide a repeat. */
function normalize(value: unknown, top: boolean): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map((v) => normalize(v, false));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (top && LOOP_IGNORED_INPUT_KEYS.has(key)) continue;
    out[key] = normalize((value as Record<string, unknown>)[key], false);
  }
  return out;
}

/** Has this input anything to compare? Remote sessions arrive with every
 *  string emptied by the relay, which would make all their calls look alike. */
function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasContent);
  return false;
}

/** The identity of a tool call for the repeat count, or null when its input
 *  says nothing (no fields, or only empty strings). */
export function repeatKey(toolName: string, input: Record<string, unknown>): string | null {
  const normalized = normalize(input, true);
  if (!hasContent(normalized)) return null;
  return createHash('sha256')
    .update(`${toolName}\0${JSON.stringify(normalized)}`)
    .digest('hex')
    .slice(0, 16);
}

interface LoopState {
  /** Recent repeat keys, oldest first, since the last progress. */
  recent: Array<{ at: number; key: string }>;
  edited: Set<string>;
  phase?: WorkPhase;
  /** Active time since the last progress, excluding the open span. */
  activeMs: number;
  /** Start of the open active span. */
  activeSince?: number;
  looping?: LoopReason;
}

export class LoopDetector {
  private readonly agents = new Map<number, LoopState>();

  private stateFor(id: number): LoopState {
    let s = this.agents.get(id);
    if (!s) {
      s = { recent: [], edited: new Set(), activeMs: 0 };
      this.agents.set(id, s);
    }
    return s;
  }

  /**
   * A tool started. Returns the message to send when the flag changed.
   * `compareInputs` false skips the repeat count (remote sessions).
   */
  onToolStart(
    id: number,
    toolName: string,
    input: Record<string, unknown>,
    now: number,
    compareInputs = true,
  ): AgentLoop | null {
    const s = this.stateFor(id);
    const wasLooping = s.looping;
    // Progress: a new file, or a new phase.
    const file = editedFileOf(toolName, input);
    const fileKey = file ? toPathKey(file) : undefined;
    const phase = classifyTool(toolName, input) ?? undefined;
    const newFile = fileKey !== undefined && !s.edited.has(fileKey);
    const newPhase = phase !== undefined && s.phase !== undefined && phase !== s.phase;
    if (fileKey) s.edited.add(fileKey);
    if (phase) s.phase = phase;
    if (newFile || newPhase) {
      this.restart(s, now);
      return wasLooping ? loopMessage(id, undefined) : null;
    }
    // Repeats.
    const key = compareInputs ? repeatKey(toolName, input) : null;
    if (key) {
      s.recent = s.recent.filter((r) => now - r.at < LOOP_REPEAT_WINDOW_MS);
      s.recent.push({ at: now, key });
      const count = s.recent.filter((r) => r.key === key).length;
      if (count >= LOOP_REPEAT_COUNT) s.looping ??= 'repeat';
    }
    this.checkStall(s, now);
    return s.looping !== wasLooping ? loopMessage(id, s.looping) : null;
  }

  /** The agent started (or keeps) working. */
  onActive(id: number, now: number): void {
    this.stateFor(id).activeSince ??= now;
  }

  /** The agent's turn ended: its active span closes. */
  onWaiting(id: number, now: number): void {
    const s = this.agents.get(id);
    if (!s || s.activeSince === undefined) return;
    s.activeMs += Math.max(0, now - s.activeSince);
    s.activeSince = undefined;
  }

  /** The agent went to sleep: nothing to flag on an idle session. */
  onSleep(id: number, now: number): AgentLoop | null {
    const s = this.agents.get(id);
    if (!s) return null;
    const was = s.looping;
    this.restart(s, now);
    s.activeSince = undefined;
    return was ? loopMessage(id, undefined) : null;
  }

  /** Periodic stall check; the messages for agents that just started stalling. */
  check(now: number): AgentLoop[] {
    const changed: AgentLoop[] = [];
    for (const [id, s] of this.agents) {
      if (s.looping) continue;
      this.checkStall(s, now);
      if (s.looping) changed.push(loopMessage(id, s.looping));
    }
    return changed;
  }

  remove(id: number): void {
    this.agents.delete(id);
  }

  /** Every looping agent right now. */
  snapshot(): AgentLoop[] {
    const out: AgentLoop[] = [];
    for (const [id, s] of this.agents) if (s.looping) out.push(loopMessage(id, s.looping));
    return out;
  }

  private checkStall(s: LoopState, now: number): void {
    const open = s.activeSince !== undefined ? Math.max(0, now - s.activeSince) : 0;
    if (s.activeMs + open >= LOOP_STALL_ACTIVE_MS) s.looping ??= 'stall';
  }

  /** Progress: clear the flag and count afresh from now. */
  private restart(s: LoopState, now: number): void {
    s.looping = undefined;
    s.recent = [];
    s.activeMs = 0;
    if (s.activeSince !== undefined) s.activeSince = now;
  }
}

function loopMessage(id: number, reason: LoopReason | undefined): AgentLoop {
  return reason
    ? { type: 'agentLoop', id, looping: true, reason }
    : { type: 'agentLoop', id, looping: false };
}
