/**
 * hermesSessionStore — READ-ONLY access to the session storage Hermes keeps on
 * disk, the provider's twin of Claude's `~/.claude/projects/<dir>/*.jsonl`
 * file fallback.
 *
 * Hermes persists sessions in ONE SQLite database (`<home>/state.db`, tables
 * `sessions` + `messages`) — there is no per-workspace transcript directory to
 * walk, which is why this provider never registers the JSONL-shaped
 * `getSessionDirs` / `getAllSessionRoots` / `sessionFilePattern` members: a
 * file scanner pointed at the home root would find only the emergency
 * diversion JSONLs (`sessions/<id>.jsonl`, written when state.db was replaced
 * under a live process) and mis-adopt them as garbage characters. Instead the
 * office gets structured records from here, and the scanner that turns them
 * into events lives next door in hermesSessionScanner.ts.
 *
 * Liveness comes from a second artifact: `<home>/runtime/active_sessions.json`
 * — Hermes' cross-process session LEASE registry. Every open chat surface
 * (CLI, Desktop app, gateway) writes an entry carrying `pid` +
 * `process_start_time` and releases it at session close. A dead pid behind a
 * still-`ended_at IS NULL` session row is exactly the SIGKILL/app-quit ghost
 * the push-only hook path cannot retire — that pairing is what the scanner's
 * liveness probe keys on.
 *
 * Everything here degrades to "no data": a missing database, an unreadable
 * registry, a row with NULL fields — the caller always receives empty/neutral
 * values, never a throw, because this runs on a poll timer inside the server.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── node:sqlite with graceful degradation ────────────────────────────
// The builtin SQLite driver ships unflagged with Node 22.5+ (stable API in
// modern runtimes). Older hosts simply get NO store: every Hermes capability
// except this file fallback keeps working, exactly like a provider that
// declares no getSessionDirs at all. Structural typing instead of
// `import type ... from 'node:sqlite'` so the build never depends on the
// ambient declaration existing.

interface SqlStatementSync {
  all(...params: unknown[]): unknown[];
}
interface SqlDatabaseSync {
  prepare(sql: string): SqlStatementSync;
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (filePath: string, options?: { readOnly?: boolean }) => SqlDatabaseSync;
};

let sqliteModule: SqliteModule | null | undefined; // undefined = untried

function loadSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = require('node:sqlite') as SqliteModule;
    } catch {
      sqliteModule = null; // Node without the builtin: capability absent
    }
  }
  return sqliteModule;
}

// ── Row shapes ───────────────────────────────────────────────────────

/** One live (or queried) row of `sessions`, only the columns the office uses.
 *  Timestamps arrive as unix SECONDS (Hermes writes time.time()) and are
 *  converted to ms right here, at the format boundary. */
export interface HermesSessionRecord {
  id: string;
  /** Provenance column (`session_source_for(platform)`): cli, tui, desktop,
   *  discord, cron, oneshot, ... NOT necessarily the wire's `platform` value. */
  source: string;
  cwd: string;
  title: string;
  parentSessionId: string | null;
  startedAtMs: number;
  /** freshest of last_activity_at / started_at; 0 when both are NULL. */
  lastActivityMs: number;
  /** Raw activity description Hermes keeps per session ('' when absent) —
   *  e.g. "tool running: browser_exec". The scanner does not render it (v1
   *  status comes from replayed tool events); it is carried for diagnostics. */
  activityDescription: string;
}

/** One `messages` row the scanner has not seen yet (id is the cursor). */
export interface HermesMessageRecord {
  id: number;
  role: string;
  /** Set on role='tool' result rows: the call this row answers. */
  toolCallId: string | null;
  /** Parsed function calls on assistant rows; empty when the JSON is absent
   *  or unparseable (defensive: the writer controls this shape). */
  toolCalls: { id: string; name: string; args?: Record<string, unknown> }[];
  /** Whether the row carries model text — an assistant row WITHOUT calls and
   *  WITH text closes a turn (the replay's turnEnd signal). */
  hasText: boolean;
  timestampMs: number;
}

export interface HermesSessionStore {
  /** Live sessions: not ended, not hidden, not archived (parents AND
   *  sub-agent children — the caller discriminates on parentSessionId). */
  listLiveSessions(): HermesSessionRecord[];
  /** `ended_at` for one session id, in the same ms as every other timestamp
   *  here; null while the row is live; undefined when the row no longer
   *  exists at all (deleted — same dead end). */
  endedAtOf(sessionId: string): number | null | undefined;
  /** Messages newer than `afterId`, oldest first, capped by the caller. */
  listMessagesAfter(sessionId: string, afterId: number, limit: number): HermesMessageRecord[];
  /** Highest message id already persisted for a session — an adoption cursor
   *  for "skip to end" when the session predates our watching (same policy as
   *  the JSONL adoption heuristic: never flash an old session's history
   *  through the UI). */
  latestMessageId(sessionId: string): number;
  /** Distinct working directories across all sessions, freshest first. */
  listDirectorySuggestions(limit: number): { cwd: string; lastActiveMs: number }[];
  close(): void;
}

// ── Opening ──────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toSessionRecord(row: Record<string, unknown>): HermesSessionRecord {
  const started = num(row.started_at);
  const last = num(row.last_activity_at);
  return {
    id: str(row.id),
    source: str(row.source),
    cwd: str(row.cwd),
    title: str(row.title),
    parentSessionId:
      typeof row.parent_session_id === 'string' && row.parent_session_id
        ? row.parent_session_id
        : null,
    startedAtMs: (started ?? 0) * 1000,
    // freshest-of mirrors hermes_state_common: heartbeats rate-limit
    // last_activity_at (~60s), so it can lag a newer start; never trust one.
    lastActivityMs: Math.max(last ?? 0, started ?? 0) * 1000,
    activityDescription: str(row.last_activity_description),
  };
}

