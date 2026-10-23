/**
 * Task titles: the name Claude Code gives a session's task ("Draft review by
 * email"), which the office shows on the agent's label beside its repo.
 *
 * Claude Code writes it into the session transcript as `ai-title` records,
 * many per file as the task takes shape; the newest wins. The server reads the
 * latest one when it adopts or restores an agent and follows new ones while it
 * watches the transcript. Transcripts run to many megabytes, so seeding reads
 * only the tail (and, when that has none, the head) -- never the whole file.
 *
 * Remote (relayed) agents have no transcript on this machine, so no title.
 */

import * as fs from 'fs';

import type { AgentTitle } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  TASK_TITLE_MAX_LENGTH,
  TITLE_SEED_HEAD_BYTES,
  TITLE_SEED_TAIL_BYTES,
} from './constants.js';
import type { AgentState } from './types.js';

const AI_TITLE_RECORD_TYPE = 'ai-title';
/** Cheap pre-filter: only lines naming the record type are parsed. */
const AI_TITLE_MARKER = `"${AI_TITLE_RECORD_TYPE}"`;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The title an `ai-title` record carries, display-ready; undefined for any
 *  other record or an unusable title. */
export function aiTitleOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const { type, aiTitle } = record as Record<string, unknown>;
  if (type !== AI_TITLE_RECORD_TYPE || typeof aiTitle !== 'string') return undefined;
  const title = aiTitle.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return undefined;
  return title.length > TASK_TITLE_MAX_LENGTH
    ? title.slice(0, TASK_TITLE_MAX_LENGTH - 1).trimEnd() + '…'
    : title;
}

/** The newest title in a chunk of JSONL text, or undefined. */
function newestTitleIn(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(AI_TITLE_MARKER)) continue;
    try {
      const title = aiTitleOf(JSON.parse(line));
      if (title) return title;
    } catch {
      /* a half-written or malformed line */
    }
  }
  return undefined;
}

function readChunk(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, read);
}

/**
 * The newest task title in a transcript: searched for in its last
 * TITLE_SEED_TAIL_BYTES, then -- for a longer file whose tail has none -- in its
 * first TITLE_SEED_HEAD_BYTES (a title from the middle of a very long
 * transcript may be missed; the head's is older but better than none).
 * Undefined when there is none, or no readable file.
 */
export function readLatestAiTitle(file: string): string | undefined {
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return undefined;
    const tailStart = Math.max(0, size - TITLE_SEED_TAIL_BYTES);
    let tail = readChunk(fd, tailStart, size - tailStart);
    // A mid-file start lands inside a record; drop that fragment.
    if (tailStart > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    const fromTail = newestTitleIn(tail);
    if (fromTail || tailStart === 0) return fromTail;
    // May overlap the tail (it held no title, so that costs nothing) -- which
    // also covers a title record straddling the tail's start.
    let head = readChunk(fd, 0, Math.min(TITLE_SEED_HEAD_BYTES, size));
    // The head's last line may be cut off; keep only whole lines.
    head = head.slice(0, head.lastIndexOf('\n') + 1);
    return newestTitleIn(head);
  } catch {
    return undefined; // unreadable transcript -- the stream may still bring one
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Set an agent's title; broadcasts agentTitle when it changed. */
export function setAgentTitle(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  title: string,
): void {
  if (agent.title === title) return;
  agent.title = title;
  agents.broadcast({ type: 'agentTitle', id: agentId, title } satisfies AgentTitle);
}

/** Give a watched agent that has no title yet the newest one in its transcript. */
export function seedAgentTitle(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.title !== undefined || agent.remoteSource || !agent.jsonlFile) return;
  const title = readLatestAiTitle(agent.jsonlFile);
  if (title) setAgentTitle(agentId, agent, agents, title);
}
