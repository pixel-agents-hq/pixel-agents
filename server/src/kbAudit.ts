/**
 * The Knowledge Base audit log: one hash-chained JSON line per event.
 *
 * Each line is the canonical JSON of {seq, ts, event, actor, proposalId?,
 * entryId?, detail, prev, hash}, where hash = sha256(prev + canonical JSON of
 * the line without `hash`) and the first line's prev is 64 zeros. The detail
 * holds only hashes, sizes, a kind and a reason code: never a title or content.
 * The log is as sensitive as the blobs and is never shown to an Agent.
 *
 * Appends run inside the workspace queue. The chain tail (seq, hash) is cached
 * after one read of the file's last KB_AUDIT_TAIL_WINDOW_BYTES + 1 bytes. A
 * residual (a last line without its newline, from a crash mid-append) is cut
 * off before the next append. Past KB_AUDIT_ROTATE_BYTES the file is renamed to
 * audit.<firstSeq>-<lastSeq>.jsonl and the chain continues in a fresh file.
 * Nothing ever deletes audit data: past KB_AUDIT_TOTAL_MAX_BYTES, mutations are
 * refused instead (overQuota).
 *
 * verifyAudit re-serializes every line and requires the exact bytes back (so a
 * duplicate key or extra whitespace is a break), then checks seq, prev and hash.
 * A break is reported and logged; it never blocks KB operations.
 *
 * Known limit: any process of the same OS user can rewrite the whole chain.
 * The chain is evidence against partial edits, not a protection boundary.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  KB_AUDIT_FILE_NAME,
  KB_AUDIT_LINE_MAX_BYTES,
  KB_AUDIT_ROTATE_BYTES,
  KB_AUDIT_ROTATED_PATTERN,
  KB_AUDIT_TAIL_WINDOW_BYTES,
  KB_AUDIT_TOTAL_MAX_BYTES,
  KB_IO_REASON,
  KB_SHA256_PATTERN,
  KB_TAMPERED_REASON,
  KB_TOO_LARGE_REASON,
} from './constants.js';
import {
  canonicalJson,
  errnoCode,
  fsyncDirectory,
  kbLog,
  KbOpError,
  type KbPaths,
  openForAppend,
  openForRead,
  parseJsonStrict,
  readAt,
  readBoundedFile,
  readDirectoryNames,
} from './kbFiles.js';
import { sha256Hex } from './textSafety.js';

export type KbAuditEvent =
  | 'proposal_submitted'
  | 'proposal_pending_operator'
  | 'proposal_rejected'
  | 'proposal_stale'
  | 'proposal_voided'
  | 'proposal_expired'
  | 'commit_started'
  | 'entry_created'
  | 'entry_replaced'
  | 'entry_deleted'
  | 'commit_done'
  | 'tampered'
  | 'settings_changed'
  | 'audit_rotated';

export interface KbAuditActor {
  kind: 'agent' | 'operator' | 'system';
  instance?: string;
  agentId?: number;
  sessionId?: string;
  serial?: number;
}

/** The fixed detail fields: hashes, sizes, a kind and a reason code. */
export interface KbAuditDetail {
  sha256?: string;
  size?: number;
  oldSha256?: string;
  oldSize?: number;
  digest?: string;
  kind?: string;
  reason?: string;
}

export interface KbAuditInput {
  event: KbAuditEvent;
  actor: KbAuditActor;
  proposalId?: string;
  entryId?: string;
  detail?: KbAuditDetail;
}

export const KB_AUDIT_GENESIS_PREV = '0'.repeat(64);

/** Keep only the fixed detail fields, so nothing else can ride into the log. */
function pickDetail(detail: KbAuditDetail | undefined): KbAuditDetail {
  const d = detail ?? {};
  return {
    sha256: d.sha256,
    size: d.size,
    oldSha256: d.oldSha256,
    oldSize: d.oldSize,
    digest: d.digest,
    kind: d.kind,
    reason: d.reason,
  };
}

