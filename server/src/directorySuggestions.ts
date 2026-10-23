/**
 * Path suggestions for the Directory modal.
 *
 * Adding a Directory means naming a filesystem path, and typing an absolute path
 * on a phone keyboard is miserable. The machine already knows where agents have
 * been run: every session transcript records the working directory it ran in. So
 * the office asks (`requestDirectorySuggestions`) and the host answers with those
 * directories, deduped, existence-checked, and stripped of everything already in
 * the Directory union — what's left is exactly "somewhere you've worked that
 * isn't a Directory yet", which is what the modal offers as taps.
 *
 * Enumeration goes through the provider's file-fallback surface
 * (`getAllSessionRoots()` + `sessionFilePattern`), so a second CLI integration
 * gets suggestions for free. Only the `cwd` field is read out of the transcript
 * lines themselves — the one thing every transcript format we support records.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import {
  DIRECTORY_SUGGESTION_FILES_PER_SESSION_DIR,
  DIRECTORY_SUGGESTION_HEAD_BYTES,
  DIRECTORY_SUGGESTION_LIMIT,
} from './constants.js';
import { type HostDirectoryEntry, listDirectories, normalizeDirectoryPath } from './directories.js';

/** The slice of a provider this needs: where sessions live and what they're
 *  called. Both are optional on HookProvider (a provider without a file
 *  fallback simply yields no suggestions), which is why this is a Pick. */
export type SuggestionProvider = Pick<HookProvider, 'getAllSessionRoots' | 'sessionFilePattern'>;

/** A working directory a provider's sessions say was recently worked in, with
 *  the recency the office orders by. Both sources speak it: a transcript walk
 *  (mtime) and a session store (its own activity column, already in ms). */
type SuggestionEntry = { cwd: string; lastActive: number };

/** One provider's file-fallback walk: every transcript root, every session
 *  directory, the working directories recovered out of them (recency included).
 *  Both collectors below are this plus the shared hardening tail. */
function transcriptEntries(provider: SuggestionProvider): SuggestionEntry[] {
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  const entries: SuggestionEntry[] = [];
  for (const root of provider.getAllSessionRoots?.() ?? []) {
    for (const sessionDir of listSubdirectories(root)) {
      const recovered = recoverWorkingDirectory(sessionDir, suffix);
      if (recovered !== undefined) entries.push(recovered);
    }
  }
  return entries;
}

/**
 * Directories the user has already run agents in and hasn't turned into a
 * Directory yet, most recently worked-in first, capped at
 * `DIRECTORY_SUGGESTION_LIMIT`.
 *
 * Recency comes from transcript mtimes: the newest transcript in a session
 * directory is the last time an agent ran there. Ordering by it puts the
 * projects the user is actually in the middle of at the top, and makes the cap
 * cut off the long-abandoned tail rather than everything past `a…`.
 *
 * Every failure mode here is "no suggestion": an unreadable root, a transcript
 * without a cwd, a directory that has since been deleted. Suggestions are a
 * convenience, so nothing they touch may ever throw into the message dispatch.
 */
export function collectDirectorySuggestions(
  provider: SuggestionProvider,
  hostDirectories: HostDirectoryEntry[],
): string[] {
  return dedupeSort(transcriptEntries(provider), hostDirectories);
}

/**
 * The SAME list across ALL registered providers: file-fallback walks (Claude)
 * plus structured session stores (Hermes' `sessions` table via
 * `directorySuggestions`). One hardening step over the single-provider form:
 * a provider that throws contributes nothing rather than poisoning the whole
 * answer — suggestions are a convenience and may never fail the modal.
 */
export function collectAllDirectorySuggestions(
  providers: readonly (SuggestionProvider & Pick<HookProvider, 'directorySuggestions'>)[],
  hostDirectories: HostDirectoryEntry[],
): string[] {
  const entries: SuggestionEntry[] = [];
  for (const provider of providers) {
    try {
      entries.push(...transcriptEntries(provider));
      for (const entry of provider.directorySuggestions?.() ?? []) {
        if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
          entries.push({ cwd: entry.cwd, lastActive: entry.lastActiveMs });
        }
      }
    } catch {
      continue; // one provider's broken store must not zero out the rest
    }
  }
  return dedupeSort(entries, hostDirectories);
}

