/**
 * LocalSessionWatcher: every Claude Code session open on this machine is on the
 * board, even when idle, and the long-idle ones are drawn asleep. Standalone
 * only (cli.ts starts it); owned by AgentRuntime.
 *
 * Every LOCAL_SESSIONS_POLL_MS it reads the open-session list
 * (`claude agents --json`, see createClaudeSessionLister):
 *  - A listed session with no agent is adopted from its transcript --
 *    <home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl, else whichever
 *    project dir holds <sessionId>.jsonl -- through the runtime's normal
 *    adoption path, and marked `fromSessionList`. No transcript yet: try again
 *    next poll. A session whose agent left the board while it stayed listed
 *    (dismissed, or ended by a hook) is not re-adopted until it leaves the list.
 *  - An agent it adopted whose session is missing from
 *    LOCAL_SESSIONS_MISSING_POLLS_TO_REMOVE successful listings in a row ended
 *    without a SessionEnd, and is removed. Agents it didn't adopt never are.
 *  - An agent is asleep while its session is listed `idle` AND its last
 *    activity -- transcript mtime, last transcript data, last `active` status --
 *    is older than SLEEP_AFTER_MS. `agentSleep` is broadcast on change only; an
 *    `agentStatus` active broadcast wakes it at once.
 *
 *  - An agent is background (a compact remote-worker tile, not a character)
 *    while its session is listed with a kind other than `interactive`; a listed
 *    session with no kind is interactive. A local session adopted from its
 *    hooks that no successful listing shows within HEADLESS_SESSION_GRACE_MS of
 *    its adoption is headless (`claude -p`, a routine): background too, until
 *    the list shows it. Known at adoption, the flag rides on agentCreated;
 *    later changes are broadcast as `agentKind`. Teammates belong to their team
 *    and are never reclassified.
 *
 * A failed listing (claude not installed, bad output, timeout) is no news: it
 * changes nothing, is logged once per failure streak, and polling goes on.
 * With the list off (PIXEL_AGENTS_SESSION_LIST, or the VS Code adapter, which
 * never starts the watcher) nothing is ever background.
 * Remote (relay) agents are never adopted over, put to sleep, removed, or
 * made background.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentKind, AgentSleep } from '../../core/src/messages.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  HEADLESS_SESSION_GRACE_MS,
  LOCAL_SESSIONS_BIN_ENV,
  LOCAL_SESSIONS_BIN_POSIX,
  LOCAL_SESSIONS_BIN_WIN32,
  LOCAL_SESSIONS_ENABLED_ENV,
  LOCAL_SESSIONS_INTERACTIVE_KIND,
  LOCAL_SESSIONS_LIST_ARGS,
  LOCAL_SESSIONS_LIST_MAX_BUFFER,
  LOCAL_SESSIONS_LIST_TIMEOUT_MS,
  LOCAL_SESSIONS_MISSING_POLLS_TO_REMOVE,
  LOCAL_SESSIONS_OFF_VALUES,
  LOCAL_SESSIONS_POLL_MS,
  LOCAL_SESSIONS_PROJECTS_SUBPATH,
  SLEEP_AFTER_MS,
} from './constants.js';
import type { AgentState } from './types.js';

// ── The session list ─────────────────────────────────────────

/** What the list says a session is doing; `unknown` for a status this build doesn't know. */
export type LocalSessionStatus = 'idle' | 'busy' | 'waiting' | 'unknown';

/** One open session, as `claude agents --json` lists it. */
export interface LocalSession {
  sessionId: string;
  cwd: string;
  status: LocalSessionStatus;
  pid?: number;
  kind?: string;
  name?: string;
  startedAt?: number;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'waiting']);

/** A session id names a transcript file: nothing that could leave the projects dir. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse `claude agents --json` output. Throws when it isn't a JSON array (the
 * listing failed); drops entries without a usable session id or cwd.
 */
