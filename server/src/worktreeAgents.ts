/**
 * Whose character a Worktree's row wears (`~/.pixel-agents/worktree-agents.json`,
 * by folder, ours and Claude Code's alike). A Worktree belongs to the first
 * agent seen running in it — the one it was made for — and keeps that agent
 * while it runs there or nowhere at all; only when it has gone and another
 * agent runs there does the Worktree become that one's. An agent that merely
 * passed through (a `cd` in and out) never takes it from the one still there.
 *
 * Kept as the session id, not the look: the look comes from the agent while
 * it lives and from the conversation's remembered look after
 * (conversations.ts), which a character list change already renumbers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PIXEL_AGENTS_DIR, WORKTREE_AGENTS_FILE_NAME, WORKTREE_AGENTS_MAX } from './constants.js';
import { conversationLook } from './conversations.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { realPathKey, sameFolder } from './pathKey.js';

interface WorktreeAgent {
  sessionId: string;
  /** When it was last recorded (ms), for pruning. */
  at: number;
}

type WorktreeAgents = Record<string, WorktreeAgent>;

function filePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, WORKTREE_AGENTS_FILE_NAME);
}

function read(): WorktreeAgents {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    if (!isRecord(raw)) return {};
    const out: WorktreeAgents = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!isRecord(value) || typeof value.sessionId !== 'string' || !value.sessionId) continue;
      out[key] = { sessionId: value.sessionId, at: typeof value.at === 'number' ? value.at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The session a Worktree belongs to, given the one it belonged to and the
 * sessions of the agents running in it now (in arrival order): the recorded
 * one while it runs there or nothing does, else the first running there.
 */
export function owningSession(
  recorded: string | undefined,
  runningThere: readonly string[],
): string | undefined {
  if (recorded !== undefined && (runningThere.includes(recorded) || runningThere.length === 0)) {
    return recorded;
  }
  return runningThere[0];
}

/** What a Worktree's row wears. */
export interface WorktreeLook {
  palette: number;
  repeat: number;
}

/**
 * The look of the agent `worktree` belongs to (see the header), recording a
 * change of owner. `fallbackSession`: whose look to show when no agent was
 * ever seen in it (its newest conversation's), never recorded.
 */
export function worktreeLook(
  store: AgentStateStore,
  worktree: { path: string },
  fallbackSession?: string,
): WorktreeLook | undefined {
  const runningThere: string[] = [];
  for (const [, agent] of store) {
    // Followers (Teammates, Sub-agents) wear their lead's look: the lead stands for them.
    if (agent.leadAgentId !== undefined || !agent.sessionId) continue;
    if (sameFolder(agent.worktree?.path, worktree.path)) runningThere.push(agent.sessionId);
  }
  const key = realPathKey(worktree.path);
  const agents = read();
  const recorded = agents[key]?.sessionId;
  const owner = owningSession(recorded, runningThere);
  if (owner !== undefined && owner !== recorded) {
    agents[key] = { sessionId: owner, at: Date.now() };
    const kept = Object.entries(agents)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, WORKTREE_AGENTS_MAX);
    try {
      writeJsonAtomic(filePath(), Object.fromEntries(kept));
    } catch (err) {
      console.error('[Pixel Agents] Failed to save worktree agents:', err);
    }
  }
  const session = owner ?? fallbackSession;
  if (session === undefined) return undefined;
  for (const [, agent] of store) {
    if (agent.sessionId === session && agent.palette !== undefined) {
      return { palette: agent.palette, repeat: agent.repeat ?? 0 };
    }
  }
  const remembered = conversationLook(session);
  return remembered && { palette: remembered.palette, repeat: remembered.repeat };
}
