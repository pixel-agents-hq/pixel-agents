/**
 * Tails Codex CLI's structured JSONL session rollouts (~/.codex/sessions/**\/*.jsonl)
 * and re-emits them as normalized hook events over the same POST /api/hooks/:providerId
 * ingress a real hook script uses. Codex has no hooks/plugin API to install into, so
 * this tailer *is* codexProvider.installHooks() -- it reads Codex's own structured
 * session format rather than scraping terminal output.
 *
 * Runs entirely in-process (setInterval), owned by exactly one server instance, so
 * unlike Claude's cross-process hook-script fan-out there is no multi-server registry
 * to consult: the serverUrl/authToken passed to installHooks() are this server's own.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX } from '../../../constants.js';
import {
  CODEX_POLL_INTERVAL_MS,
  CODEX_SESSION_STALE_MS,
  CODEX_SESSIONS_DIRNAME,
} from './constants.js';

interface TrackedSession {
  /** Falls back to the rollout filename until session_meta names the real Codex
   *  session_id, so ExecStart/ExecEnd never lack a session_id to route on. */
  sessionId: string;
  offset: number;
  lineBuffer: string;
  cwd: string;
  lastActivity: number;
  sessionStartSent: boolean;
  sessionEndSent: boolean;
  /** call_id of the most recent unfinished function_call, so we can pair its
   *  function_call_output with a toolEnd for the same id. */
  openToolIds: Set<string>;
}

function postEvent(
  serverUrl: string,
  authToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const json = JSON.stringify(body);
  const url = new URL(`${HOOK_API_PREFIX}/codex`, serverUrl);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
          Authorization: `Bearer ${authToken}`,
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(json);
  });
}

/** Extract the codex-vscode/codex-cli JSON-schema `arguments` string into an object,
 *  falling back to the raw string when it isn't valid JSON (never throw on user data). */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export class CodexTailer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly rootDir: string;

  constructor(
    private readonly serverUrl: string,
    private readonly authToken: string,
    rootDir?: string,
  ) {
    this.rootDir = rootDir ?? path.join(os.homedir(), '.codex', CODEX_SESSIONS_DIRNAME);
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        /* a single failed poll must never take down the interval */
      });
    }, CODEX_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessions.clear();
  }

  private async findRolloutFiles(): Promise<string[]> {
    const results: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return; // sessions/YYYY/MM/DD/*.jsonl
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(full);
      }
    };
    walk(this.rootDir, 0);
    return results;
  }

  private async tick(): Promise<void> {
    const files = await this.findRolloutFiles();
    const seen = new Set<string>();

    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      // Skip files with no growth since last successful parse AND older than the
      // poll window -- avoids re-reading thousands of historical rollouts every tick.
      let tracked = this.sessions.get(file);
      if (!tracked && stat.size === 0) continue;
      if (!tracked && Date.now() - stat.mtimeMs > CODEX_SESSION_STALE_MS) continue; // pre-existing, inactive

      if (!tracked) {
        tracked = {
          sessionId: path.basename(file),
          offset: 0,
          lineBuffer: '',
          cwd: '',
          lastActivity: Date.now(),
          sessionStartSent: false,
          sessionEndSent: false,
          openToolIds: new Set(),
        };
        this.sessions.set(file, tracked);
      }
      seen.add(file);
      if (stat.size < tracked.offset) {
        // Truncated/rotated: restart from the top rather than throwing on a negative read.
        tracked.offset = 0;
        tracked.lineBuffer = '';
      }
      if (stat.size === tracked.offset) continue;

      await this.readNewLines(file, tracked);
    }

    // Sessions whose file we didn't see this tick (deleted/rotated away) or that
    // have gone quiet past the stale window: synthesize sessionEnd once. Codex's
    // JSONL rollout never writes an explicit end-of-session record, so this is a
    // heuristic close, not a real signal -- documented in constants.ts.
    const now = Date.now();
    for (const [file, tracked] of this.sessions) {
      if (tracked.sessionEndSent) continue;
      const stale = now - tracked.lastActivity > CODEX_SESSION_STALE_MS;
      if (stale || !seen.has(file)) {
        if (tracked.sessionStartSent) {
          await this.emit(file, tracked, { hook_event_name: 'SessionEnd', reason: 'idle-timeout' });
        }
        tracked.sessionEndSent = true;
      }
    }
    for (const [file, tracked] of this.sessions) {
      if (tracked.sessionEndSent && now - tracked.lastActivity > CODEX_SESSION_STALE_MS * 2) {
        this.sessions.delete(file);
      }
    }
  }

  private async readNewLines(file: string, tracked: TrackedSession): Promise<void> {
    let chunk: string;
    try {
      const fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      const length = stat.size - tracked.offset;
      if (length <= 0) {
        fs.closeSync(fd);
        return;
      }
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, tracked.offset);
      fs.closeSync(fd);
      tracked.offset = stat.size;
      chunk = buf.toString('utf-8');
    } catch {
      return; // transient read error (mid-write); pick it up next tick
    }

    const combined = tracked.lineBuffer + chunk;
    const lines = combined.split('\n');
    tracked.lineBuffer = lines.pop() ?? ''; // last element may be a partial line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // malformed/truncated line: skip, never crash the tailer
      }
      tracked.lastActivity = Date.now();
      await this.handleRecord(file, tracked, record);
    }
  }

  private async handleRecord(
    file: string,
    tracked: TrackedSession,
    record: Record<string, unknown>,
  ): Promise<void> {
    const type = record.type;
    const payload = (record.payload ?? {}) as Record<string, unknown>;

    if (type === 'session_meta') {
      const sessionId = (payload.session_id ?? payload.id) as string | undefined;
      if (typeof sessionId !== 'string') return;
      tracked.cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      tracked.sessionId = sessionId;
      if (!tracked.sessionStartSent) {
        tracked.sessionStartSent = true;
        await this.emit(file, tracked, {
          hook_event_name: 'SessionStart',
          cwd: tracked.cwd,
          transcript_path: file,
        });
      }
      return;
    }

    if (type === 'response_item' && payload.type === 'function_call') {
      const callId = payload.call_id;
      const name = payload.name;
      if (typeof callId !== 'string' || typeof name !== 'string') return;
      tracked.openToolIds.add(callId);
      await this.emit(file, tracked, {
        hook_event_name: 'ExecStart',
        tool_id: callId,
        tool_name: name,
        tool_input: parseArgs(payload.arguments),
      });
      return;
    }

    if (type === 'response_item' && payload.type === 'function_call_output') {
      const callId = payload.call_id;
      if (typeof callId !== 'string') return;
      tracked.openToolIds.delete(callId);
      await this.emit(file, tracked, { hook_event_name: 'ExecEnd', tool_id: callId });
      return;
    }

    if (
      type === 'event_msg' &&
      (payload.type === 'task_complete' || payload.type === 'turn_aborted')
    ) {
      await this.emit(file, tracked, { hook_event_name: 'TurnEnd' });
      return;
    }
  }

  /** All events for a session carry the rollout file's basename as session_id so the
   *  runtime can distinguish concurrent Codex sessions across different projects. */
  private async emit(
    _file: string,
    tracked: TrackedSession,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await postEvent(this.serverUrl, this.authToken, {
      ...fields,
      session_id: tracked.sessionId,
      cwd: fields.cwd ?? tracked.cwd,
    });
  }
}
