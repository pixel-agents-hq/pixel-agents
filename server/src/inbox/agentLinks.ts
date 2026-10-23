/**
 * "Open in Claude": how the user gets back to a waiting session.
 *
 * While Remote Control is on, Claude Code writes
 * `{"type":"bridge-session","bridgeSessionId":"cse_…"}` into the transcript
 * (repeatedly). The session then opens on the web at
 * `https://claude.ai/code/session_…` -- the same id with `cse_` spelled
 * `session_`. Without one, the user resumes it in a terminal:
 * `cd "<cwd>" && claude --resume <sessionId>`. Remote (relayed) sessions have
 * no transcript and no cwd here, so they get the bare resume command, with the
 * relay's `<source>:` prefix taken off their session id.
 *
 * Pure helpers plus one bounded transcript read; InboxTracker keeps the state.
 */

import * as fs from 'fs';

import type { AgentLink } from '../../../core/src/messages.js';
import type { AgentState } from '../types.js';
import {
  BRIDGE_SESSION_ID_PATTERN,
  BRIDGE_SESSION_ID_PREFIX,
  BRIDGE_SESSION_RECORD_TYPE,
  CLAUDE_CODE_WEB_URL_PREFIX,
  INBOX_SEED_HEAD_BYTES,
  INBOX_SEED_TAIL_BYTES,
  WEB_SESSION_ID_PREFIX,
} from './constants.js';

/** Cheap pre-filters: only lines naming these are parsed when seeding. */
const BRIDGE_MARKER = `"${BRIDGE_SESSION_RECORD_TYPE}"`;
const API_ERROR_MARKER = '"isApiErrorMessage":true';
const ASSISTANT_MARKER = '"type":"assistant"';

/** A session id that is safe to paste unquoted (UUIDs are). */
const PLAIN_ARGUMENT = /^[A-Za-z0-9._-]+$/;
/** Characters a double-quoted shell word would still interpret. (Backslashes
 *  are left alone: they are Windows path separators, literal in PowerShell
 *  and cmd, and in bash before any ordinary path character.) */
const DOUBLE_QUOTE_UNSAFE = /["$`]/;

/** The web URL for a Remote Control bridge id, or undefined when the id is
 *  not one (anything that would not form a plain claude.ai/code link). */
export function bridgeSessionUrl(bridgeSessionId: string | undefined): string | undefined {
  if (!bridgeSessionId || !BRIDGE_SESSION_ID_PATTERN.test(bridgeSessionId)) return undefined;
  return `${CLAUDE_CODE_WEB_URL_PREFIX}${WEB_SESSION_ID_PREFIX}${bridgeSessionId.slice(BRIDGE_SESSION_ID_PREFIX.length)}`;
}

/** The bridge id a `bridge-session` record carries, or undefined. */
export function bridgeSessionIdOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const { type, bridgeSessionId } = record as Record<string, unknown>;
  if (type !== BRIDGE_SESSION_RECORD_TYPE || typeof bridgeSessionId !== 'string') return undefined;
  return BRIDGE_SESSION_ID_PATTERN.test(bridgeSessionId) ? bridgeSessionId : undefined;
}

/**
 * A path as one shell word for `cd`. Double quotes work in bash, zsh,
 * PowerShell and cmd alike, and keep Windows backslashes literal; a path
 * double quotes would still expand (`"`, `$`, backtick) falls back to POSIX
 * single quotes.
 */
