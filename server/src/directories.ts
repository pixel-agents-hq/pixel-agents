/**
 * Directories: the union both hosts show, and the mutations behind it.
 *
 * A Directory is a named filesystem location agents can be launched into. They
 * come from two sources: contributed by the host (VS Code's workspace folders,
 * standalone's start directory — see hostDirectory.ts) or defined by the user in
 * the office. The user-defined ones are machine-wide, living in the shared
 * config tier next to externalAssetDirectories, so a Directory defined on the
 * phone shows up in VS Code and vice versa.
 *
 * Both hosts drive this one module rather than each growing its own copy: the
 * union rules, the validation and the persistence are identical, and only the
 * host entries and the message plumbing differ. Hence `hostDirectories` as an
 * input everywhere — VS Code reads `vscode.workspace.workspaceFolders` (which
 * only the adapter can), standalone calls `hostDirectory()`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { Directory } from '../../core/src/messages.js';
import {
  readConfig,
  type UserDirectory,
  withDirectoryCharacters,
  withDirectoryWorktrees,
  writeConfig,
} from './configPersistence.js';
import { DIRECTORY_WRITE_FAILED_REASON } from './constants.js';
import { directoryNameFor } from './hostDirectory.js';
import { invalidateAttributionDirectories } from './worktreeAttribution.js';
import { branchPrefixProblem, hasOriginRemote, isRepo } from './worktreeGit.js';

/** What a host contributes to the union. `source` is the union's business, so
 *  a host only says what and where. */
export interface HostDirectoryEntry {
  name: string;
  path: string;
}

export type DirectorySaveResult = { ok: true; path: string } | { ok: false; reason: string };

/** A stored user-defined Directory, exactly as persisted. */
export type DirectoryStoreResult =
  { ok: true; directory: UserDirectory } | { ok: false; reason: string };

export type DirectoryRemoveResult = { ok: true } | { ok: false; reason: string };

/** Expand a leading `~` to the home directory. Anything else is returned as
 *  typed (trimmed) — `~` mid-path is a legal directory name, not a shorthand. */