export function parseLocalSessions(stdout: string): LocalSession[] {
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw)) {
    throw new Error('session list is not a JSON array');
  }
  const sessions: LocalSession[] = [];
  for (const entry of raw) {
    const session = toLocalSession(entry);
    if (session) sessions.push(session);
  }
  return sessions;
}

function toLocalSession(entry: unknown): LocalSession | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { sessionId, cwd, status, pid, kind, name, startedAt } = entry as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
  if (typeof cwd !== 'string') return undefined;
  return {
    sessionId,
    cwd,
    status:
      typeof status === 'string' && KNOWN_STATUSES.has(status)
        ? (status as LocalSessionStatus)
        : 'unknown',
    ...(isFiniteNumber(pid) ? { pid } : {}),
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(isFiniteNumber(startedAt) ? { startedAt } : {}),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Runs an executable (never a shell) and resolves with its stdout. */
export type RunExecutable = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<string>;

/** The executable that lists the sessions: PIXEL_AGENTS_CLAUDE_BIN, else claude(.exe) on PATH. */
export function claudeSessionsBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[LOCAL_SESSIONS_BIN_ENV]?.trim();
  if (override) return override;
  return platform === 'win32' ? LOCAL_SESSIONS_BIN_WIN32 : LOCAL_SESSIONS_BIN_POSIX;
}

/** False when PIXEL_AGENTS_SESSION_LIST turns the session list off. */
export function localSessionWatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[LOCAL_SESSIONS_ENABLED_ENV]?.trim().toLowerCase();
  return !value || !(LOCAL_SESSIONS_OFF_VALUES as readonly string[]).includes(value);
}