/** One audit line (with its trailing newline excluded) and its hash. */
export function buildAuditLine(
  input: KbAuditInput,
  seq: number,
  ts: string,
  prev: string,
): { line: string; hash: string } {
  const base = {
    seq,
    ts,
    event: input.event,
    actor: {
      kind: input.actor.kind,
      instance: input.actor.instance,
      agentId: input.actor.agentId,
      sessionId: input.actor.sessionId,
      serial: input.actor.serial,
    },
    proposalId: input.proposalId,
    entryId: input.entryId,
    detail: pickDetail(input.detail),
    prev,
  };
  const hash = sha256Hex(Buffer.from(prev + canonicalJson(base), 'utf-8'));
  return { line: canonicalJson({ ...base, hash }), hash };
}

interface ChainTail {
  seq: number;
  hash: string;
}

const NEWLINE = 0x0a;

/** seq and hash of one line, or a fallback that keeps appending possible (the
 *  break itself is verifyAudit's to report). */
function tailFromLine(line: Buffer): ChainTail {
  const parsed = parseJsonStrict(line) as Record<string, unknown> | undefined;
  const seq = parsed && typeof parsed === 'object' ? parsed.seq : undefined;
  const hash = parsed && typeof parsed === 'object' ? parsed.hash : undefined;
  if (
    typeof seq === 'number' &&
    Number.isSafeInteger(seq) &&
    seq >= 0 &&
    typeof hash === 'string' &&
    KB_SHA256_PATTERN.test(hash)
  ) {
    return { seq, hash };
  }
  kbLog('the last audit line is unreadable; the chain continues from its bytes');
  return {
    seq: typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0,
    hash: sha256Hex(line),
  };
}

/** The last complete line of an open file, or null when it has none. */
async function lastCompleteLine(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<Buffer | null> {
  const windowSize = Math.min(size, KB_AUDIT_TAIL_WINDOW_BYTES + 1);
  const start = size - windowSize;
  const window = await readAt(handle, start, windowSize);
  const end = window.lastIndexOf(NEWLINE);
  if (end < 0) return start === 0 ? null : Buffer.alloc(0);
  const before = window.lastIndexOf(NEWLINE, end - 1);
  if (before < 0 && start > 0) return Buffer.alloc(0); // longer than the window
  return window.subarray(before + 1, end);
}

/** The position just after the last newline at or before `size`, scanning back. */
async function lastNewlineEnd(handle: fs.promises.FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - KB_AUDIT_TAIL_WINDOW_BYTES);
    const chunk = await readAt(handle, start, end - start);
    const index = chunk.lastIndexOf(NEWLINE);
    if (index >= 0) return start + index + 1;
    end = start;
  }
  return 0;
}

function rotatedFiles(names: string[]): { name: string; first: number; last: number }[] {
  const files: { name: string; first: number; last: number }[] = [];
  for (const name of names) {
    const match = KB_AUDIT_ROTATED_PATTERN.exec(name);
    if (match) files.push({ name, first: Number(match[1]), last: Number(match[2]) });
  }
  return files.sort((a, b) => a.first - b.first || a.last - b.last);
}

export type KbAuditAppendHook = (inputs: KbAuditInput[]) => void;

/** One workspace's audit log. Every method runs inside that workspace's queue. */
export class KbAuditLog {
  private tail: ChainTail | null = null;
  private totalBytes: number | null = null;

  constructor(
    private readonly paths: KbPaths,
    private readonly ws: string,
    private readonly now: () => number,
    private readonly beforeAppend?: KbAuditAppendHook,
  ) {}

  private get file(): string {
    return this.paths.auditFile(this.ws);
  }

