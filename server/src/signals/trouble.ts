/**
 * Trouble: how many tools in a row an agent has failed. The first failure puts
 * a fire on its desk, the third in a row turns on the alarm lamp, and any
 * success clears both (docs/office/DESIGN.md, phase D).
 */

import type { AgentTrouble, TroubleLevel } from '../../../core/src/messages.js';
import { isShellTool } from '../progress/phase.js';
import { TROUBLE_ALARM_FAILURES } from './constants.js';

/** "Exit code 2", as a failed shell result's text begins. */
const EXIT_CODE_TEXT = /^\s*exit code[:\s]+(-?\d+)/i;
/** Numeric exit status fields a shell tool_response may carry. */
const EXIT_CODE_FIELDS = ['exitCode', 'exit_code', 'returnCode', 'return_code', 'code'];

/**
 * Did this finished tool fail? PostToolUseFailure always; a shell tool whose
 * response says it exited non-zero or was interrupted (hooks deliver Bash's
 * response as `{ stdout, stderr, interrupted, … }`).
 */
export function isFailedToolEnd(
  hookEventName: unknown,
  toolName: string,
  response: unknown,
): boolean {
  if (hookEventName === 'PostToolUseFailure') return true;
  if (!isShellTool(toolName)) return false;
  if (typeof response === 'string') return exitCodeFailed(response);
  if (typeof response !== 'object' || response === null) return false;
  const r = response as Record<string, unknown>;
  if (r.interrupted === true) return true;
  for (const field of EXIT_CODE_FIELDS) {
    const code = r[field];
    if (typeof code === 'number' && Number.isFinite(code)) return code !== 0;
  }
  return false;
}

function exitCodeFailed(text: string): boolean {
  const match = text.match(EXIT_CODE_TEXT);
  return match !== null && Number(match[1]) !== 0;
}

export function troubleLevel(failures: number): TroubleLevel {
  if (failures <= 0) return 'none';
  return failures >= TROUBLE_ALARM_FAILURES ? 'alarm' : 'fire';
}

export function troubleMessage(id: number, failures: number): AgentTrouble {
  return { type: 'agentTrouble', id, level: troubleLevel(failures), failures };
}

/** Consecutive failures per agent. */
export class TroubleTracker {
  private readonly failures = new Map<number, number>();

  /** A tool finished; returns the message to send when the agent's trouble changed. */
  record(id: number, failed: boolean): AgentTrouble | null {
    const before = this.failures.get(id) ?? 0;
    if (!failed) {
      if (before === 0) return null;
      this.failures.delete(id);
      return troubleMessage(id, 0);
    }
    this.failures.set(id, before + 1);
    return troubleMessage(id, before + 1);
  }

  remove(id: number): void {
    this.failures.delete(id);
  }

  /** Every agent in trouble right now. */
  snapshot(): AgentTrouble[] {
    return [...this.failures].map(([id, n]) => troubleMessage(id, n));
  }
}
