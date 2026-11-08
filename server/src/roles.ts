/**
 * Roles: the per-agent layer of rules, read from `<Directory>/.claude/roles/`.
 *
 * A Role is a file the operator put in a Directory; there is no registry. This
 * module answers the four questions every Role request asks, each fail-closed:
 *
 * - Is the id acceptable? ASCII allowlist, `.md`, no Windows device name -- an
 *   id is a bare file name and never a path.
 * - Is the Directory one of ours? Exact normalizeDirectoryPath match against the
 *   registered union; everything downstream uses the REGISTERED entry, never
 *   the client's string.
 * - What Roles are there right now? lstat only, no content read; `.claude` and
 *   `.claude/roles` must both be real directories (a symlink at either level
 *   lists nothing), and only plain, size-capped files are listed.
 * - What exactly is in this one? Opened with O_NOFOLLOW|O_NONBLOCK, bound by
 *   dev/ino to the entry that was listed, size-capped, then checked for invalid
 *   UTF-8 and the characters that can hide instructions from a reviewer.
 *
 * The content never reaches a log line from here.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  ROLE_CLAUDE_DIR_NAME,
  ROLE_DIRECTORY_PATH_MAX_LENGTH,
  ROLE_FILE_MAX_BYTES,
  ROLE_FILES_DIR_NAME,
  ROLE_ID_PATTERN,
  ROLE_ID_SUFFIX,
  ROLE_LIST_MAX_ENTRIES,
  ROLE_SCAN_MAX_ENTRIES,
  ROLE_WINDOWS_RESERVED_NAMES,
} from './constants.js';
import { type HostDirectoryEntry, listDirectories, normalizeDirectoryPath } from './directories.js';
import { decodeSafeText, escapeInvisibleCharacters, sha256Hex } from './textSafety.js';

/** A registered Directory a Role request named, as registered. */
export interface RegisteredDirectory {
  name: string;
  path: string;
}

/** A Directory's `.claude/roles/`, resolved and checked. */
export interface RolesDirectory {
  /** realpath of the registered Directory: the trust key's directory part. */
  realPath: string;
  /** `<realPath>/.claude/roles`: the base every Role file must sit directly in. */
  rolesDir: string;
  claudeStat: fs.Stats;
  rolesStat: fs.Stats;
}

/** One listed Role, with the identity its later read must still match. */
export interface ListedRole {
  roleId: string;
  name: string;
  dev: number;
  ino: number;
}

export type RoleReadFailure = 'unreadable' | 'tooLarge' | 'badContent';

export interface RoleFileContent {
  bytes: Buffer;
  text: string;
  sha256: string;
  mtime: Date;
}

// ── Ids ─────────────────────────────────────────────────────

/** typeof string, the ASCII allowlist, and no Windows device name (`CON.md`,
 *  `nul.notes.md`, ...). A path, a separator, NUL or `:` can never pass. */
export function isValidRoleId(value: unknown): value is string {
  if (typeof value !== 'string' || !ROLE_ID_PATTERN.test(value)) return false;
  const stem = value.split('.')[0].toUpperCase();
  return !ROLE_WINDOWS_RESERVED_NAMES.includes(stem);
}

/** Display name: the id without `.md`. */
export function roleNameFor(roleId: string): string {
  return roleId.slice(0, -ROLE_ID_SUFFIX.length);
}

// ── Directories ─────────────────────────────────────────────

/**
 * The registered Directory `directoryPath` names, or null. Compared exactly as
 * the Directory list itself compares (normalizeDirectoryPath, a literal
 * path.resolve), so `<registered>/link/..` IS the registered entry -- and the
 * caller then uses that entry's path everywhere, never the string it was given.
 */
export function resolveRegisteredDirectory(
  directoryPath: unknown,
  hostDirectories: HostDirectoryEntry[],
): RegisteredDirectory | null {
  if (
    typeof directoryPath !== 'string' ||
    directoryPath.length === 0 ||
    directoryPath.length > ROLE_DIRECTORY_PATH_MAX_LENGTH ||
    directoryPath.includes('\0')
  ) {
    return null;
  }
  const key = normalizeDirectoryPath(directoryPath);
  const match = listDirectories(hostDirectories).find(
    (directory) => normalizeDirectoryPath(directory.path) === key,
  );
  return match ? { name: match.name, path: match.path } : null;
}