  private async findTail(): Promise<ChainTail> {
    const current = await this.tailOf(this.file);
    if (current) return current;
    const rotated = rotatedFiles(await readDirectoryNames(this.paths.workspaceDir(this.ws)));
    let newest: { name: string; last: number } | null = null;
    for (const file of rotated) {
      if (!newest || file.last > newest.last) newest = file;
    }
    if (newest) {
      const fromRotated = await this.tailOf(
        path.join(this.paths.workspaceDir(this.ws), newest.name),
      );
      if (fromRotated) return fromRotated;
    }
    return { seq: 0, hash: KB_AUDIT_GENESIS_PREV };
  }

  private async tailOf(filePath: string): Promise<ChainTail | null> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await openForRead(filePath);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return null;
      const line = await lastCompleteLine(handle, size);
      return line === null ? null : tailFromLine(line);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async measureTotal(): Promise<number> {
    let total = 0;
    const names = await readDirectoryNames(this.paths.workspaceDir(this.ws));
    for (const name of names) {
      if (name !== KB_AUDIT_FILE_NAME && !KB_AUDIT_ROTATED_PATTERN.test(name)) continue;
      try {
        const stats = await fs.promises.lstat(path.join(this.paths.workspaceDir(this.ws), name));
        if (stats.isFile()) total += stats.size;
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err;
      }
    }
    return total;
  }

  /** Whether the log (rotated files included) is past its total cap. */
  async overQuota(): Promise<boolean> {
    if (this.totalBytes === null) this.totalBytes = await this.measureTotal();
    return this.totalBytes > KB_AUDIT_TOTAL_MAX_BYTES;
  }

  /** Forget the cached tail and total (after another writer may have written). */
  invalidate(): void {
    this.tail = null;
    this.totalBytes = null;
  }

  /** The seq of the current file's first line (0 when unreadable). */
  private async firstSeq(handle: fs.promises.FileHandle): Promise<number> {
    const head = await readAt(handle, 0, KB_AUDIT_LINE_MAX_BYTES + 1);
    const end = head.indexOf(NEWLINE);
    if (end < 0) return 0;
    const parsed = parseJsonStrict(head.subarray(0, end)) as Record<string, unknown> | undefined;
    const seq = parsed && typeof parsed === 'object' ? parsed.seq : undefined;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
  }

