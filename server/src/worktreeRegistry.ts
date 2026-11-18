/**
 * The registry of the Worktrees Pixel Agents created
 * (`~/.pixel-agents/worktrees.json`): the only proof of ownership — a
 * worktree not listed there is never ours to touch. Also the per-repo queue
 * every git operation on Worktrees runs in (`serialized`), and which process
 * has an agent in an `active` one (`holder`).
 *
 * Every function that changes a Worktree proves ownership with `ownedEntry`
 * before queueing, and again on fresh state inside the queue.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { WorktreeBase } from '../../core/src/messages.js';
import { PIXEL_AGENTS_DIR, WORKTREES_FILE_NAME } from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { exists, realPath, sameFolder } from './pathKey.js';
import { worktreeDirectoryOf, worktreePathIn } from './worktreeLocation.js';

/** What a new Worktree starts from (the Directory's `worktreeBase`): the main
 *  checkout's current commit (`head`, the default — local stacked branches are
 *  often unpushed) or the latest default branch on origin (`fresh`, falling
 *  back to `head` when the fetch fails). */
export type WorktreeBaseChoice = WorktreeBase;

/** The base a Worktree was actually created from, as recorded: what its
 *  commits are later measured against. `mode` is the base used, so a `fresh`
 *  request whose fetch failed records `head`. `ref` is the branch the base
 *  follows (`main`, `origin/main`), absent for a detached main checkout. */
export interface WorktreeBaseRecord {
  mode: WorktreeBaseChoice;
  ref?: string;
  commit: string;
}

/** A Worktree as a launch uses it. */
export interface Worktree {
  name: string;
  path: string;
  branch: string;
  base: WorktreeBaseRecord;
}

/** `active`: an agent runs in it. `kept`: its folder stays by choice.
 *  `parked`: folder removed, branch kept. `needsDecision`: uncommitted changes
 *  are waiting on the user. */
export type WorktreeState = 'active' | 'kept' | 'parked' | 'needsDecision';

/** One registry entry: a Worktree Pixel Agents created. */
export interface WorktreeEntry {
  /** The Directory (its repo root) the Worktree belongs to. */
  directoryPath: string;
  name: string;
  path: string;
  branch: string;
  base: WorktreeBaseRecord;
  /** ms since epoch. */
  createdAt: number;
  /** When anything last touched the entry (every registry write): with
   *  later git activity in its folder, how long a kept one has sat unused. */
  lastUsedAt: number;
  /** When it was last made `active` for an agent about to run in it (create,
   *  restore): a sweep that began before this leaves it to that agent.
   *  Absent on entries from before it existed (lastUsedAt stands in). */
  activatedAt?: number;
  state: WorktreeState;
  /** The sessions run in it, oldest first. */
  sessionIds: string[];
  /** The Pixel Agents process with an agent in it, while `active`: set when
   *  a process makes it active (create, restore) and claimed again when one
   *  takes an agent in it into its office (`hold`). Every process (the
   *  standalone server, each VS Code window) sees only its own agents, so
   *  this is how another one knows the folder is not free. Cleared when the
   *  entry leaves `active`. Absent on entries from before it existed. */
  holder?: WorktreeHolder;
}

/** A process on a machine: a pid only means something on its own host. */
export interface WorktreeHolder {
  pid: number;
  host: string;
}

/** A Worktree named by its folder: a registry entry, or anything with its path. */
export interface WorktreeRef {
  path: string;
}

function registryPath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, WORKTREES_FILE_NAME);
}

const STATES: readonly WorktreeState[] = ['active', 'kept', 'parked', 'needsDecision'];

function parseEntry(raw: unknown): WorktreeEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const base = e.base as Record<string, unknown> | undefined;
  if (
    typeof e.directoryPath !== 'string' ||
    typeof e.name !== 'string' ||
    typeof e.path !== 'string' ||
    typeof e.branch !== 'string' ||
    !base ||
    (base.mode !== 'head' && base.mode !== 'fresh') ||
    typeof base.commit !== 'string' ||
    !STATES.includes(e.state as WorktreeState)
  ) {
    return null;
  }
  return {
    directoryPath: e.directoryPath,
    name: e.name,
    path: e.path,
    branch: e.branch,
    base: {
      mode: base.mode,
      commit: base.commit,
      ...(typeof base.ref === 'string' ? { ref: base.ref } : {}),
    },
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
    lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : 0,
    ...(typeof e.activatedAt === 'number' ? { activatedAt: e.activatedAt } : {}),
    state: e.state as WorktreeState,
    sessionIds: Array.isArray(e.sessionIds)
      ? e.sessionIds.filter((s): s is string => typeof s === 'string')
      : [],
    ...(parseHolder(e.holder) ?? {}),
  };
}

/** `{ holder }` when the field is a well-formed holder; null otherwise (a
 *  malformed one is dropped, as if the entry predated holders). */
function parseHolder(raw: unknown): { holder: WorktreeHolder } | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (
    typeof h.pid !== 'number' ||
    !Number.isInteger(h.pid) ||
    h.pid <= 0 ||
    typeof h.host !== 'string' ||
    h.host.length === 0
  ) {
    return null;
  }
  return { holder: { pid: h.pid, host: h.host } };
}

/** Every Worktree we created, as recorded. A missing or unreadable file is an
 *  empty registry (entries that don't parse are dropped, never guessed at). */
export function readRegistry(): WorktreeEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map(parseEntry).filter((e): e is WorktreeEntry => e !== null);
  } catch {
    return [];
  }
}

export function writeRegistry(entries: WorktreeEntry[]): void {
  writeJsonAtomic(registryPath(), entries);
}

/** Write `patch` into the entry's registry record (null = drop it) and
 *  return the entry as it now stands. */
