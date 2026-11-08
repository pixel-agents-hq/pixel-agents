/**
 * Knowledge Base file helpers: where things live, how they are read, how the
 * failure of any of it is reported.
 *
 *   ~/.pixel-agents/kb/                 0700 (POSIX only)
 *     .lock.<n>                         writer lock generations (kbLock.ts)
 *     <workspaceId>/                    0700
 *       settings.json index.json        0600
 *       blobs/<uuid>.md                 0600, one entry's content
 *       proposals/<uuid>.json           0600
 *       audit.jsonl audit.<a>-<b>.jsonl 0600 (kbAudit.ts)
 *
 * Every read opens with O_NOFOLLOW|O_NONBLOCK (a symlink fails, a FIFO never
 * blocks), requires a plain file by fstat, and reads at most cap + 1 bytes.
 * Every replace goes through writeFileSecure. Directory fsyncs are best effort:
 * they make a rename durable across a power cut where the platform allows;
 * consistency after a process crash comes from the commit order alone.
 *
 * Failures surface as KbOpError (a code from the fixed set plus a fixed reason)
 * or are turned into `io` at the public boundary. Log lines carry an errno code
 * and ids only -- never a path, a title or content.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  KB_AUDIT_FILE_NAME,
  KB_BLOB_SUFFIX,
  KB_BLOBS_DIR_NAME,
  KB_INDEX_FILE_NAME,
  KB_IO_REASON,
  KB_PROPOSAL_SUFFIX,
  KB_PROPOSALS_DIR_NAME,
  KB_SETTINGS_FILE_NAME,
  KB_STORAGE_DIR_NAME,
  KB_UNSAFE_STORAGE_REASON,
  LAYOUT_FILE_DIR,
  ROLES_STORAGE_DIR_MODE,
  ROLES_STORAGE_FILE_MODE,
} from './constants.js';
import {
  checkPrivateDirectory,
  ensurePrivateDirectory,
  errnoCode,
  StorageUnsafeError,
} from './privateStorage.js';

export { errnoCode };

// ── Error model ─────────────────────────────────────────────

export type KbErrorCode =
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'stale'
  | 'state'
  | 'digest_mismatch'
  | 'too_large'
  | 'quota'
  | 'locked'
  | 'tampered'
  | 'corrupt_index'
  | 'corrupt_settings'
  | 'unsafe_storage'
  | 'io';

export interface KbFailure {
  ok: false;
  code: KbErrorCode;
  reason: string;
}

export type KbResult<T extends object> = ({ ok: true } & T) | KbFailure;

/** A failure with a code from the fixed set and a fixed reason string. */
export class KbOpError extends Error {
  constructor(
    readonly code: KbErrorCode,
    readonly reason: string,
  ) {
    super(code);
  }
}

export function kbFailure(code: KbErrorCode, reason: string): KbFailure {
  return { ok: false, code, reason };
}

/** One log line: a fixed message, then only an errno and ids. */
export function kbLog(message: string, fields: { errno?: string; ids?: string[] } = {}): void {
  const parts = [`[Pixel Agents] KB: ${message}`];
  if (fields.ids && fields.ids.length > 0) parts.push(`[${fields.ids.join(' ')}]`);
  if (fields.errno) parts.push(`(${fields.errno})`);
  console.error(parts.join(' '));
}

/**
 * The public boundary: a KbOpError becomes its failure, a storage directory that
 * is not private becomes unsafe_storage, and anything else becomes io, logged by
 * errno and workspace id only.
 */
export async function kbBoundary<T extends object>(
  operation: string,
  workspaceId: string,
  task: () => Promise<KbResult<T>>,
): Promise<KbResult<T>> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof KbOpError) return kbFailure(err.code, err.reason);
    if (err instanceof StorageUnsafeError) {
      kbLog(`${operation}: storage is not private`, { ids: [workspaceId] });
      return kbFailure('unsafe_storage', KB_UNSAFE_STORAGE_REASON);
    }
    kbLog(`${operation} failed`, { errno: errnoCode(err), ids: [workspaceId] });
    return kbFailure('io', KB_IO_REASON);
  }
}

// ── Paths ───────────────────────────────────────────────────

/** Paths of one KB root. Every id passed here was already validated (kbIds.ts). */
export class KbPaths {
  constructor(readonly root: string) {}

  static forHome(): KbPaths {
    return new KbPaths(path.join(os.homedir(), LAYOUT_FILE_DIR, KB_STORAGE_DIR_NAME));
  }