  /** Rename the current file away when it is past the rotation size. True when
   *  it was rotated (the next line starts a fresh file). */
  private async rotateIfNeeded(tail: ChainTail): Promise<boolean> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await openForRead(this.file);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }
    let first: number;
    try {
      const { size } = await handle.stat();
      if (size <= KB_AUDIT_ROTATE_BYTES) return false;
      first = await this.firstSeq(handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
    const rotatedPath = path.join(
      this.paths.workspaceDir(this.ws),
      `audit.${first}-${tail.seq}.jsonl`,
    );
    try {
      await fs.promises.lstat(rotatedPath);
      kbLog('the audit log could not be rotated: the archive name is taken', { ids: [this.ws] });
      return false;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw err;
    }
    await fs.promises.rename(this.file, rotatedPath);
    await fsyncDirectory(this.paths.workspaceDir(this.ws), [this.ws]);
    return true;
  }

  /** Cut a residual last line (no trailing newline) off an open append handle. */
  private async cutResidual(handle: fs.promises.FileHandle): Promise<void> {
    const { size } = await handle.stat();
    if (size === 0) return;
    const reader = await openForRead(this.file);
    try {
      const last = await readAt(reader, size - 1, 1);
      if (last.length === 1 && last[0] === NEWLINE) return;
      const keep = await lastNewlineEnd(reader, size);
      await handle.truncate(keep);
      kbLog('a partial last audit line was cut off before appending', { ids: [this.ws] });
      if (this.totalBytes !== null) this.totalBytes -= size - keep;
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  /**
   * Append `inputs` as consecutive lines in one write. Throws on any failure; the
   * cached tail is then dropped so the next append re-reads the file.
   */
  async append(inputs: KbAuditInput[]): Promise<void> {
    if (inputs.length === 0) return;
    try {
      this.beforeAppend?.(inputs);
      if (this.tail === null) this.tail = await this.findTail();
      if (this.totalBytes === null) this.totalBytes = await this.measureTotal();
      let tail = this.tail;
      const records = (await this.rotateIfNeeded(tail))
        ? [{ event: 'audit_rotated' as const, actor: { kind: 'system' as const } }, ...inputs]
        : inputs;

      const ts = new Date(this.now()).toISOString();
      const lines: string[] = [];
      for (const input of records) {
        const { line, hash } = buildAuditLine(input, tail.seq + 1, ts, tail.hash);
        if (Buffer.byteLength(line, 'utf-8') > KB_AUDIT_LINE_MAX_BYTES) {
          throw new KbOpError('io', KB_IO_REASON);
        }
        lines.push(line);
        tail = { seq: tail.seq + 1, hash };
      }
      const data = Buffer.from(`${lines.join('\n')}\n`, 'utf-8');

      const handle = await openForAppend(this.file);
      try {
        await this.cutResidual(handle);
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await handle.write(data, written, data.length - written, null);
          written += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      this.tail = tail;
      this.totalBytes += data.length;
    } catch (err) {
      this.invalidate();
      throw err;
    }
  }
}

export interface KbAuditVerification {
  lines: number;
  /** 1-based ordinal (across every file, oldest first) of the first bad line. */
  brokenAt?: number;
  /** The current file ends in a partial line (left by a crash mid-append). */
  residual?: boolean;
}

/** Verify one parsed line against the chain so far. */
function lineIsValid(raw: Buffer, expectedSeq: number, prev: string): string | null {
  if (raw.length > KB_AUDIT_LINE_MAX_BYTES) return null;
  const parsed = parseJsonStrict(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (canonicalJson(record) !== raw.toString('utf-8')) return null;
  if (record.seq !== expectedSeq || record.prev !== prev) return null;
  const { hash, ...base } = record;
  if (typeof hash !== 'string' || !KB_SHA256_PATTERN.test(hash)) return null;
  if (sha256Hex(Buffer.from(prev + canonicalJson(base), 'utf-8')) !== hash) return null;
  return hash;
}

/**
 * Read the rotated files (oldest first) and the current file, and check every
 * line. Throws KbOpError for a file that is not a plain file or too large.
 */
export async function verifyAuditFiles(paths: KbPaths, ws: string): Promise<KbAuditVerification> {
  const dir = paths.workspaceDir(ws);
  const files = [
    ...rotatedFiles(await readDirectoryNames(dir)).map((file) => ({
      path: path.join(dir, file.name),
      current: false,
    })),
    { path: paths.auditFile(ws), current: true },
  ];
  let prev = KB_AUDIT_GENESIS_PREV;
  let seq = 1;
  let ordinal = 0;
  const result: KbAuditVerification = { lines: 0 };
  for (const file of files) {
    const read = await readBoundedFile(
      file.path,
      KB_AUDIT_TOTAL_MAX_BYTES + KB_AUDIT_LINE_MAX_BYTES,
    );
    if (read.state === 'absent') continue;
    if (read.state === 'not_regular') throw new KbOpError('tampered', KB_TAMPERED_REASON);
    if (read.state === 'too_large') throw new KbOpError('too_large', KB_TOO_LARGE_REASON);
    if (read.state === 'error') throw new KbOpError('io', KB_IO_REASON);
    const bytes = read.bytes;
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(NEWLINE, start);
      ordinal++;
      if (end < 0) {
        if (file.current) {
          result.residual = true;
          return result;
        }
        result.brokenAt = ordinal;
        kbLog('the audit chain is broken', { ids: [ws, String(ordinal)] });
        return result;
      }
      const hash = lineIsValid(bytes.subarray(start, end), seq, prev);
      if (hash === null) {
        result.brokenAt = ordinal;
        kbLog('the audit chain is broken', { ids: [ws, String(ordinal)] });
        return result;
      }
      prev = hash;
      seq++;
      result.lines++;
      start = end + 1;
    }
  }
  return result;
}
