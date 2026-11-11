/**
 * Role storage: ~/.pixel-agents/roles/, the host's private record of which Role
 * contents the operator trusted, and the snapshot copies agents launch with.
 *
 *   roles/                 0700, a real directory owned by the operator
 *     trust.json           0600 { version, trusted: [{ directory, roleId, sha256 }] }
 *     snapshots/<pid>/     0700, one per server process
 *       <uuid>.md          0600, the exact bytes one agent was launched with
 *
 * Nothing here is ever followed through a symlink or accepted with the wrong
 * owner or mode: a storage directory that fails the check is refused (callers
 * answer roleRejected) rather than repaired, because a directory someone else
 * prepared is exactly where a forged trust record or a swapped snapshot would
 * live. Only a directory this process just created is chmod-ed to 0700.
 *
 * trust.json is read strictly. A file that is unreadable or not exactly the
 * expected shape means "nothing is trusted" and is never rewritten -- the user's
 * file stays as it was, and writes are refused until they fix or delete it.
 * Every read-modify-write of it runs through one in-process queue, so two
 * confirmations at once never lose an entry.
 *
 * Log lines name no Directory and carry no content: errors are reported by
 * their errno code only.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LAYOUT_FILE_DIR,
  ROLE_ID_PATTERN,
  ROLE_ID_SUFFIX,
  ROLE_SHA256_PATTERN,
  ROLES_SNAPSHOTS_DIR_NAME,
  ROLES_STORAGE_DIR_MODE,
  ROLES_STORAGE_DIR_NAME,
  ROLES_TRUST_FILE_MAX_BYTES,
  ROLES_TRUST_FILE_NAME,
  ROLES_TRUST_FILE_VERSION,
} from './constants.js';
import {
  checkPrivateDirectory,
  ensurePrivateDirectory,
  errnoCode,
  StorageUnsafeError,
} from './privateStorage.js';
import { writeFileSecure } from './secureFileWrite.js';

/** One trusted Role content: where (the Directory's realpath), which file, which bytes. */
export interface TrustEntry {
  directory: string;
  roleId: string;
  sha256: string;
}

/** Thrown when a storage directory exists but is not private to the operator.
 *  The very same class object as StorageUnsafeError, so instanceof checks against
 *  either name agree. */
export const RoleStorageUnsafeError = StorageUnsafeError;
export type RoleStorageUnsafeError = StorageUnsafeError;

/** Thrown when trust.json exists but cannot be trusted (unreadable or malformed). */
export class RoleTrustUnreadableError extends Error {}

function rolesStorageDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, ROLES_STORAGE_DIR_NAME);
}

function trustFilePath(): string {
  return path.join(rolesStorageDir(), ROLES_TRUST_FILE_NAME);
}

function snapshotsRoot(): string {
  return path.join(rolesStorageDir(), ROLES_SNAPSHOTS_DIR_NAME);
}

/** Verify ~/.pixel-agents/roles/ without creating it: fine when absent, throws
 *  RoleStorageUnsafeError when present but not private. */
export async function checkRolesStorage(): Promise<void> {
  await checkPrivateDirectory(rolesStorageDir());
}

/** ~/.pixel-agents/roles/, created when absent, verified always. */
export async function ensureRolesStorage(): Promise<string> {
  const dir = rolesStorageDir();
  // The parent is the shared ~/.pixel-agents; an existing one keeps its mode.
  await fs.promises.mkdir(path.dirname(dir), { recursive: true, mode: ROLES_STORAGE_DIR_MODE });
  await ensurePrivateDirectory(dir);
  return dir;
}

// ── Trust records ───────────────────────────────────────────

/** Strict shape check. Anything unexpected -- an extra key, a wrong type, a
 *  malformed id or hash -- makes the whole file untrusted. */
function parseTrustFile(raw: unknown): TrustEntry[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || record.version !== ROLES_TRUST_FILE_VERSION) return null;
  if (!Array.isArray(record.trusted)) return null;
  const entries: TrustEntry[] = [];
  for (const item of record.trusted) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 3) return null;
    const { directory, roleId, sha256 } = entry;
    if (typeof directory !== 'string' || directory.length === 0) return null;
    if (typeof roleId !== 'string' || !ROLE_ID_PATTERN.test(roleId)) return null;
    if (typeof sha256 !== 'string' || !ROLE_SHA256_PATTERN.test(sha256)) return null;
    entries.push({ directory, roleId, sha256 });
  }
  return entries;
}

type TrustRead =
  { state: 'ok'; entries: TrustEntry[] } | { state: 'absent' } | { state: 'corrupt' };

