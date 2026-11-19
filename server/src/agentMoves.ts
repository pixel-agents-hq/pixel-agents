/**
 * Following an agent that moves. A running session can change the folder it
 * works in mid-session — Claude Code's EnterWorktree / ExitWorktree, or a
 * background session's own move into a worktree before its first edit — and
 * the agent must keep working through it: same agent, same session, tools,
 * status and context gauge live, with the worktree marker gained or lost.
 *
 * What the CLI does on a move (Claude Code 2.1.310, recorded live in
 * server/__tests__/fixtures/enter-worktree/):
 * - every hook payload names the new folder (`cwd`) and transcript
 *   (`transcript_path`) from the move on; the session id never changes;
 * - an interactive session MOVES its whole transcript file into the new
 *   folder's project dir, same name; the old path is gone;
 * - a `-p` session leaves the file where it was and keeps writing there:
 *   the `transcript_path` its hooks name never exists;
 * - the transcript records the move itself (`relocated`, `worktree-state`).
 *
 * So the one operation, `relocate`, takes whatever a signal says
 * (SessionWhereabouts) and:
 * 1. a new folder → the marker: a folder under a Directory's worktrees
 *    folder (Claude Code: `.claude/worktrees/<name>`) is that worktree
 *    (whoever made it); anywhere
 *    else, none. The agent keeps its Directory, name and look.
 * 2. the transcript → followed only to a file that exists, and only once the
 *    one being read is gone. It is the same file under a new name, so the
 *    read offset and line buffer carry over: nothing is replayed (a resumed
 *    transcript read from 0 resurrects dead background spawns) and the
 *    context gauge keeps its reading. When neither file is there (the signal
 *    beat the rename), it looks again a few times.
 *
 * Signals (each calls `relocate`): a hook whose cwd differs from the agent's
 * (hookEventHandler); without hooks, the transcript's own move records
 * (transcriptParser) and a scanner finding the session's file in another
 * project dir after its old one vanished (fileWatcher).
 *
 * Ownership: EnterWorktree's worktree is Claude's — shown, never registered,
 * so nothing here registers or retires anything (only the user's Remove from
 * the Worktrees list takes it away). A Worktree of ours the agent
 * moves out of stays the agent's — the registry records its session there
 * (worktreeOccupancy.ts): held while it lives (never retired from under it),
 * offered to the leave rules when it leaves.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider, SessionWhereabouts } from '../../core/src/provider.js';
import { agentWorktreeChangedMessage } from './agentMessages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { AGENT_MOVE_RETRY_ATTEMPTS, AGENT_MOVE_RETRY_INTERVAL_MS } from './constants.js';
import { exists, pathsMatch, sameFolder } from './pathKey.js';
import type { AgentState } from './types.js';
import { worktreeAttribution } from './worktreeAttribution.js';
import { broadcastWorktrees } from './worktreeLeave.js';
import { worktreeDirectoryOf } from './worktreeLocation.js';
import { recordSession } from './worktreeRegistry.js';

type Worktree = NonNullable<AgentState['worktree']>;

export interface AgentMovesDeps {
  store: AgentStateStore;
  provider: HookProvider;
  /** Transcripts a scanner must not adopt as new sessions. */
  knownJsonlFiles: { add(file: string): unknown };
}

/**
 * The agent a transcript file already belongs to, if any, as a scanner
 * deciding whether to adopt it must ask (one rule for every scanner):
 * - the file an agent reads (`moved: false`): never a new session;
 * - a file named for an agent's session (the session id) while the file
 *   that agent reads is gone (`moved: true`): Claude Code moved the session's
 *   transcript into the new folder's project dir (EnterWorktree /
 *   ExitWorktree), so the agent follows it — never a new session either.
 * Null otherwise, including a same-named file while the agent's own file is
 * still there: nothing moved (a session continued from another folder, say),
 * so it is adopted as any other session would be, never hidden.
 */
export function agentForTranscript(
  agents: Iterable<[number, AgentState]>,
  file: string,
): { agentId: number; moved: boolean } | null {
  const list = [...agents];
  for (const [agentId, agent] of list) {
    if (agent.jsonlFile && pathsMatch(agent.jsonlFile, file)) return { agentId, moved: false };
  }
  const name = path.basename(file);
  for (const [agentId, agent] of list) {
    if (!agent.jsonlFile || path.basename(agent.jsonlFile) !== name) continue;
    if (!exists(agent.jsonlFile)) return { agentId, moved: true };
  }
  return null;
}

/** Where an agent's vanished transcript went, if it went anywhere under the
 *  provider's session roots (the last look before it is called orphaned). */
export function findMovedTranscript(
  agent: AgentState,
  sessionRoots: readonly string[],
): string | undefined {
  if (!agent.jsonlFile) return undefined;
  const name = path.basename(agent.jsonlFile);
  for (const root of sessionRoots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, name);
      if (!pathsMatch(file, agent.jsonlFile) && exists(file)) return file;
    }
  }
  return undefined;
}

