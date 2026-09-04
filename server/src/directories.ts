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

import type { Directory } from '../../core/src/messages.js';
import { readConfig, type UserDirectory, writeConfig } from './configPersistence.js';
import { directoryNameFor } from './hostDirectory.js';

/** What a host contributes to the union. `source` is the union's business, so
 *  a host only says what and where. */
export interface HostDirectoryEntry {
  name: string;
  path: string;
}

export type DirectorySaveResult = { ok: true; path: string } | { ok: false; reason: string };

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
    byPath.set(normalizeDirectoryPath(host.path), {
      name: host.name,
      path: host.path,
      source: 'host',
    });
  }
  // User entries are applied second, so they overwrite a host entry at the same
  // path. Insertion order is irrelevant: the result is sorted below.
  for (const user of userDirectories) {
    byPath.set(normalizeDirectoryPath(user.path), {
      name: user.name,
      path: user.path,
      source: 'user',
    });
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'host' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The union for this host, read fresh from the shared config. */
export function listDirectories(hostDirectories: HostDirectoryEntry[]): Directory[] {
  return buildDirectoryUnion(readConfig().directories, hostDirectories);
}

/**
 * Add or edit a user-defined Directory. `previousPath` identifies the entry
 * being edited; without it this is an add. Nothing is persisted when the path
 * fails validation.
 */
export function saveUserDirectory(input: {
  name: string;
  path: string;
  previousPath?: string;
}): DirectorySaveResult {
  const validation = validateDirectoryPath(input.path);
  if (!validation.ok) {
    return validation;
  }
  const resolvedPath = validation.path;
  const name = input.name.trim() || directoryNameFor(resolvedPath);

  const cfg = readConfig();
  const newKey = normalizeDirectoryPath(resolvedPath);
  const previousKey =
    input.previousPath === undefined ? null : normalizeDirectoryPath(input.previousPath);

  // Drop the entry being edited AND any entry already at the target path, so an
  // edit that re-points onto an existing Directory merges rather than duplicates.
  cfg.directories = cfg.directories.filter((entry) => {
    const key = normalizeDirectoryPath(entry.path);
    return key !== newKey && key !== previousKey;
  });
  cfg.directories.push({ name, path: resolvedPath });

  writeConfig(cfg);
  return { ok: true, path: resolvedPath };
}

/**
 * Delete a user-defined Directory. Agents already running in it are untouched —
 * removal is a bookkeeping change, never a destructive one.
 */
export function removeUserDirectory(rawPath: string): void {
  const cfg = readConfig();
  const key = normalizeDirectoryPath(rawPath);
  cfg.directories = cfg.directories.filter((entry) => normalizeDirectoryPath(entry.path) !== key);
  writeConfig(cfg);
}

/**
 * The name of the Directory sitting at `launchPath`, or undefined when the
 * launch went somewhere that isn't one.
 *
 * This is what an agent wears as its origin label, and — because Area mappings
 * are keyed by Directory name — what steers it towards the seats mapped to its
 * project. Both have to be the name the USER gave the Directory: a Directory
 * called "Side Project" pointing at ~/code/side-project must label its agents
 * "Side Project", or the mapping it was assigned in the modal would never match.
 *
 * Renaming a Directory therefore only affects launches made after the rename;
 * agents already in the office keep the label they were born with.
 */
export function directoryNameForLaunch(
  launchPath: string,
  hostDirectories: HostDirectoryEntry[],
): string | undefined {
  const key = normalizeDirectoryPath(launchPath);
  return listDirectories(hostDirectories).find(
    (directory) => normalizeDirectoryPath(directory.path) === key,
  )?.name;
}

/** What a host must supply to dispatch the Directory client messages. */
export interface DirectoryMessageDeps {
  /** This host's own contributions, read at dispatch time. */
  hostDirectories: () => HostDirectoryEntry[];
  /** Fan `directoriesLoaded` out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Point-to-point reply to the requesting client (`directoryRejected`,
   *  `directorySuggestions`). */
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
 * Success of a mutation is signalled by the rebroadcast, never by a dedicated
 * ack: every office ends up holding the same list, and the modal treats the
 * broadcast as its "saved" signal.
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
      });
      if (!result.ok) {
        deps.reply({ type: 'directoryRejected', path: submittedPath, reason: result.reason });
        return true;
      }
      broadcastDirectories(deps);
      return true;
    }

    case 'removeDirectory': {
      if (typeof msg.path !== 'string') {
        return true;
      }
      removeUserDirectory(msg.path);
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
  deps.broadcast({
    type: 'directoriesLoaded',
    directories: listDirectories(deps.hostDirectories()),
  });
}