export function updateEntry(
  entry: WorktreeEntry,
  patch: Partial<WorktreeEntry> | null,
): WorktreeEntry {
  const entries = readRegistry();
  const index = entries.findIndex((e) => sameFolder(e.path, entry.path));
  const next: WorktreeEntry = { ...entry, ...(patch ?? {}), lastUsedAt: Date.now() };
  // Only a running Worktree has a holder.
  if (next.state !== 'active') delete next.holder;
  if (index === -1) {
    if (patch === null) return next;
    entries.push(next);
  } else if (patch === null) {
    entries.splice(index, 1);
  } else {
    entries[index] = next;
  }
  writeRegistry(entries);
  return next;
}

/**
 * The registry entry for `worktree`, when it is one we may manage: listed in
 * the registry, and its path is `<its directoryPath>/<worktrees folder>/<name>`
 * (Claude Code: `.claude/worktrees/<name>`; both as written and with
 * symlinks resolved), never the Directory itself.
 */
export function ownedEntry(
  worktree: WorktreeRef,
): { ok: true; entry: WorktreeEntry } | { ok: false; reason: string } {
  const entry = readRegistry().find((e) => sameFolder(e.path, worktree.path));
  if (!entry) return { ok: false, reason: 'it is not a Worktree Pixel Agents made.' };
  const worktreesDir = path.dirname(worktreePathIn(entry.directoryPath, entry.name));
  const at = worktreeDirectoryOf(entry.path);
  const inPlace =
    at !== null &&
    at.name === entry.name &&
    at.directoryPath === path.resolve(entry.directoryPath) &&
    !sameFolder(entry.path, entry.directoryPath);
  if (!inPlace) {
    return { ok: false, reason: `it is not under ${worktreesDir}.` };
  }
  // Also where it really is: a folder (or a worktrees folder) linked to
  // somewhere else is not ours to touch.
  if (exists(entry.path)) {
    const real = worktreeDirectoryOf(realPath(entry.path));
    if (!real || !sameFolder(real.directoryPath, entry.directoryPath)) {
      return { ok: false, reason: `its folder resolves outside ${worktreesDir}.` };
    }
  }
  return { ok: true, entry };
}

export function refused(worktreePath: string, reason: string): { ok: false; reason: string } {
  console.warn(`[Pixel Agents] Worktrees: refused to touch ${worktreePath}: ${reason}`);
  return { ok: false, reason };
}

/** Record that `sessionId` runs (or ran) in our Worktree at `worktree.path`,
 *  so its agent holds it wherever the session goes (worktreeOccupancy.ts).
 *  Nothing for a worktree that isn't ours, or a session already listed. */
export function recordSession(worktree: { path: string }, sessionId: string): void {
  const entry = readRegistry().find((e) => sameFolder(e.path, worktree.path));
  if (!entry || sessionId === '' || entry.sessionIds.includes(sessionId)) return;
  updateEntry(entry, { sessionIds: [...entry.sessionIds, sessionId] });
}

/** This process, as a holder. */
export function thisProcess(): WorktreeHolder {
  return { pid: process.pid, host: os.hostname() };
}

/** Whether `pid` is a live process on this machine. EPERM = alive, owned by
 *  someone else. A pid reused after its holder crashed reads as alive too:
 *  that only ever keeps a folder, the safe direction. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Why an `active` entry belongs to another live Pixel Agents process, or
 * null when it doesn't (no holder, this process, or a holder that is gone).
 * Every retirement asks first: each process sees only its own agents, so its
 * "no agent runs here" says nothing about another process's.
 *
 * A holder on another host is treated as held: its pid can't be checked from
 * here, and a registry seen by two machines (a home shared over the network)
 * is exactly the case where that machine's agent may be running in the
 * folder. Deleting on a guess is the one outcome we can't take back; a folder
 * kept by mistake costs disk until that machine retires it.
 */
export function heldElsewhere(entry: WorktreeEntry): string | null {
  if (entry.state !== 'active' || !entry.holder) return null;
  const { pid, host } = entry.holder;
  if (host !== os.hostname()) {
    return `an agent on ${host} holds ${entry.branch}.`;
  }
  if (pid === process.pid || !processAlive(pid)) return null;
  return `an agent in another Pixel Agents process (pid ${pid}) is running in ${entry.branch}.`;
}

/**
 * This process has an agent in `worktree` (a reattached terminal, a restored
 * or adopted agent): it becomes the holder, so other processes leave the
 * folder alone. Only an `active` entry of ours; anything else is left as it
 * is (Claude Code's worktrees, a kept folder someone opened by hand).
 */
export function hold(worktree: { path: string }): void {
  const entry = readRegistry().find((e) => sameFolder(e.path, worktree.path));
  if (!entry || entry.state !== 'active') return;
  const me = thisProcess();
  if (entry.holder?.pid === me.pid && entry.holder.host === me.host) return;
  // Only the process that owns an agent's terminal claims, so two live
  // claimants should never meet; if they do, say so rather than let the
  // last writer win in silence.
  const other = heldElsewhere(entry);
  if (other) {
    console.warn(
      `[Pixel Agents] Worktrees: taking over ${entry.branch} although ${other} (pid ${me.pid} claims it now)`,
    );
  }
  updateEntry(entry, { holder: me });
}

/** One git operation at a time per repo: two launches into the same repo at
 *  once would otherwise race for the same free name. */
const repoQueues = new Map<string, Promise<unknown>>();

export function serialized<T>(repo: string, run: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(repo) ?? Promise.resolve();
  const next = previous.then(run, run);
  repoQueues.set(
    repo,
    next.catch(() => undefined),
  );
  return next;
}