export function quoteShellPath(value: string): string {
  if (!DOUBLE_QUOTE_UNSAFE.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteArgument(value: string): string {
  return PLAIN_ARGUMENT.test(value) ? value : quoteShellPath(value);
}

/** The terminal command that resumes a session: `cd "<cwd>" && claude
 *  --resume <id>`, or the bare resume when the directory is unknown. */
export function resumeCommand(sessionId: string, cwd?: string): string {
  const resume = `claude --resume ${quoteArgument(sessionId)}`;
  return cwd ? `cd ${quoteShellPath(cwd)} && ${resume}` : resume;
}

/** The session id Claude Code knows: a relayed session's id without the
 *  relay's `<source>:` namespace. */
export function claudeSessionIdOf(agent: Pick<AgentState, 'sessionId' | 'remoteSource'>): string {
  const prefix = agent.remoteSource ? `${agent.remoteSource.id}:` : undefined;
  return prefix && agent.sessionId.startsWith(prefix)
    ? agent.sessionId.slice(prefix.length)
    : agent.sessionId;
}

/** The agentLink message for an agent: the web link when its session has a
 *  Remote Control bridge, and always the resume command. */
export function agentLinkMessage(
  id: number,
  agent: Pick<AgentState, 'sessionId' | 'remoteSource'>,
  link: { bridgeSessionId?: string; cwd?: string },
): AgentLink {
  const url = bridgeSessionUrl(link.bridgeSessionId);
  const cwd = agent.remoteSource ? undefined : link.cwd;
  return {
    type: 'agentLink',
    id,
    ...(url ? { url } : {}),
    resumeCommand: resumeCommand(claudeSessionIdOf(agent), cwd),
  };
}

// ── Transcript seeding ──────────────────────────────────────────

/** What a transcript's last stretch says about the inbox. */
export interface TranscriptSeed {
  /** The newest Remote Control bridge id. */
  bridgeSessionId?: string;
  /** The newest assistant record when it is an API error (else undefined):
   *  a session that ended its last turn on a usage limit. */
  lastApiError?: unknown;
  /** The first cwd the transcript records (where the session started). */
  cwd?: string;
}

function readChunk(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, read);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // a half-written or malformed line
  }
}

/** Scan whole JSONL lines newest first for a bridge id and the last assistant record. */
function scanNewestFirst(lines: string[], seed: TranscriptSeed, wantError: boolean): void {
  let sawAssistant = !wantError;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!seed.bridgeSessionId && line.includes(BRIDGE_MARKER)) {
      seed.bridgeSessionId = bridgeSessionIdOf(parse(line));
    }
    if (!sawAssistant && line.includes(ASSISTANT_MARKER)) {
      const record = parse(line);
      if (record?.type === 'assistant') {
        sawAssistant = true;
        if (line.includes(API_ERROR_MARKER)) seed.lastApiError = record;
      }
    }
    if (seed.bridgeSessionId && sawAssistant) return;
  }
}

function firstCwd(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    const cwd = parse(line)?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return undefined;
}

/**
 * Read a transcript's tail (INBOX_SEED_TAIL_BYTES) and head
 * (INBOX_SEED_HEAD_BYTES) for the inbox: the newest bridge id (the tail's,
 * else the head's), whether the last assistant record is an API error, and
 * the session's starting cwd. Empty for a missing or unreadable file.
 */
export function readTranscriptSeed(file: string): TranscriptSeed {
  const seed: TranscriptSeed = {};
  if (!file) return seed;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return seed;
    const tailStart = Math.max(0, size - INBOX_SEED_TAIL_BYTES);
    let tail = readChunk(fd, tailStart, size - tailStart);
    // A mid-file start lands inside a record; drop that fragment.
    if (tailStart > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    scanNewestFirst(tail.split('\n'), seed, true);
    let head = tailStart === 0 ? tail : readChunk(fd, 0, Math.min(INBOX_SEED_HEAD_BYTES, size));
    // The head's last line may be cut off; keep only whole lines.
    if (tailStart > 0) head = head.slice(0, head.lastIndexOf('\n') + 1);
    const headLines = head.split('\n');
    seed.cwd = firstCwd(headLines);
    if (!seed.bridgeSessionId && tailStart > 0) scanNewestFirst(headLines, seed, false);
    return seed;
  } catch {
    return seed; // unreadable transcript -- live records may still bring one
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