/** Read trust.json without following a symlink and without reading past the cap. */
async function readTrustFile(): Promise<TrustRead> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      trustFilePath(),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { state: 'absent' };
    console.error(`[Pixel Agents] Roles: trust.json could not be opened (${errnoCode(err)}).`);
    return { state: 'corrupt' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > ROLES_TRUST_FILE_MAX_BYTES) {
      console.error('[Pixel Agents] Roles: trust.json is not a plain file of acceptable size.');
      return { state: 'corrupt' };
    }
    const buffer = Buffer.alloc(ROLES_TRUST_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > ROLES_TRUST_FILE_MAX_BYTES) return { state: 'corrupt' };
    const entries = parseTrustFile(JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8')));
    if (!entries) {
      console.error(
        '[Pixel Agents] Roles: trust.json has an unexpected structure; left untouched.',
      );
      return { state: 'corrupt' };
    }
    return { state: 'ok', entries };
  } catch (err) {
    console.error(
      `[Pixel Agents] Roles: trust.json is unreadable or not JSON (${errnoCode(err)}); left untouched.`,
    );
    return { state: 'corrupt' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

let trustQueue: Promise<unknown> = Promise.resolve();

/** Run `task` after every earlier trust access settled, so read-modify-writes
 *  never interleave within this process. */
function serializeTrust<T>(task: () => Promise<T>): Promise<T> {
  const run = trustQueue.then(task, task);
  trustQueue = run.catch(() => undefined);
  return run;
}

function sameEntry(a: TrustEntry, b: TrustEntry): boolean {
  return a.directory === b.directory && a.roleId === b.roleId && a.sha256 === b.sha256;
}

/**
 * Whether this exact content is trusted. Never creates anything: absent storage
 * or an absent / malformed trust.json simply means "not trusted". Throws
 * RoleStorageUnsafeError when the storage directory exists but is not private.
 */
export function isRoleTrusted(entry: TrustEntry): Promise<boolean> {
  return serializeTrust(async () => {
    if ((await checkPrivateDirectory(rolesStorageDir())) === 'absent') return false;
    const read = await readTrustFile();
    return read.state === 'ok' && read.entries.some((e) => sameEntry(e, entry));
  });
}

/**
 * Record `entry` as trusted. Throws RoleStorageUnsafeError (storage not
 * private), RoleTrustUnreadableError (trust.json malformed: left untouched), or
 * the write error itself.
 */
export function addTrustedRole(entry: TrustEntry): Promise<void> {
  return serializeTrust(async () => {
    await ensureRolesStorage();
    const read = await readTrustFile();
    if (read.state === 'corrupt') throw new RoleTrustUnreadableError('trust.json is malformed');
    const entries = read.state === 'ok' ? read.entries : [];
    if (entries.some((e) => sameEntry(e, entry))) return;
    const next = { version: ROLES_TRUST_FILE_VERSION, trusted: [...entries, entry] };
    await writeFileSecure(trustFilePath(), `${JSON.stringify(next, null, 2)}\n`);
  });
}

// ── Launch snapshots ────────────────────────────────────────

/** snapshots/<pid>/ for this process, created and verified level by level. */
async function ensureOwnSnapshotDir(): Promise<string> {
  await ensureRolesStorage();
  const root = snapshotsRoot();
  await ensurePrivateDirectory(root);
  const own = path.join(root, String(process.pid));
  await ensurePrivateDirectory(own);
  return own;
}

/**
 * Write the bytes an agent launches with to a fresh private file and return its
 * path -- the only Role path ever handed to claude (never the repo's file, which
 * could change under the running agent). Throws on any failure.
 */
export async function writeRoleSnapshot(content: Buffer): Promise<string> {
  const dir = await ensureOwnSnapshotDir();
  const snapshotPath = path.join(dir, `${crypto.randomUUID()}${ROLE_ID_SUFFIX}`);
  await writeFileSecure(snapshotPath, content);
  return snapshotPath;
}

/**
 * Delete one snapshot. Only paths inside this process's snapshot directory are
 * touched; anything else is ignored. Never throws.
 */
export function removeRoleSnapshot(snapshotPath: string): void {
  const own = path.join(snapshotsRoot(), String(process.pid));
  const relative = path.relative(own, snapshotPath);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return;
  if (relative.includes(path.sep)) return;
  try {
    fs.rmSync(snapshotPath, { force: true });
  } catch (err) {
    console.error(
      `[Pixel Agents] Roles: a launch snapshot could not be removed (${errnoCode(err)}).`,
    );
  }
}

/** True unless the OS says no process has this pid. EPERM is someone else's live process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) !== 'ESRCH';
  }
}

/**
 * Remove snapshots/<pid>/ left by servers that are gone (a crash or SIGKILL
 * skips the per-agent cleanup). Run once at startup. Touches nothing unless
 * the storage and snapshots directories pass the privacy check; skips entries
 * that are not numeric-named real directories, and every live pid (ours
 * included). Never throws.
 */
export async function removeStaleRoleSnapshots(): Promise<number> {
  try {
    if ((await checkPrivateDirectory(rolesStorageDir())) === 'absent') return 0;
    if ((await checkPrivateDirectory(snapshotsRoot())) === 'absent') return 0;
  } catch (err) {
    console.error(
      `[Pixel Agents] Roles: ~/.pixel-agents/roles is not private to you; stale launch snapshots were left alone (${err instanceof Error ? err.message : 'unknown'}).`,
    );
    return 0;
  }
  let removed = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(snapshotsRoot());
  } catch (err) {
    console.error(`[Pixel Agents] Roles: snapshots could not be listed (${errnoCode(err)}).`);
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || isProcessAlive(pid)) {
      continue;
    }
    const entryPath = path.join(snapshotsRoot(), name);
    try {
      const stats = await fs.promises.lstat(entryPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.error(
        `[Pixel Agents] Roles: a stale snapshot directory could not be removed (${errnoCode(err)}).`,
      );
    }
  }
  return removed;
}