export class AgentMoves {
  private readonly retries = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: AgentMovesDeps) {}

  /**
   * The agent's session runs at `where` now (one signal's word for it).
   * Idempotent: a signal repeating what is already known changes nothing.
   */
  relocate(agentId: number, where: SessionWhereabouts): void {
    const agent = this.deps.store.get(agentId);
    if (!agent) return;
    // The common case, every hook of a session that stays put: same folder
    // (by string first, no realpath), nothing new about the transcript.
    const sameCwd =
      where.cwd === undefined ||
      (agent.cwd !== undefined && (agent.cwd === where.cwd || sameFolder(agent.cwd, where.cwd)));
    if (
      sameCwd &&
      (where.transcriptPath === undefined || pathsMatch(where.transcriptPath, agent.jsonlFile))
    ) {
      return;
    }
    let changed = false;

    const newFolder = !sameCwd;
    if (newFolder) {
      agent.cwd = where.cwd;
      const located = worktreeAttribution(where.cwd, undefined)?.worktree;
      changed = this.mark(agentId, agent, located, where.branch) || changed;
    }

    const followed = this.followTranscript(agentId, agent, where);
    if (followed) changed = true;
    else if (
      this.candidates(agent, where).length > 0 &&
      (newFolder || (agent.jsonlFile !== '' && !exists(agent.jsonlFile)))
    ) {
      // The signal beat the rename (or the file isn't there yet): look again.
      this.retry(agentId, where, 1);
    }

    if (changed) this.deps.store.persist();
  }

  /** Stop looking for moved transcripts. */
  dispose(): void {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  /** Where the session's transcript may be now: the signal's own word for
   *  it, then where the CLI files sessions run in the new folder. Only files
   *  with the transcript's own name (the session id). */
  private candidates(agent: AgentState, where: SessionWhereabouts): string[] {
    if (!agent.jsonlFile) return [];
    const name = path.basename(agent.jsonlFile);
    const out: string[] = [];
    const add = (file: string) => {
      if (path.basename(file) !== name) return;
      if (sameFolder(file, agent.jsonlFile) || out.some((f) => sameFolder(f, file))) return;
      out.push(file);
    };
    if (where.transcriptPath) add(where.transcriptPath);
    if (where.cwd) {
      for (const dir of this.deps.provider.getSessionDirs?.(where.cwd) ?? []) {
        add(path.join(dir, name));
      }
    }
    return out;
  }

  /**
   * Re-point the agent to its transcript's new home, when the file it reads
   * is gone and one of the candidates exists. True when it did. Without a
   * folder in the signal (a scanner's find), the new home says where the
   * agent is, and the marker follows it.
   */
  private followTranscript(agentId: number, agent: AgentState, where: SessionWhereabouts): boolean {
    if (!agent.jsonlFile || exists(agent.jsonlFile)) return false;
    const file = this.candidates(agent, where).find(exists);
    if (!file) return false;

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    const from = agent.jsonlFile;
    agent.jsonlFile = file;
    agent.projectDir = path.dirname(file);
    this.deps.knownJsonlFiles.add(file);
    // The same file under a new name: read on from where we were. A file
    // shorter than what was read isn't those bytes; read on from its end,
    // as for any transcript the agent is newly attached to.
    if (size < agent.fileOffset) {
      agent.fileOffset = size;
      agent.lineBuffer = '';
    }
    console.log(
      `[Pixel Agents] Agent ${agentId} - moved: transcript now ${path.basename(path.dirname(file))}/${path.basename(file)} (was ${path.basename(path.dirname(from))})`,
    );
    if (where.cwd === undefined) {
      const located = worktreeAttribution(undefined, agent.projectDir)?.worktree;
      this.mark(agentId, agent, located, where.branch);
    }
    return true;
  }

  private retry(agentId: number, where: SessionWhereabouts, attempt: number): void {
    const pending = this.retries.get(agentId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.retries.delete(agentId);
      const agent = this.deps.store.get(agentId);
      if (!agent) return;
      if (this.followTranscript(agentId, agent, where)) {
        this.deps.store.persist();
      } else if (attempt < AGENT_MOVE_RETRY_ATTEMPTS) {
        this.retry(agentId, where, attempt + 1);
      }
    }, AGENT_MOVE_RETRY_INTERVAL_MS);
    this.retries.set(agentId, timer);
  }

  /**
   * The agent now runs in `located` (or in no worktree): set its marker,
   * and its in-process followers' (they moved with its process), and tell
   * the offices. True when the marker changed.
   */
  private mark(
    agentId: number,
    agent: AgentState,
    located: Worktree | undefined,
    branch: string | undefined,
  ): boolean {
    const current = agent.worktree;
    if (sameFolder(current?.path, located?.path)) return false;
    const next: Worktree | undefined = located && branch ? { ...located, branch } : located;

    // A Worktree of ours it leaves stays its own until it leaves the office:
    // the registry records its session there (worktreeOccupancy.ts).
    if (current) recordSession(current, agent.sessionId);

    for (const [id, a] of this.deps.store) {
      const follows =
        id === agentId || (a.leadAgentId === agentId && a.sessionId === agent.sessionId);
      if (!follows) continue;
      a.worktree = next;
      this.deps.store.broadcast({ ...agentWorktreeChangedMessage(id, a) });
    }
    console.log(
      `[Pixel Agents] Agent ${agentId} - moved ${next ? `into worktree ${next.branch}` : 'out of its worktree'}`,
    );
    // The Worktrees lists name the agent running in each.
    const directories = new Set<string>();
    for (const w of [current, next]) {
      const at = w && worktreeDirectoryOf(w.path);
      if (at) directories.add(at.directoryPath);
    }
    for (const directoryPath of directories) {
      void broadcastWorktrees(this.deps.store, directoryPath);
    }
    return true;
  }
}
