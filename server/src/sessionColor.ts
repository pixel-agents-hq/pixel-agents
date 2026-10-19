import * as fs from 'node:fs';

import type { AgentStateStore } from './agentStateStore.js';

/**
 * Session color of a Claude Code session, as set with `/color <name>`.
 *
 * Claude Code records every change as its own transcript line
 * `{"type":"agent-color","agentColor":"red","sessionId":"…"}`; the last one
 * wins. Live changes arrive through the normal JSONL polling
 * (applySessionColorRecord). An agent that is adopted mid-session starts
 * reading at the end of its transcript, so its current color is looked up
 * once by scanning the file backwards (readLastSessionColor).
 */

const MARKER = '"type":"agent-color"';
const CHUNK_BYTES = 256 * 1024;

export function sessionColorFromRecord(record: Record<string, unknown>): string | undefined | null {
  if (record.type !== 'agent-color') return null;
  const color = record.agentColor;
  // "default" resets the color
  return typeof color === 'string' && color && color !== 'default' ? color : undefined;
}

export function readLastSessionColor(jsonlFile: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(jsonlFile, 'r');
    let end = fs.fstatSync(fd).size;
    // Overlap chunks so a line cut at a chunk border is still found whole
    let carry = '';
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf-8') + carry;
      const idx = text.lastIndexOf(MARKER);
      if (idx >= 0) {
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        const lineEnd = text.indexOf('\n', idx);
        const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        // A line cut at the chunk start: read one chunk further back
        if (lineStart > 0 || start === 0) {
          try {
            const color = sessionColorFromRecord(JSON.parse(line) as Record<string, unknown>);
            return color ?? undefined;
          } catch {
            return undefined;
          }
        }
      }
      carry = text.slice(0, Math.min(text.length, 4096));
      end = start;
    }
  } catch {
    // Missing or unreadable transcript: no color
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/** Store the color on the agent and tell the clients, if it changed. */
export function applySessionColor(
  agentId: number,
  color: string | undefined,
  agents: AgentStateStore,
): void {
  const agent = agents.get(agentId);
  if (!agent || agent.sessionColor === color) return;
  agent.sessionColor = color;
  agents.broadcast({ type: 'agentSessionColor', id: agentId, color });
}