/** The default lister: `claude agents --json`, validated. Rejects when it fails. */
export function createClaudeSessionLister(
  deps: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: RunExecutable } = {},
): () => Promise<LocalSession[]> {
  const run = deps.run ?? runExecutable;
  return async () => {
    const stdout = await run(
      claudeSessionsBinary(deps.env, deps.platform),
      [...LOCAL_SESSIONS_LIST_ARGS],
      {
        timeout: LOCAL_SESSIONS_LIST_TIMEOUT_MS,
        maxBuffer: LOCAL_SESSIONS_LIST_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return parseLocalSessions(stdout);
  };
}

const runExecutable: RunExecutable = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

// ── The watcher ──────────────────────────────────────────────

/** What the watcher needs from the runtime. */
export interface LocalSessionHost {
  /** Adopt a listed session's transcript; the id of the agent this created, if any. */
  adopt(sessionId: string, transcriptPath: string, cwd: string): number | undefined;
  /** The session's process is gone without a SessionEnd: take its agent off the board. */
  remove(agentId: number): void;
}

export interface LocalSessionWatcherOptions {
  /** Where the open sessions come from. Default: `claude agents --json`. */
  listSessions?: () => Promise<LocalSession[]>;
  /** Clock (tests). */
  now?: () => number;
  /** Home directory holding .claude/projects (tests). */
  homedir?: () => string;
}

interface AgentWatch {
  sleeping: boolean;
  /** Last activity when it fell asleep; set only while sleeping. */
  idleSince?: number;
  /** When an `agentStatus` active last arrived: activity the list and the transcript may lag. */
  lastActiveAt?: number;
  /** Successful listings in a row without its session (watcher-adopted agents only). */
  missingPolls: number;
}

export class LocalSessionWatcher {
  private readonly perAgent = new Map<number, AgentWatch>();
  /** Every board agent by id, so a removal can still name its session. */
  private readonly known = new Map<number, AgentState>();
  /** The last successful listing, by session id. */
  private listed = new Map<string, LocalSession>();
  /** Listed sessions whose agent left the board other than by this watcher. */
  private readonly released = new Set<string>();
  /** Hook-adopted local agents no listing has shown yet: id -> when adopted. */
  private readonly awaitingListing = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;
  private failureLogged = false;
  private readonly listSessions: () => Promise<LocalSession[]>;
  private readonly now: () => number;
  private readonly homedir: () => string;

  constructor(
    private readonly store: AgentStateStore,
    private readonly host: LocalSessionHost,
    options: LocalSessionWatcherOptions = {},
  ) {
    this.listSessions = options.listSessions ?? createClaudeSessionLister();
    this.now = options.now ?? Date.now;
    this.homedir = options.homedir ?? os.homedir;
    store.on('broadcast', this.onBroadcast);
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** Poll now, then every LOCAL_SESSIONS_POLL_MS. */
  start(): void {
    if (this.timer || this.disposed) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), LOCAL_SESSIONS_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentAdded', this.onAgentAdded);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.perAgent.clear();
    this.known.clear();
    this.awaitingListing.clear();
  }

  /** A local session was just adopted from its hooks: unless a listing shows it
   *  within HEADLESS_SESSION_GRACE_MS, it is headless (see updateKinds). */
  noteHookAdoption(agentId: number): void {
    const agent = this.store.get(agentId);
    if (this.disposed || !agent || !kindApplies(agent)) return;
    if (this.listed.has(agent.sessionId)) return; // listed: its kind decides
    this.awaitingListing.set(agentId, this.now());
  }

  /** Is this the watcher for that store? (agentActivityResend finds it module-wide.) */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  isSleeping(agentId: number): boolean {
    return this.perAgent.get(agentId)?.sleeping === true;
  }

  /** What a connecting client is sent: an agentSleep per sleeping agent. */
  snapshot(): AgentSleep[] {
    const messages: AgentSleep[] = [];
    for (const [id, watch] of this.perAgent) {
      if (!watch.sleeping || !this.store.has(id)) continue;
      messages.push({ type: 'agentSleep', id, sleeping: true, idleSince: watch.idleSince });
    }
    return messages;
  }

  /** One listing: adopt, remove, put to sleep. Never throws. */
  async poll(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      let sessions: LocalSession[];
      try {
        sessions = await this.listSessions();
      } catch (err) {
        this.reportFailure(err);
        return;
      }
      if (this.disposed) return;
      if (this.failureLogged) {
        this.failureLogged = false;
        console.log('[Pixel Agents] Session list: available again');
      }
      this.apply(sessions);
    } catch (err) {
      console.error('[Pixel Agents] Session list: poll failed:', err);
    } finally {
      this.polling = false;
    }
  }

  // ── One listing ──────────────────────────────────────────

  private apply(sessions: LocalSession[]): void {
    const bySession = new Map<string, LocalSession>();
    for (const session of sessions) {
      if (!bySession.has(session.sessionId)) bySession.set(session.sessionId, session);
    }
    // Before adopting: onAgentAdded reads it to announce a background kind.
    this.listed = bySession;
    for (const sessionId of this.released) {
      if (!bySession.has(sessionId)) this.released.delete(sessionId);
    }
    for (const [id, agent] of this.store) this.known.set(id, agent);

    this.removeEnded(bySession);
    this.adoptListed(bySession);
    this.updateKinds(bySession);
    this.updateSleep(bySession);
  }

  private removeEnded(bySession: Map<string, LocalSession>): void {
    for (const [id, agent] of [...this.store]) {
      if (!agent.fromSessionList || agent.remoteSource || !this.store.has(id)) continue;
      const watch = this.watchFor(id);
      if (bySession.has(agent.sessionId)) {
        watch.missingPolls = 0;
        continue;
      }
      watch.missingPolls++;
      if (watch.missingPolls < LOCAL_SESSIONS_MISSING_POLLS_TO_REMOVE) continue;
      console.log(
        `[Pixel Agents] Session list: Agent ${id} - session ${agent.sessionId.slice(0, 8)}... no longer open, removing`,
      );
      this.host.remove(id);
    }
  }

  private adoptListed(bySession: Map<string, LocalSession>): void {
    const agents = [...this.store.values()];
    // A /clear is mid-flight (SessionEnd seen, SessionStart not yet): the new
    // session the list may already show belongs to that agent, not a new one.
    if (agents.some((a) => a.pendingClear && !a.remoteSource)) return;
    const onBoard = new Set(agents.map((a) => a.sessionId));
    const adopted: string[] = [];
    for (const session of bySession.values()) {
      if (onBoard.has(session.sessionId) || this.released.has(session.sessionId)) continue;
      const transcript = this.findTranscript(session);
      if (!transcript) continue;
      const id = this.host.adopt(session.sessionId, transcript, session.cwd);
      const agent = id === undefined ? undefined : this.store.get(id);
      if (id === undefined || !agent) continue;
      this.known.set(id, agent);
      onBoard.add(agent.sessionId);
      // No hook has confirmed this session -- it may predate the hooks install,
      // and Claude reads its hooks at startup. Until one arrives, its tool
      // activity comes from the transcript (the first hook flips this back).
      agent.hookDelivered = false;
      if (agent.linesProcessed === 0) {
        // Adopted at the end of its transcript: no data was read, so its last
        // data is the last write, not the moment of adoption.
        const mtime = mtimeOf(transcript);
        if (mtime !== undefined) agent.lastDataAt = Math.min(agent.lastDataAt, mtime);
      }
      // A teammate's lifecycle belongs to its team, not to the list.
      if (agent.leadAgentId === undefined) agent.fromSessionList = true;
      adopted.push(`${agent.id} (${agent.directoryName ?? session.sessionId.slice(0, 8)})`);
    }
    if (adopted.length > 0) {
      console.log(
        `[Pixel Agents] Session list: adopted open session(s) as Agent ${adopted.join(', ')}`,
      );
    }
  }

  /** Background or interactive: the listed kind decides while a session is
   *  listed; a hook-adopted one still unlisted after the grace is headless. */
  private updateKinds(bySession: Map<string, LocalSession>): void {
    const now = this.now();
    for (const [id, agent] of this.store) {
      if (!kindApplies(agent)) {
        this.awaitingListing.delete(id);
        continue;
      }
      const session = bySession.get(agent.sessionId);
      if (session) {
        this.awaitingListing.delete(id);
        this.setBackground(id, agent, isBackgroundKind(session.kind));
        continue;
      }
      const adoptedAt = this.awaitingListing.get(id);
      if (adoptedAt !== undefined && now - adoptedAt >= HEADLESS_SESSION_GRACE_MS) {
        this.awaitingListing.delete(id);
        console.log(
          `[Pixel Agents] Session list: Agent ${id} - session ${agent.sessionId.slice(0, 8)}... never listed, treating it as headless`,
        );
        this.setBackground(id, agent, true);
      }
    }
  }

  private setBackground(id: number, agent: AgentState, background: boolean): void {
    if ((agent.background === true) === background) return;
    agent.background = background ? true : undefined;
    this.store.broadcast({ type: 'agentKind', id, background } satisfies AgentKind);
  }

  private updateSleep(bySession: Map<string, LocalSession>): void {
    const now = this.now();
    for (const [id, agent] of this.store) {
      if (agent.remoteSource) continue;
      const lastActivity = this.lastActivityOf(id, agent);
      const sleeping =
        bySession.get(agent.sessionId)?.status === 'idle' && now - lastActivity > SLEEP_AFTER_MS;
      this.setSleeping(id, sleeping, lastActivity);
    }
  }

  // ── Per agent ────────────────────────────────────────────

  private watchFor(id: number): AgentWatch {
    let watch = this.perAgent.get(id);
    if (!watch) {
      watch = { sleeping: false, missingPolls: 0 };
      this.perAgent.set(id, watch);
    }
    return watch;
  }

  private lastActivityOf(id: number, agent: AgentState): number {
    return Math.max(
      (agent.jsonlFile && mtimeOf(agent.jsonlFile)) || 0,
      agent.lastDataAt,
      this.perAgent.get(id)?.lastActiveAt ?? 0,
    );
  }

  private setSleeping(id: number, sleeping: boolean, lastActivity: number): void {
    if (!sleeping) {
      const watch = this.perAgent.get(id);
      if (!watch?.sleeping) return;
      watch.sleeping = false;
      watch.idleSince = undefined;
      this.store.broadcast({ type: 'agentSleep', id, sleeping: false } satisfies AgentSleep);
      return;
    }
    const watch = this.watchFor(id);
    if (watch.sleeping) return;
    watch.sleeping = true;
    watch.idleSince = Math.floor(lastActivity);
    this.store.broadcast({
      type: 'agentSleep',
      id,
      sleeping: true,
      idleSince: watch.idleSince,
    } satisfies AgentSleep);
  }

  /** The transcript a listed session writes, or undefined when there is none (yet). */
  private findTranscript(session: LocalSession): string | undefined {
    if (!SESSION_ID_PATTERN.test(session.sessionId)) return undefined;
    const root = path.join(this.homedir(), ...LOCAL_SESSIONS_PROJECTS_SUBPATH);
    const fileName = `${session.sessionId}.jsonl`;
    if (session.cwd) {
      const direct = path.join(root, normalizeProjectPath(session.cwd), fileName);
      if (isFile(direct)) return direct;
    }
    // Moved or renamed project, or a cwd spelled differently from the one
    // Claude encoded: whichever project dir holds the session's transcript.
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(root, dir.name, fileName);
      if (isFile(candidate)) return candidate;
    }
    return undefined;
  }

  private reportFailure(err: unknown): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Pixel Agents] Session list unavailable (${reason}); idle sessions are not adopted ` +
        `until it works. Retrying every ${LOCAL_SESSIONS_POLL_MS / 1000}s.`,
    );
  }

  // ── Store events ─────────────────────────────────────────

  /** `agentStatus` active wakes an agent at once. Only agentStatus is read, so
   *  the watcher's own agentSleep broadcasts never loop back here. */
  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    if (this.disposed || message.type !== 'agentStatus' || message.status !== 'active') return;
    const id = message.id;
    if (typeof id !== 'number') return;
    const agent = this.store.get(id);
    if (!agent || agent.remoteSource) return;
    this.watchFor(id).lastActiveAt = this.now();
    this.setSleeping(id, false, 0);
  };

  /** A new agent whose session the last listing names with a background kind
   *  is background from the start, so its agentCreated says so. This listener
   *  is registered when the runtime is built -- before any client's -- so it
   *  runs before the agentCreated broadcast reads the agent. */
  private readonly onAgentAdded = (id: number, agent: AgentState): void => {
    this.known.set(id, agent);
    if (this.disposed || !kindApplies(agent)) return;
    if (isBackgroundKind(this.listed.get(agent.sessionId)?.kind)) agent.background = true;
  };

  private readonly onAgentRemoved = (id: number): void => {
    const agent = this.known.get(id);
    this.known.delete(id);
    this.perAgent.delete(id);
    this.awaitingListing.delete(id);
    // Dismissed (or ended by a hook) while its session is still open. The
    // dismissal tracker forgets after a few minutes; this list would re-adopt.
    if (agent && !agent.remoteSource && this.listed.has(agent.sessionId)) {
      this.released.add(agent.sessionId);
    }
  };
}

/** Does the background/interactive distinction apply? Not to remote agents
 *  (always full characters) nor to teammates and background-spawn children
 *  (their team decides how they are drawn). */
function kindApplies(agent: AgentState): boolean {
  return !agent.remoteSource && agent.leadAgentId === undefined && !agent.spawnToolUseId;
}

/** A listed kind other than interactive. No kind (an older CLI) is interactive. */
function isBackgroundKind(kind: string | undefined): boolean {
  return kind !== undefined && kind !== LOCAL_SESSIONS_INTERACTIVE_KIND;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

// ── The one watcher a connecting client's resend reads ──────

let currentWatcher: LocalSessionWatcher | null = null;

export function setLocalSessionWatcher(watcher: LocalSessionWatcher | null): void {
  currentWatcher = watcher;
}

export function getLocalSessionWatcher(): LocalSessionWatcher | null {
  return currentWatcher;
}