  workspaceDir(ws: string): string {
    return path.join(this.root, ws);
  }
  settingsFile(ws: string): string {
    return path.join(this.root, ws, KB_SETTINGS_FILE_NAME);
  }
  indexFile(ws: string): string {
    return path.join(this.root, ws, KB_INDEX_FILE_NAME);
  }
  blobsDir(ws: string): string {
    return path.join(this.root, ws, KB_BLOBS_DIR_NAME);
  }
  blobFile(ws: string, blobId: string): string {
    return path.join(this.root, ws, KB_BLOBS_DIR_NAME, `${blobId}${KB_BLOB_SUFFIX}`);
  }
  proposalsDir(ws: string): string {
    return path.join(this.root, ws, KB_PROPOSALS_DIR_NAME);
  }
  proposalFile(ws: string, proposalId: string): string {
    return path.join(this.root, ws, KB_PROPOSALS_DIR_NAME, `${proposalId}${KB_PROPOSAL_SUFFIX}`);
  }
  auditFile(ws: string): string {
    return path.join(this.root, ws, KB_AUDIT_FILE_NAME);
  }
}

// ── Private directories ─────────────────────────────────────

/** POSIX only: Windows has no uid to prove ownership with, as with Roles. */
export function assertKbPlatform(): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new KbOpError('unsafe_storage', KB_UNSAFE_STORAGE_REASON);
  }
}

/** Check a chain of directories without creating anything. 'absent' as soon as
 *  one level is missing; throws StorageUnsafeError when one is not private. */
export async function checkPrivateChain(dirs: string[]): Promise<'ok' | 'absent'> {
  for (const dir of dirs) {
    if ((await checkPrivateDirectory(dir)) === 'absent') return 'absent';
  }
  return 'ok';
}

/** The KB root, created when absent; the shared ~/.pixel-agents keeps its mode
 *  (as ensureRolesStorage does). */
export async function ensureKbRoot(paths: KbPaths): Promise<void> {
  await fs.promises.mkdir(path.dirname(paths.root), {
    recursive: true,
    mode: ROLES_STORAGE_DIR_MODE,
  });
  await ensurePrivateDirectory(paths.root);
}

/** <ws>/, blobs/ and proposals/, each created when absent and verified always. */
export async function ensureWorkspaceDirs(paths: KbPaths, ws: string): Promise<void> {
  await ensurePrivateDirectory(paths.workspaceDir(ws));
  await ensurePrivateDirectory(paths.blobsDir(ws));
  await ensurePrivateDirectory(paths.proposalsDir(ws));
}

// ── Reads ───────────────────────────────────────────────────

export type BoundedRead =
  | { state: 'ok'; bytes: Buffer; stats: fs.Stats }
  | { state: 'absent' }
  | { state: 'not_regular' }
  | { state: 'too_large' }
  | { state: 'error'; errno: string };

const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** O_NOFOLLOW on a symlink fails with ELOOP (EMLINK on some BSDs). */
function isSymlinkRefusal(errno: string): boolean {
  return errno === 'ELOOP' || errno === 'EMLINK';
}

/** Read at most `maxBytes` of a plain file: a symlink, FIFO, device or directory
 *  is `not_regular`, more than `maxBytes` is `too_large`. Never throws. */
export async function readBoundedFile(filePath: string, maxBytes: number): Promise<BoundedRead> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, READ_FLAGS);
  } catch (err) {
    const errno = errnoCode(err);
    if (errno === 'ENOENT') return { state: 'absent' };
    if (isSymlinkRefusal(errno)) return { state: 'not_regular' };
    return { state: 'error', errno };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { state: 'not_regular' };
    if (stats.size > maxBytes) return { state: 'too_large' };
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { state: 'too_large' };
    return { state: 'ok', bytes: Buffer.from(buffer.subarray(0, total)), stats };
  } catch (err) {
    return { state: 'error', errno: errnoCode(err) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Strict JSON: the bytes must be valid UTF-8 and parse; null otherwise. */
export function parseJsonStrict(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Canonical JSON: object keys sorted, no whitespace, absent (undefined) fields
 *  omitted -- never written as null. The input holds only JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Directory entry names, or [] when the directory is absent. */
export async function readDirectoryNames(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

// ── Writes ──────────────────────────────────────────────────

/** Best-effort directory fsync, so a rename inside it survives a power cut.
 *  Returns false (and logs) when the platform or the call refused. */
export async function fsyncDirectory(dir: string, ids: string[]): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    await handle.sync();
    return true;
  } catch (err) {
    kbLog('a directory fsync failed', { errno: errnoCode(err), ids });
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const APPEND_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

/** Open `filePath` for appending (created 0600), refusing anything but a plain
 *  file. The caller closes the handle. */
export async function openForAppend(filePath: string): Promise<fs.promises.FileHandle> {
  const handle = await fs.promises.open(filePath, APPEND_FLAGS, ROLES_STORAGE_FILE_MODE);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new KbOpError('io', KB_IO_REASON);
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

/** Read `length` bytes at `position` of an open file (fewer at its end). */
export async function readAt(
  handle: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

/** Open a plain file read-only without following a symlink or blocking on a FIFO. */
export async function openForRead(filePath: string): Promise<fs.promises.FileHandle> {
  const handle = await fs.promises.open(filePath, READ_FLAGS);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new KbOpError('io', KB_IO_REASON);
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