export function expandTilde(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Dedupe/compare key for a path: tilde-expanded and resolved, so `~/p`, `p` and
 * `/home/me/p/` are one Directory. Windows paths are case-folded because its
 * filesystem is; POSIX paths are not, because its filesystem isn't.
 */
export function normalizeDirectoryPath(raw: string): string {
  const resolved = path.resolve(expandTilde(raw));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Host-side validation for a typed path: it must exist and be a directory.
 * Returns the expanded absolute path, which is what gets persisted — the office
 * never has to re-expand `~` and two hosts can't disagree about what it meant.
 */
export function validateDirectoryPath(raw: string): DirectorySaveResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Enter a directory path.' };
  }
  const resolved = path.resolve(expandTilde(trimmed));
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return { ok: false, reason: `No such directory: ${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: `Not a directory: ${resolved}` };
  }
  return { ok: true, path: resolved };
}

/**
 * Merge user-defined and host-contributed entries into the list the office
 * shows: deduped by normalized path with the user-defined entry winning (so a
 * user's name shadows the host's for the same location). Host rows lead the
 * list — "where this window already is" beats the user's own bookmarks — and
 * each group is ordered alphabetically by name.
 */
export function buildDirectoryUnion(
  userDirectories: UserDirectory[],
  hostDirectories: HostDirectoryEntry[],
): Directory[] {
  const byPath = new Map<string, Directory>();
  for (const host of hostDirectories) {
    // A host row has no settings of its own: its Worktrees take the defaults.
    byPath.set(normalizeDirectoryPath(host.path), {
      name: host.name,
      path: host.path,
      source: 'host',
      ...repoFacts(host.path),
    });
  }
  // User entries are applied second, so they overwrite a host entry at the same
  // path. Insertion order is irrelevant: the result is sorted below.
  for (const user of userDirectories) {
    byPath.set(normalizeDirectoryPath(user.path), userDirectory(user));
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'host' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** A stored user-defined Directory as the office sees it. */
function userDirectory(user: UserDirectory): Directory {
  return { ...user, source: 'user', ...repoFacts(user.path) };
}

/** What the office needs to know about a Directory's repo: whether it is
 *  one, and whether it has an origin (stated only when it has). */
function repoFacts(directoryPath: string): Pick<Directory, 'isRepo' | 'hasOrigin'> {
  const repo = isRepo(directoryPath);
  return repo && hasOriginRemote(directoryPath)
    ? { isRepo: true, hasOrigin: true }
    : { isRepo: repo };
}

/** The union for this host, read fresh from the shared config. */
export function listDirectories(hostDirectories: HostDirectoryEntry[]): Directory[] {
  return buildDirectoryUnion(readConfig().directories, hostDirectories);
}

/** The adapter setting behind Settings → Show host Directories (off by default). */
export const KEY_SHOW_HOST_DIRECTORIES = 'pixel-agents.showHostDirectories';

/**
 * The host Directories the office lists: all of them while Show host
 * Directories is on, none while it is off (the default). Only the LIST is
 * gated -- a launch still names its agent from every host Directory -- but
 * what the office is offered (its drawer, a PC's Directory selector) and what
 * a PC shell may open in are this list alike.
 */
export function shownHostDirectories(
  adapter: Pick<StateAdapter, 'getSetting'> | undefined,
  hostDirectories: HostDirectoryEntry[],
): HostDirectoryEntry[] {
  return adapter?.getSetting(KEY_SHOW_HOST_DIRECTORIES, false) ? hostDirectories : [];
}

/** Where this host's Directories are, by name: the union without the `.git`
 *  probe each `isRepo` costs, for the scanners' worktree attribution. */
export function listDirectoryLocations(
  hostDirectories: HostDirectoryEntry[],
): Array<{ name: string; path: string }> {
  const byPath = new Map<string, { name: string; path: string }>();
  for (const host of hostDirectories) {
    byPath.set(normalizeDirectoryPath(host.path), { name: host.name, path: host.path });
  }
  for (const user of readConfig().directories) {
    byPath.set(normalizeDirectoryPath(user.path), { name: user.name, path: user.path });
  }
  return [...byPath.values()];
}

/** A user-defined Directory as it is asked for: by the Directory modal, or an agent. */
export interface UserDirectoryInput {
  name: string;
  path: string;
  /** The path of the entry being edited; without it this is an add. */
  previousPath?: string;
  /** Default characters, as sent (validated here). */
  characters?: unknown;
  characterOrder?: unknown;
  /** Worktree settings, as sent (validated here). */
  worktreeBase?: unknown;
  worktreeBranchPrefix?: unknown;
}

/**
 * `directories` with the user-defined Directory `input` asks for added or
 * edited, and that entry as it would be stored. Nothing is written: the path
 * must exist, the branch prefix be one git takes, an empty name becomes the
 * folder's.
 */
export function withUserDirectory(
  directories: readonly UserDirectory[],
  input: UserDirectoryInput,
):
  | { ok: true; directories: UserDirectory[]; directory: UserDirectory }
  | { ok: false; reason: string } {
  const validation = validateDirectoryPath(input.path);
  if (!validation.ok) {
    return validation;
  }
  const prefixProblem =
    typeof input.worktreeBranchPrefix === 'string'
      ? branchPrefixProblem(input.worktreeBranchPrefix.trim())
      : null;
  if (prefixProblem) {
    return { ok: false, reason: prefixProblem };
  }
  const resolvedPath = validation.path;
  const name = input.name.trim() || directoryNameFor(resolvedPath);

  const newKey = normalizeDirectoryPath(resolvedPath);
  const previousKey =
    input.previousPath === undefined ? null : normalizeDirectoryPath(input.previousPath);

  // Drop the entry being edited AND any entry already at the target path, so an
  // edit that re-points onto an existing Directory merges rather than duplicates.
  const rest = directories.filter((entry) => {
    const key = normalizeDirectoryPath(entry.path);
    return key !== newKey && key !== previousKey;
  });
  const stored = withDirectoryWorktrees(
    withDirectoryCharacters({ name, path: resolvedPath }, input),
    input,
  );
  return { ok: true, directories: [...rest, stored], directory: stored };
}

/**
 * Add or edit a user-defined Directory. `previousPath` identifies the entry
 * being edited; without it this is an add. Nothing is persisted when the path
 * fails validation.
 */
export function saveUserDirectory(input: UserDirectoryInput): DirectoryStoreResult {
  const cfg = readConfig();
  const next = withUserDirectory(cfg.directories, input);
  if (!next.ok) {
    return next;
  }
  cfg.directories = next.directories;
  if (!writeConfig(cfg)) {
    return { ok: false, reason: DIRECTORY_WRITE_FAILED_REASON };
  }
  return { ok: true, directory: next.directory };
}

/** Replace the user-defined Directories in ONE config write (an agent's batch
 *  of Directory edits). Returns whether the write succeeded. */
export function writeUserDirectories(directories: readonly UserDirectory[]): boolean {
  const cfg = readConfig();
  cfg.directories = [...directories];
  return writeConfig(cfg);
}

/**
 * Delete a user-defined Directory. Agents already running in it are untouched —
 * removal is a bookkeeping change, never a destructive one.
 */
export function removeUserDirectory(rawPath: string): DirectoryRemoveResult {
  const cfg = readConfig();
  const key = normalizeDirectoryPath(rawPath);
  cfg.directories = cfg.directories.filter((entry) => normalizeDirectoryPath(entry.path) !== key);
  if (!writeConfig(cfg)) {
    return { ok: false, reason: DIRECTORY_WRITE_FAILED_REASON };
  }
  return { ok: true };
}

/** The user-defined Directories (config.json) with their default characters (palette
 *  indices, highest priority first; none = empty): what OfficeFacts.userDirectories gives. */
export function userDirectoryDefaults(): Array<{
  name: string;
  path: string;
  characters: readonly number[];
}> {
  return readConfig().directories.map((d) => ({
    name: d.name,
    path: d.path,
    characters: d.characters ?? [],
  }));
}

/**
 * Set user-defined Directories' default characters (palette indices), each
 * keeping its pick order and every other setting, in ONE config write. A path
 * that names no user-defined Directory is skipped (a host Directory has no
 * defaults of its own). Returns whether the write succeeded.
 */
export function setDirectoryCharacters(
  writes: ReadonlyArray<{ path: string; characters: readonly number[] }>,
): boolean {
  const cfg = readConfig();
  const wanted = new Map(writes.map((w) => [normalizeDirectoryPath(w.path), w.characters]));
  cfg.directories = cfg.directories.map((entry) => {
    const characters = wanted.get(normalizeDirectoryPath(entry.path));
    return characters
      ? withDirectoryCharacters(entry, { characters, characterOrder: entry.characterOrder })
      : entry;
  });
  return writeConfig(cfg);
}

/**
 * The Directory sitting at `launchPath` (default characters included), or
 * undefined when the launch went somewhere that isn't one.
 *
 * Its name is what an agent wears as its origin label, and — because Area mappings
 * are keyed by Directory name — what steers it towards the seats mapped to its
 * project. Both have to be the name the USER gave the Directory: a Directory
 * called "Side Project" pointing at ~/code/side-project must label its agents
 * "Side Project", or the mapping it was assigned in the modal would never match.
 *
 * Renaming a Directory therefore only affects launches made after the rename;
 * agents already in the office keep the label they were born with.
 */
export function directoryAt(
  launchPath: string,
  hostDirectories: HostDirectoryEntry[],
): Directory | undefined {
  const key = normalizeDirectoryPath(launchPath);
  return listDirectories(hostDirectories).find(
    (directory) => normalizeDirectoryPath(directory.path) === key,
  );
}

/** What a host must supply to dispatch the Directory client messages. */
export interface DirectoryMessageDeps {
  /** This host's own contributions, read at dispatch time. */
  hostDirectories: () => HostDirectoryEntry[];
  /** Fan `directoriesLoaded` out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Point-to-point reply to the requesting client (`directorySaved`,
   *  `directoryRejected`, `directorySuggestions`). */
  reply: (message: Record<string, unknown>) => void;
  /** Paths to offer in the Directory modal, recovered from this host's provider
   *  session transcripts. Injected rather than imported so this module stays
   *  free of provider knowledge — see directorySuggestions.ts. */
  suggestions: () => string[];
}

/**
 * Dispatch the Directory client messages, shared by both hosts. Returns false
 * for anything else so a host can keep its own switch/if-chain intact.
 *
 * Every successful mutation is rebroadcast so every office ends up holding the
 * same list. A save is additionally acked to its sender alone with the entry as
 * stored (`directorySaved`) -- the list cannot say which row is the one just
 * saved, and the office needs its stored name to key the Area mapping. A delete
 * has nothing to key, so the rebroadcast is its success signal.
 */
export function handleDirectoryClientMessage(
  msg: Record<string, unknown>,
  deps: DirectoryMessageDeps,
): boolean {
  switch (msg.type) {
    case 'saveDirectory': {
      const submittedPath = typeof msg.path === 'string' ? msg.path : '';
      const result = saveUserDirectory({
        name: typeof msg.name === 'string' ? msg.name : '',
        path: submittedPath,
        previousPath: typeof msg.previousPath === 'string' ? msg.previousPath : undefined,
        characters: msg.characters,
        characterOrder: msg.characterOrder,
        worktreeBase: msg.worktreeBase,
        worktreeBranchPrefix: msg.worktreeBranchPrefix,
      });
      if (!result.ok) {
        deps.reply({ type: 'directoryRejected', path: submittedPath, reason: result.reason });
        return true;
      }
      broadcastDirectories(deps);
      // The saver's ack, after the list: the entry exactly as stored. Its name
      // can differ from anything the office typed (an empty name becomes the
      // RESOLVED path's basename -- `~` is the home folder's name, not "~"),
      // and Area mappings are keyed by it, so the office takes it from here.
      deps.reply({ type: 'directorySaved', directory: userDirectory(result.directory) });
      return true;
    }

    case 'removeDirectory': {
      if (typeof msg.path !== 'string') {
        return true;
      }
      const result = removeUserDirectory(msg.path);
      if (!result.ok) {
        // Same channel as a refused save: the modal stays open on the entry
        // that is, in fact, still there.
        deps.reply({ type: 'directoryRejected', path: msg.path, reason: result.reason });
        return true;
      }
      broadcastDirectories(deps);
      return true;
    }

    case 'requestDirectorySuggestions': {
      // Answered only to the office that asked: suggestions are a keyboard
      // convenience for one open modal, not shared state.
      deps.reply({ type: 'directorySuggestions', paths: deps.suggestions() });
      return true;
    }

    default:
      return false;
  }
}

function broadcastDirectories(deps: DirectoryMessageDeps): void {
  invalidateAttributionDirectories();
  deps.broadcast({
    type: 'directoriesLoaded',
    directories: listDirectories(deps.hostDirectories()),
  });
}