/** Shared tail of both collectors: drop what the union already has, resolve,
 *  require existence, collapse duplicate spellings to their freshest entry,
 *  and order by last activity so the cap trims abandoned projects. */
function dedupeSort(entries: SuggestionEntry[], hostDirectories: HostDirectoryEntry[]): string[] {
  const known = new Set(
    listDirectories(hostDirectories).map((directory) => normalizeDirectoryPath(directory.path)),
  );
  const byKey = new Map<string, { resolved: string; lastActive: number }>();
  for (const entry of entries) {
    const resolved = path.resolve(entry.cwd);
    const key = normalizeDirectoryPath(resolved);
    if (known.has(key)) continue;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.lastActive = Math.max(existing.lastActive, entry.lastActive);
      continue;
    }
    // A session's directory can be renamed or deleted long after the fact;
    // suggesting one would only produce a rejection when the modal saved it.
    if (!isDirectory(resolved)) continue;
    byKey.set(key, { resolved, lastActive: entry.lastActive });
  }
  return [...byKey.values()]
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, DIRECTORY_SUGGESTION_LIMIT)
    .map((entry) => entry.resolved);
}

/** `'*.jsonl'` → `'.jsonl'`. Anything else (or nothing) matches every file, so
 *  a provider that doesn't declare a pattern still gets scanned. */
function transcriptSuffix(pattern: string | undefined): string {
  if (pattern === undefined) return '';
  return pattern.startsWith('*') ? pattern.slice(1) : pattern;
}

function listSubdirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The working directory the sessions in this directory ran in, and when one
 * last ran there. They all share one cwd (the directory's name encodes it), so
 * the first transcript that yields an answer settles it — the rest of the reads
 * are only there for empty or half-written files. Recency is the newest mtime
 * across ALL the directory's transcripts (stats are cheap where reads are not):
 * the cwd may come out of the oldest file while the latest session is what
 * makes the suggestion current.
 */
function recoverWorkingDirectory(
  sessionDir: string,
  suffix: string,
): { cwd: string; lastActive: number } | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return undefined;
  }

  let cwd: string | undefined;
  let lastActive = 0;
  let attempts = 0;
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const transcriptPath = path.join(sessionDir, entry);
    lastActive = Math.max(lastActive, mtimeOf(transcriptPath));
    if (cwd !== undefined || attempts >= DIRECTORY_SUGGESTION_FILES_PER_SESSION_DIR) continue;
    attempts++;
    cwd = readWorkingDirectory(transcriptPath);
  }
  return cwd === undefined ? undefined : { cwd, lastActive };
}

function mtimeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Read the head of one transcript and return the first `cwd` it records. */
function readWorkingDirectory(transcriptPath: string): string | undefined {
  let head: { text: string; truncated: boolean };
  try {
    head = readHead(transcriptPath, DIRECTORY_SUGGESTION_HEAD_BYTES);
  } catch {
    return undefined;
  }

  const lines = head.text.split('\n');
  // A head that filled the buffer almost certainly cuts a line in half, and
  // parsing that fragment would only throw. A short read is the whole file, so
  // its last line is real and stays.
  if (head.truncated) {
    lines.pop();
  }
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const record = JSON.parse(line) as { cwd?: unknown };
      if (typeof record.cwd === 'string' && record.cwd.length > 0) {
        return record.cwd;
      }
    } catch {
      // Malformed line: the transcript is appended to live, so a partial write
      // is normal. Keep going.
    }
  }
  return undefined;
}

function readHead(filePath: string, maxBytes: number): { text: string; truncated: boolean } {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf-8'),
      truncated: bytesRead === maxBytes,
    };
  } finally {
    fs.closeSync(handle);
  }
}
