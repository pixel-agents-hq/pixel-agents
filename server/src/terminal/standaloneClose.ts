/**
 * How standalone ends an agent the user (the card's ×) or an agent
 * (close_agent) closed: one rule for both callers.
 */

import type { AgentRuntime } from '../agentRuntime.js';
import type { TerminalSessions } from './terminalSessions.js';

/**
 * Two shapes: a PTY-backed agent we launched (kill the process -- the
 * counterpart of VS Code's terminalRef.dispose()), or an external agent we
 * merely observed (dismiss its file so the scanner doesn't re-adopt it, then
 * remove: its process runs on wherever it was started). `dispose` is a no-op
 * for agents with no terminal, so this is safe for both. The PTY's onExit
 * does the store cleanup for PTY-backed agents; closing here too removes
 * external agents (and a PTY that never exits) at once. removeAgent fires
 * agentRemoved, which the server maps to an agentClosed broadcast.
 */
export function closeStandaloneAgent(
  ptyManager: TerminalSessions | undefined,
  runtime: AgentRuntime,
  id: number,
): void {
  ptyManager?.dispose(id);
  runtime.closeAgent(id);
}