/** Open state.db read-only. Returns null (never throws) when the database is
 *  absent, a Node without the sqlite builtin is running, or the file cannot be
 *  opened (locked mid-recovery, permissions) — the scanner then stays dark
 *  until the next attempt, and every other Hermes surface is untouched. */
export function openHermesStore(homeDir: string): HermesSessionStore | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const dbPath = path.join(homeDir, 'state.db');
  let db: SqlDatabaseSync;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  const query = (sql: string, ...params: unknown[]): Record<string, unknown>[] => {
    try {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  return {
    listLiveSessions: () =>
      query(
        `SELECT id, source, cwd, title, parent_session_id, started_at,
                last_activity_at, last_activity_description
         FROM sessions
         WHERE ended_at IS NULL
           AND COALESCE(hidden, 0) = 0
           AND COALESCE(archived, 0) = 0`,
      ).map(toSessionRecord),
    endedAtOf: (sessionId: string) => {
      const rows = query(`SELECT ended_at FROM sessions WHERE id = ?`, sessionId);
      if (rows.length === 0) return undefined;
      const ended = num(rows[0].ended_at);
      return ended === null ? null : ended * 1000;
    },
    listMessagesAfter: (sessionId, afterId, limit) =>
      query(
        `SELECT id, role, tool_call_id, tool_calls,
                (content IS NOT NULL AND content <> '') AS has_text,
                timestamp
         FROM messages
         WHERE session_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
        sessionId,
        afterId,
        limit,
      ).map((row) => ({
        id: num(row.id) ?? 0,
        role: str(row.role),
        toolCallId:
          typeof row.tool_call_id === 'string' && row.tool_call_id ? row.tool_call_id : null,
        toolCalls: parseStoredToolCalls(row.tool_calls),
        hasText: row.has_text === 1 || row.has_text === true,
        timestampMs: (num(row.timestamp) ?? 0) * 1000,
      })),
    latestMessageId: (sessionId) => {
      const rows = query(`SELECT MAX(id) AS max_id FROM messages WHERE session_id = ?`, sessionId);
      return num(rows[0]?.max_id) ?? 0;
    },
    listDirectorySuggestions: (limit) =>
      query(
        `SELECT cwd, MAX(COALESCE(last_activity_at, started_at)) AS last_s
         FROM sessions
         WHERE cwd IS NOT NULL AND cwd <> ''
         GROUP BY cwd
         ORDER BY last_s DESC LIMIT ?`,
        limit,
      )
        .map((row) => ({ cwd: str(row.cwd), lastActiveMs: (num(row.last_s) ?? 0) * 1000 }))
        .filter((entry) => entry.cwd.length > 0),
    close: () => {
      try {
        db.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/** `messages.tool_calls` JSON: Hermes persists the provider-neutral shape
 *  `[{id, call_id, ..., function: {name, arguments}}]`. A torn/legacy value
 *  yields [] — a bad call list must never abort the replay. `arguments` is
 *  the PARSED function-argument object (JSON string in the row) when it
 *  parses to an object, so the caller can project display fields out of it;
 *  undefined when absent/unparseable. */
export function parseStoredToolCalls(
  value: unknown,
): { id: string; name: string; args?: Record<string, unknown> }[] {
  if (typeof value !== 'string' || !value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls: { id: string; name: string; args?: Record<string, unknown> }[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const call = entry as Record<string, unknown>;
    const fn = call.function;
    const fnObj = fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : undefined;
    const name = fnObj ? str(fnObj.name) : '';
    const id = str(call.id) || str(call.call_id);
    if (!name || !id) continue;
    let args: Record<string, unknown> | undefined;
    if (typeof fnObj?.arguments === 'string') {
      try {
        const a = JSON.parse(fnObj.arguments);
        if (a && typeof a === 'object' && !Array.isArray(a)) args = a as Record<string, unknown>;
      } catch {
        /* arguments are display-optional */
      }
    }
    calls.push({ id, name, args });
  }
  return calls;
}

// ── Lease registry (liveness) ────────────────────────────────────────

export interface HermesLease {
  sessionId: string;
  pid: number;
  /** 'cli' | 'desktop' | ... — informational; liveness keys on the pid. */
  surface: string;
}

/** Read `<home>/runtime/active_sessions.json` — the cross-process registry of
 *  OPEN chat surfaces (idle included). Absent/malformed => empty: the scanner
 *  then simply cannot prove death, which it treats as "leave alone", never
 *  "reap". */
export function readHermesLeases(homeDir: string): HermesLease[] {
  const leases: HermesLease[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(homeDir, 'runtime', 'active_sessions.json'), 'utf-8');
  } catch {
    return leases;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return leases;
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return leases;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const lease = entry as Record<string, unknown>;
    if (lease.released === true || lease.enabled === false) continue;
    const sessionId = str(lease.session_id);
    const pid = num(lease.pid);
    if (!sessionId || pid === null || pid <= 0) continue;
    leases.push({ sessionId, pid, surface: str(lease.surface) });
  }
  return leases;
}

/** Existence probe for a local process id. Node raises EPERM on Windows for a
 *  live process we cannot open, ESRCH only when it is gone — so EPERM counts
 *  as alive; anything else than "exists" is treated as dead-but-not-provable
 *  by the CALLER (which only reaps on a POSITIVE death proof). */
export function isHermesPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