async function lstatRealDirectory(dirPath: string): Promise<fs.Stats | null> {
  try {
    const stats = await fs.promises.lstat(dirPath);
    return stats.isDirectory() && !stats.isSymbolicLink() ? stats : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The Directory's `.claude/roles/`, or null when it has none to offer: missing,
 * not a directory, or a symlink (or junction) at either level. Throws only on
 * unexpected filesystem errors.
 */
export async function openRolesDirectory(
  directory: RegisteredDirectory,
): Promise<RolesDirectory | null> {
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(directory.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const claudeDir = path.join(realPath, ROLE_CLAUDE_DIR_NAME);
  const claudeStat = await lstatRealDirectory(claudeDir);
  if (!claudeStat) return null;
  const rolesDir = path.join(claudeDir, ROLE_FILES_DIR_NAME);
  const rolesStat = await lstatRealDirectory(rolesDir);
  if (!rolesStat) return null;
  return { realPath, rolesDir, claudeStat, rolesStat };
}

/** `<rolesDir>/<name>`, only when it sits directly inside rolesDir (judged by
 *  path.relative, so no `..`, separator or absolute path can slip through). */
function roleFilePath(rolesDir: string, name: string): string | null {
  const candidate = path.join(rolesDir, name);
  const relative = path.relative(rolesDir, candidate);
  if (relative !== name || relative.includes(path.sep) || path.isAbsolute(relative)) return null;
  return candidate;
}

// ── Enumeration ─────────────────────────────────────────────

/** A scanned entry before the listing rules are applied. */
export interface ScannedRoleEntry {
  roleId: string;
  stats: fs.Stats;
}

/**
 * The listing rules, separate from the filesystem walk so they can be pinned
 * directly: plain files within the size cap only; names that collide when
 * letter case is ignored are BOTH dropped (whatever their type), since on a
 * case-insensitive volume they are not reliably two files; sorted; capped.
 */
export function pickListableRoles(scanned: ScannedRoleEntry[]): ListedRole[] {
  const caseCounts = new Map<string, number>();
  for (const entry of scanned) {
    const key = entry.roleId.toLowerCase();
    caseCounts.set(key, (caseCounts.get(key) ?? 0) + 1);
  }
  return scanned
    .filter(
      (entry) =>
        caseCounts.get(entry.roleId.toLowerCase()) === 1 &&
        entry.stats.isFile() &&
        !entry.stats.isSymbolicLink() &&
        entry.stats.size <= ROLE_FILE_MAX_BYTES,
    )
    .sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0))
    .slice(0, ROLE_LIST_MAX_ENTRIES)
    .map((entry) => ({
      roleId: entry.roleId,
      name: roleNameFor(entry.roleId),
      dev: entry.stats.dev,
      ino: entry.stats.ino,
    }));
}

/**
 * List the Roles in a checked roles directory, right now. Looks at no more than
 * ROLE_SCAN_MAX_ENTRIES directory entries (a huge directory is truncated, not
 * waited on) and reads no file content.
 */
export async function listRoles(rolesDirectory: RolesDirectory): Promise<ListedRole[]> {
  const scanned: ScannedRoleEntry[] = [];
  const dir = await fs.promises.opendir(rolesDirectory.rolesDir);
  try {
    for (let seen = 0; seen < ROLE_SCAN_MAX_ENTRIES; seen++) {
      const dirent = await dir.read();
      if (!dirent) break;
      if (!isValidRoleId(dirent.name)) continue;
      const filePath = roleFilePath(rolesDirectory.rolesDir, dirent.name);
      if (!filePath) continue;
      try {
        scanned.push({ roleId: dirent.name, stats: await fs.promises.lstat(filePath) });
      } catch {
        // Vanished between readdir and lstat: simply not listed.
      }
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return pickListableRoles(scanned);
}

// ── Content ─────────────────────────────────────────────────

/** Kept under its Role-specific name; the rule is the shared decodeSafeText. */
export const decodeRoleContent = decodeSafeText;
export { escapeInvisibleCharacters, sha256Hex };

function sameInode(a: fs.Stats, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read one listed Role, once. The file must still be the very inode that was
 * listed (dev/ino), a plain file (a FIFO or device swapped in fails here, and
 * O_NONBLOCK keeps a FIFO from blocking the open), within the size cap (at most
 * cap + 1 bytes are read), and both parent directories must still be the ones
 * that were checked. Returns the failure kind instead of throwing.
 */
export async function readRoleFile(
  rolesDirectory: RolesDirectory,
  role: ListedRole,
): Promise<RoleFileContent | RoleReadFailure> {
  const filePath = roleFilePath(rolesDirectory.rolesDir, role.roleId);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!filePath || noFollow === undefined) return 'unreadable';

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK,
    );
  } catch {
    return 'unreadable';
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !sameInode(stats, role)) return 'unreadable';
    if (stats.size > ROLE_FILE_MAX_BYTES) return 'tooLarge';

    const buffer = Buffer.alloc(ROLE_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > ROLE_FILE_MAX_BYTES) return 'tooLarge';

    // The parents must still be the directories that were checked: a level
    // swapped for a symlink mid-read is caught here rather than trusted.
    const claudeNow = await lstatRealDirectory(path.dirname(rolesDirectory.rolesDir));
    const rolesNow = await lstatRealDirectory(rolesDirectory.rolesDir);
    if (
      !claudeNow ||
      !rolesNow ||
      !sameInode(claudeNow, rolesDirectory.claudeStat) ||
      !sameInode(rolesNow, rolesDirectory.rolesStat)
    ) {
      return 'unreadable';
    }

    const bytes = Buffer.from(buffer.subarray(0, total));
    const text = decodeRoleContent(bytes);
    if (text === null) return 'badContent';
    return { bytes, text, sha256: sha256Hex(bytes), mtime: stats.mtime };
  } catch {
    return 'unreadable';
  } finally {
    await handle.close().catch(() => undefined);
  }
}
