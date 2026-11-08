/**
 * The Knowledge Base store: settings, the index, entries, proposals and the
 * commit sequence, for one KB root (~/.pixel-agents/kb). S3a has no runtime
 * caller; S3b's /mcp and S3c's approval entry point will be the callers.
 *
 * Concurrency. One process writes a KB root at a time (kbLock.ts); within the
 * process every operation on a workspace runs on that workspace's queue and
 * re-reads the index and proposal files it decides on. Pure reads work without
 * the lock; anything that changes the disk -- reconciliation included -- needs
 * it, and re-checks it before its first change.
 *
 * Commit (approved proposal, inside the queue, lock held):
 *   1. audit commit_started -- a failure aborts with nothing changed;
 *   2. write the new blob, fsync blobs/ (not for a delete);
 *   3. replace index.json (kbVersion + 1, the entry change, the proposal id
 *      added to the `applied` ring) -- THE commit point -- then fsync the
 *      workspace directory;
 *   4. mark the proposal approved, content dropped -- a failure is only logged;
 *   5. audit entry_<kind> + commit_done -- a failure is only logged;
 *   6. remove the old blob if nothing references it -- best effort.
 * A crash after 3 leaves a pending proposal whose id is in `applied`:
 * reconcileProposal turns it approved (never voided/expired/rejected) on every
 * path that reads or moves pending proposals, and every commit first reconciles
 * pending ids that are in `applied`, so a proposal always reaches a terminal
 * state before the ring can drop it.
 *
 * Results are {ok: true, ...} or {ok: false, code, reason} with a fixed reason;
 * anything unexpected is `io`, logged by errno and ids only.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  KB_APPLIED_RING_MAX,
  KB_BLOB_SUFFIX,
  KB_CORRUPT_INDEX_REASON,
  KB_CORRUPT_SETTINGS_REASON,
  KB_DIGEST_MISMATCH_REASON,
  KB_ENTRIES_MAX,
  KB_ENTRY_CONTENT_MAX_BYTES,
  KB_FILE_FORMAT_VERSION,
  KB_INDEX_FILE_MAX_BYTES,
  KB_INVALID_CONTENT_REASON,
  KB_INVALID_ID_REASON,
  KB_INVALID_INPUT_REASON,
  KB_INVALID_TITLE_REASON,
  KB_IO_REASON,
  KB_LOCKED_REASON,
  KB_NOT_FOUND_REASON,
  KB_PENDING_PER_PROPOSER_MAX,
  KB_PENDING_PROPOSALS_MAX,
  KB_PENDING_TTL_MS,
  KB_PROPOSAL_FILE_MAX_BYTES,
  KB_PROPOSAL_SUFFIX,
  KB_QUOTA_AUDIT_REASON,
  KB_QUOTA_ENTRIES_REASON,
  KB_QUOTA_PENDING_REASON,
  KB_QUOTA_PROPOSER_REASON,
  KB_QUOTA_TOTAL_REASON,
  KB_SETTINGS_FILE_MAX_BYTES,
  KB_SHA256_PATTERN,
  KB_STALE_REASON,
  KB_STATE_REASON,
  KB_SWEEP_MIN_AGE_MS,
  KB_TAMPERED_REASON,
  KB_TERMINAL_PROPOSALS_MAX,
  KB_TITLE_CONFLICT_REASON,
  KB_TOO_LARGE_REASON,
  KB_TOTAL_CONTENT_MAX_BYTES,
  KB_UUID_PATTERN,
  KB_VOID_REASONS,
} from './constants.js';
import {
  type KbAuditActor,
  type KbAuditAppendHook,
  type KbAuditEvent,
  KbAuditLog,
  type KbAuditVerification,
  verifyAuditFiles,
} from './kbAudit.js';
import {
  assertKbPlatform,
  checkPrivateChain,
  ensureKbRoot,
  ensureWorkspaceDirs,
  errnoCode,
  fsyncDirectory,
  kbBoundary,
  type KbFailure,
  kbFailure,
  kbLog,
  KbOpError,
  KbPaths,
  type KbResult,
  parseJsonStrict,
  readBoundedFile,
  readDirectoryNames,
} from './kbFiles.js';
import { isValidKbId, isValidWorkspaceId, normalizeTitle, titleKeyFor } from './kbIds.js';
import { type KbLockOptions, KbWriterLock } from './kbLock.js';
import {
  checkContent,
  isHighImpact,
  isPendingState,
  isProposalState,
  type KbDecidedBy,
  type KbDecisionRequest,
  type KbProposal,
  KbProposalCache,
  type KbProposalKind,
  type KbProposalMeta,
  type KbProposalState,
  type KbProposer,
  parseProposal,
  parseProposer,
  planDecision,
  proposalDigest,
  proposalIntact,
  proposalMeta,
  proposerKeyFor,
  serializeProposal,
} from './kbProposals.js';
import { checkPrivateDirectory } from './privateStorage.js';
import { writeFileSecure } from './secureFileWrite.js';
import { decodeSafeText, isWellFormedText, sha256Hex } from './textSafety.js';

// ── Shapes ──────────────────────────────────────────────────

export interface KbSettings {
  kbEnabled: boolean;
  operatorConfirm: boolean;
}

/** Missing settings mean the safe values: KB off, operator confirmation on. */
export const KB_SAFE_SETTINGS: Readonly<KbSettings> = { kbEnabled: false, operatorConfirm: true };

const SETTINGS_KEYS: readonly string[] = ['version', 'kbEnabled', 'operatorConfirm'];
const SETTINGS_PATCH_KEYS: readonly string[] = ['kbEnabled', 'operatorConfirm'];

export interface KbIndexEntry {
  id: string;
  title: string;
  titleKey: string;
  blob: string;
  sha256: string;
  size: number;
  version: number;
  sourceProposalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface KbIndex {
  version: number;
  kbVersion: number;
  entries: KbIndexEntry[];
  applied: { proposalId: string; kbVersion: number }[];
}

export type KbEntryMeta = Omit<KbIndexEntry, 'titleKey' | 'blob'>;

export type KbCommitStep =
  | 'audit_started'
  | 'write_blob'
  | 'write_index'
  | 'update_proposal'
  | 'audit_done'
  | 'remove_old_blob';

/** Fault-injection seam for tests: a throw from a hook is that step failing.
 *  Production passes none. */
export interface KbStoreHooks {
  commitStep?: (step: KbCommitStep) => void;
  auditAppend?: KbAuditAppendHook;
}

export interface KbStoreOptions {
  paths?: KbPaths;
  lock?: KbLockOptions;
  now?: () => number;
  hooks?: KbStoreHooks;
}

const INDEX_KEYS: readonly string[] = ['version', 'kbVersion', 'entries', 'applied'];
const ENTRY_KEYS: readonly string[] = [
  'id',
  'title',
  'titleKey',
  'blob',
  'sha256',
  'size',
  'version',
  'sourceProposalId',
  'createdAt',
  'updatedAt',
];
const APPLIED_KEYS: readonly string[] = ['proposalId', 'kbVersion'];

const PROPOSAL_FILE_PATTERN = new RegExp(
  `^(${KB_UUID_PATTERN.source.slice(1, -1)})${KB_PROPOSAL_SUFFIX.replace('.', '\\.')}$`,
);
const BLOB_FILE_PATTERN = new RegExp(
  `^(${KB_UUID_PATTERN.source.slice(1, -1)})${KB_BLOB_SUFFIX.replace('.', '\\.')}$`,
);
/** writeFileSecure's staging name for a blob: <uuid>.md.<pid>.<uuid>.tmp. */
const BLOB_TMP_PATTERN = new RegExp(
  `^${KB_UUID_PATTERN.source.slice(1, -1)}${KB_BLOB_SUFFIX.replace('.', '\\.')}\\.[0-9]{1,10}\\.${KB_UUID_PATTERN.source.slice(1, -1)}\\.tmp$`,
);

function fail(code: KbFailure['code'], reason: string): never {
  throw new KbOpError(code, reason);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

// ── Index parsing ───────────────────────────────────────────

function parseIndexEntry(raw: unknown): KbIndexEntry | null {
  if (!isPlainObject(raw) || Object.keys(raw).length !== ENTRY_KEYS.length) return null;
  if (!hasOnlyKeys(raw, ENTRY_KEYS)) return null;
  const {
    id,
    title,
    titleKey,
    blob,
    sha256,
    size,
    version,
    sourceProposalId,
    createdAt,
    updatedAt,
  } = raw;
  if (!isValidKbId(id) || !isValidKbId(blob) || !isValidKbId(sourceProposalId)) return null;
  if (typeof sha256 !== 'string' || !KB_SHA256_PATTERN.test(sha256)) return null;
  if (!isCount(size, 0, KB_ENTRY_CONTENT_MAX_BYTES)) return null;
  if (!isCount(version, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isIsoTimestamp(createdAt) || !isIsoTimestamp(updatedAt)) return null;
  const normalized = normalizeTitle(title);
  if (!normalized || normalized.title !== title || titleKey !== normalized.titleKey) return null;
  return {
    id,
    title,
    titleKey,
    blob,
    sha256,
    size,
    version,
    sourceProposalId,
    createdAt,
    updatedAt,
  };
}

/** The index in `raw`, or null for anything malformed: a wrong shape, a non-UUID
 *  id or blob, a duplicate id, blob reference or titleKey, or a size, count or
 *  total over the limits. */
export function parseIndex(raw: unknown): KbIndex | null {
  if (!isPlainObject(raw) || Object.keys(raw).length !== INDEX_KEYS.length) return null;
  if (!hasOnlyKeys(raw, INDEX_KEYS)) return null;
  if (raw.version !== KB_FILE_FORMAT_VERSION) return null;
  if (!isCount(raw.kbVersion, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(raw.entries) || raw.entries.length > KB_ENTRIES_MAX) return null;
  if (!Array.isArray(raw.applied) || raw.applied.length > KB_APPLIED_RING_MAX) return null;
  const entries: KbIndexEntry[] = [];
  const ids = new Set<string>();
  const blobs = new Set<string>();
  const titleKeys = new Set<string>();
  let total = 0;
  for (const item of raw.entries) {
    const entry = parseIndexEntry(item);
    if (!entry || ids.has(entry.id) || blobs.has(entry.blob) || titleKeys.has(entry.titleKey)) {
      return null;
    }
    ids.add(entry.id);
    blobs.add(entry.blob);
    titleKeys.add(entry.titleKey);
    total += entry.size;
    entries.push(entry);
  }
  if (total > KB_TOTAL_CONTENT_MAX_BYTES) return null;
  const applied: KbIndex['applied'] = [];
  const appliedIds = new Set<string>();
  for (const item of raw.applied) {
    if (!isPlainObject(item) || Object.keys(item).length !== APPLIED_KEYS.length) return null;
    if (!hasOnlyKeys(item, APPLIED_KEYS)) return null;
    const { proposalId, kbVersion } = item;
    if (!isValidKbId(proposalId) || appliedIds.has(proposalId)) return null;
    if (!isCount(kbVersion, 1, Number.MAX_SAFE_INTEGER)) return null;
    appliedIds.add(proposalId);
    applied.push({ proposalId, kbVersion });
  }
  return { version: KB_FILE_FORMAT_VERSION, kbVersion: raw.kbVersion, entries, applied };
}

function emptyIndex(): KbIndex {
  return { version: KB_FILE_FORMAT_VERSION, kbVersion: 0, entries: [], applied: [] };
}

function serializeIndex(index: KbIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function entryMeta(entry: KbIndexEntry): KbEntryMeta {
  return {
    id: entry.id,
    title: entry.title,
    sha256: entry.sha256,
    size: entry.size,
    version: entry.version,
    sourceProposalId: entry.sourceProposalId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// ── Settings parsing ────────────────────────────────────────

type SettingsRead = { state: 'ok' | 'absent' | 'corrupt'; settings: KbSettings };

function parseSettings(raw: unknown): KbSettings | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, SETTINGS_KEYS)) return null;
  if (raw.version !== undefined && raw.version !== KB_FILE_FORMAT_VERSION) return null;
  const { kbEnabled, operatorConfirm } = raw;
  if (kbEnabled !== undefined && typeof kbEnabled !== 'boolean') return null;
  if (operatorConfirm !== undefined && typeof operatorConfirm !== 'boolean') return null;
  return {
    kbEnabled: kbEnabled ?? KB_SAFE_SETTINGS.kbEnabled,
    operatorConfirm: operatorConfirm ?? KB_SAFE_SETTINGS.operatorConfirm,
  };
}

// ── Workspace context ───────────────────────────────────────

interface WorkspaceContext {
  ws: string;
  queue: Promise<unknown>;
  audit: KbAuditLog;
  cache: KbProposalCache | null;
  /** Blobs whose tampering this process already recorded in the audit log. */
  tamperedRecorded: Set<string>;
}

const COMMIT_EVENT: Record<KbProposalKind, KbAuditEvent> = {
  create: 'entry_created',
  replace: 'entry_replaced',
  delete: 'entry_deleted',
};

const TRANSITION_EVENT: Partial<Record<KbProposalState, KbAuditEvent>> = {
  pending_operator: 'proposal_pending_operator',
  rejected: 'proposal_rejected',
  stale: 'proposal_stale',
  voided: 'proposal_voided',
  expired: 'proposal_expired',
};

function agentActor(actor: KbProposer): KbAuditActor {
  return {
    kind: 'agent',
    instance: actor.instance,
    agentId: actor.agentId,
    sessionId: actor.sessionId,
    serial: actor.serial,
  };
}

const SYSTEM_ACTOR: KbAuditActor = { kind: 'system' };
const OPERATOR_ACTOR: KbAuditActor = { kind: 'operator' };

export interface KbDecisionResult {
  state: KbProposalState;
  repeated?: true;
  kbVersion?: number;
}

// ── The store ───────────────────────────────────────────────

export class KbStore {
  readonly paths: KbPaths;
  private readonly lock: KbWriterLock;
  private readonly now: () => number;
  private readonly hooks: KbStoreHooks;
  private readonly workspaces = new Map<string, WorkspaceContext>();

  constructor(options: KbStoreOptions = {}) {
    this.paths = options.paths ?? KbPaths.forHome();
    this.lock = new KbWriterLock(this.paths.root, options.lock);
    this.now = options.now ?? Date.now;
    this.hooks = options.hooks ?? {};
  }

  // ── Plumbing ──────────────────────────────────────────────

  private context(ws: string): WorkspaceContext {
    let ctx = this.workspaces.get(ws);
    if (!ctx) {
      ctx = {
        ws,
        queue: Promise.resolve(),
        audit: new KbAuditLog(this.paths, ws, this.now, this.hooks.auditAppend),
        cache: null,
        tamperedRecorded: new Set(),
      };
      this.workspaces.set(ws, ctx);
    }
    return ctx;
  }

  /** Forget every cached view (another writer may have changed the disk). */
  private invalidateAll(): void {
    for (const ctx of this.workspaces.values()) {
      ctx.cache = null;
      ctx.audit.invalidate();
    }
  }

  /** Run `task` on the workspace queue at the public boundary. */
  private run<T extends object>(
    operation: string,
    ws: unknown,
    task: (ctx: WorkspaceContext) => Promise<KbResult<T>>,
  ): Promise<KbResult<T>> {
    if (!isValidWorkspaceId(ws)) {
      return Promise.resolve(kbFailure('invalid', KB_INVALID_ID_REASON));
    }
    const ctx = this.context(ws);
    const job = () => kbBoundary(operation, ws, () => task(ctx));
    const result = ctx.queue.then(job, job);
    ctx.queue = result.catch(() => undefined);
    return result;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Whether this process may write right now (held and still the highest
   *  generation). Never acquires. */
  private async writable(): Promise<boolean> {
    if (!this.lock.held) return false;
    if (await this.lock.verifyHeld()) return true;
    this.invalidateAll();
    return false;
  }

  /** Before a mutation's first change: the lock (acquired on first use and
   *  re-verified now), the workspace directories, an index file to commit
   *  against, and room in the audit log. */
  private async beginMutation(
    ctx: WorkspaceContext,
    options: { auditQuota: boolean },
  ): Promise<void> {
    assertKbPlatform();
    await ensureKbRoot(this.paths);
    const wasHeld = this.lock.held;
    if ((await this.lock.acquire()) !== 'held') fail('locked', KB_LOCKED_REASON);
    if (!wasHeld) this.invalidateAll();
    if (!(await this.writable())) fail('locked', KB_LOCKED_REASON);
    await ensureWorkspaceDirs(this.paths, ctx.ws);
    await this.ensureInitialIndex(ctx.ws);
    if (options.auditQuota && (await ctx.audit.overQuota())) fail('quota', KB_QUOTA_AUDIT_REASON);
  }

  /** A fresh workspace gets an empty index before its first blob, so a crash
   *  during its first commit leaves an orphan blob, never a missing index. An
   *  absent index next to existing blobs is left absent (corrupt_index). */
  private async ensureInitialIndex(ws: string): Promise<void> {
    const read = await readBoundedFile(this.paths.indexFile(ws), KB_INDEX_FILE_MAX_BYTES);
    if (read.state !== 'absent') return;
    if ((await readDirectoryNames(this.paths.blobsDir(ws))).length > 0) return;
    await writeFileSecure(this.paths.indexFile(ws), serializeIndex(emptyIndex()));
    await fsyncDirectory(this.paths.workspaceDir(ws), [ws]);
  }

  /** For reads: 'absent' when the KB root or the workspace does not exist yet.
   *  Every level that exists must be private (blobs/ and proposals/ too). */
  private async beginRead(ws: string): Promise<'ok' | 'absent'> {
    assertKbPlatform();
    if ((await checkPrivateChain([this.paths.root, this.paths.workspaceDir(ws)])) === 'absent') {
      return 'absent';
    }
    await checkPrivateDirectory(this.paths.blobsDir(ws));
    await checkPrivateDirectory(this.paths.proposalsDir(ws));
    return 'ok';
  }

  // ── Index and settings files ──────────────────────────────

  private async readIndex(ws: string): Promise<KbIndex | 'corrupt'> {
    const read = await readBoundedFile(this.paths.indexFile(ws), KB_INDEX_FILE_MAX_BYTES);
    if (read.state === 'absent') {
      const blobs = await readDirectoryNames(this.paths.blobsDir(ws));
      return blobs.length === 0 ? emptyIndex() : 'corrupt';
    }
    if (read.state === 'error') fail('io', KB_IO_REASON);
    if (read.state === 'too_large') fail('too_large', KB_TOO_LARGE_REASON);
    if (read.state !== 'ok') return 'corrupt';
    return parseIndex(parseJsonStrict(read.bytes)) ?? 'corrupt';
  }

  private async requireIndex(ws: string): Promise<KbIndex> {
    const index = await this.readIndex(ws);
    if (index === 'corrupt') {
      kbLog('the index is unreadable or malformed; left untouched', { ids: [ws] });
      fail('corrupt_index', KB_CORRUPT_INDEX_REASON);
    }
    return index;
  }

  private async readSettingsFile(ws: string): Promise<SettingsRead> {
    const read = await readBoundedFile(this.paths.settingsFile(ws), KB_SETTINGS_FILE_MAX_BYTES);
    if (read.state === 'absent') return { state: 'absent', settings: { ...KB_SAFE_SETTINGS } };
    if (read.state === 'error') fail('io', KB_IO_REASON);
    const settings = read.state === 'ok' ? parseSettings(parseJsonStrict(read.bytes)) : null;
    if (!settings) {
      kbLog('settings.json is unreadable or malformed; safe values apply', { ids: [ws] });
      return { state: 'corrupt', settings: { ...KB_SAFE_SETTINGS } };
    }
    return { state: 'ok', settings };
  }

  // ── Proposal files ────────────────────────────────────────

  /** One proposal file, strictly. not_found / tampered (not a plain file, or
   *  malformed) / too_large. */
  private async readProposalFile(ws: string, id: string): Promise<KbProposal> {
    const read = await readBoundedFile(this.paths.proposalFile(ws, id), KB_PROPOSAL_FILE_MAX_BYTES);
    if (read.state === 'absent') fail('not_found', KB_NOT_FOUND_REASON);
    if (read.state === 'too_large') fail('too_large', KB_TOO_LARGE_REASON);
    if (read.state === 'error') fail('io', KB_IO_REASON);
    const proposal =
      read.state === 'ok' ? parseProposal(parseJsonStrict(read.bytes), id, ws) : null;
    if (!proposal) {
      kbLog('a proposal file is malformed or not a plain file', { ids: [ws, id] });
      fail('tampered', KB_TAMPERED_REASON);
    }
    return proposal;
  }

  private async writeProposalFile(ctx: WorkspaceContext, proposal: KbProposal): Promise<void> {
    const data = serializeProposal(proposal);
    if (Buffer.byteLength(data, 'utf-8') > KB_PROPOSAL_FILE_MAX_BYTES) {
      fail('too_large', KB_TOO_LARGE_REASON);
    }
    await writeFileSecure(this.paths.proposalFile(ctx.ws, proposal.id), data);
    ctx.cache?.track(proposal);
  }

  /** Scan proposals/ once: pending ids (reconciled against `applied` first) and
   *  terminal ids. Runs under the lock. */
  private async loadCache(ctx: WorkspaceContext, index: KbIndex): Promise<KbProposalCache> {
    if (ctx.cache) return ctx.cache;
    const cache = new KbProposalCache();
    // Installed first because reconciling writes proposal files that track
    // themselves into ctx.cache; removed again if the scan does not finish, so
    // an incomplete cache (which would under-count the quotas and hide pending
    // proposals from reconciliation) is never kept: the next call scans again.
    ctx.cache = cache;
    try {
      for (const name of await readDirectoryNames(this.paths.proposalsDir(ctx.ws))) {
        const match = PROPOSAL_FILE_PATTERN.exec(name);
        if (!match) continue;
        let proposal: KbProposal;
        try {
          proposal = await this.readProposalFile(ctx.ws, match[1]);
        } catch (err) {
          if (!(err instanceof KbOpError)) throw err;
          continue;
        }
        cache.track(proposal);
        await this.reconcileProposal(ctx, proposal, index);
      }
    } catch (err) {
      ctx.cache = null;
      throw err;
    }
    return cache;
  }

  // ── Reconciliation ────────────────────────────────────────

  /**
   * The one reconciliation: a pending or pending_operator proposal whose id is in
   * index.applied was committed -- make it approved (content dropped) and record
   * commit_done (reason `reconciled`). Returns the effective proposal; when the
   * file write fails it is still approved in effect (the index says so), and the
   * next pass retries. Only call with the lock held.
   */
  private async reconcileProposal(
    ctx: WorkspaceContext,
    proposal: KbProposal,
    index: KbIndex,
  ): Promise<KbProposal> {
    if (!isPendingState(proposal.state)) return proposal;
    if (!index.applied.some((item) => item.proposalId === proposal.id)) return proposal;
    const approved = this.finalized(proposal, 'approved', 'system');
    try {
      await this.writeProposalFile(ctx, approved);
    } catch (err) {
      // Still pending on disk: keep it pending in the cache, so the scan before
      // every commit retries it (and the ring never drops it meanwhile).
      ctx.cache?.track(proposal);
      kbLog('a committed proposal could not be marked approved', {
        errno: errnoCode(err),
        ids: [ctx.ws, proposal.id],
      });
    }
    const entryId =
      proposal.kind === 'delete'
        ? proposal.targetEntryId
        : index.entries.find((entry) => entry.sourceProposalId === proposal.id)?.id;
    try {
      await ctx.audit.append([
        {
          event: 'commit_done',
          actor: SYSTEM_ACTOR,
          proposalId: proposal.id,
          entryId,
          detail: { kind: proposal.kind, digest: proposal.digest, reason: 'reconciled' },
        },
      ]);
    } catch (err) {
      kbLog('the reconciled commit_done could not be audited', {
        errno: errnoCode(err),
        ids: [ctx.ws, proposal.id],
      });
    }
    return approved;
  }

  /** Reconcile every cached pending id that `applied` holds. */
  private async reconcileApplied(ctx: WorkspaceContext, index: KbIndex): Promise<void> {
    const cache = await this.loadCache(ctx, index);
    const applied = new Set(index.applied.map((item) => item.proposalId));
    for (const id of [...cache.pending.keys()]) {
      if (!applied.has(id)) continue;
      try {
        await this.reconcileProposal(ctx, await this.readProposalFile(ctx.ws, id), index);
      } catch (err) {
        if (!(err instanceof KbOpError)) throw err;
        kbLog('a committed proposal could not be read for reconciliation', { ids: [ctx.ws, id] });
      }
    }
  }

  // ── Transitions ───────────────────────────────────────────

  private finalized(proposal: KbProposal, state: KbProposalState, by: KbDecidedBy): KbProposal {
    const next: KbProposal = { ...proposal, state };
    if (!isPendingState(state)) {
      delete next.content;
      next.decidedAt = this.nowIso();
      next.decidedBy = by;
    }
    return next;
  }

  /** A non-commit transition: audited first (a failed audit changes nothing),
   *  then written. */
  private async transition(
    ctx: WorkspaceContext,
    proposal: KbProposal,
    state: KbProposalState,
    actor: KbAuditActor,
    reason?: string,
  ): Promise<KbProposal> {
    const event = TRANSITION_EVENT[state];
    if (!event) throw new KbOpError('io', KB_IO_REASON);
    await ctx.audit.append([
      {
        event,
        actor,
        proposalId: proposal.id,
        entryId: proposal.targetEntryId,
        detail: { kind: proposal.kind, digest: proposal.digest, reason },
      },
    ]);
    const next = this.finalized(proposal, state, actor.kind);
    await this.writeProposalFile(ctx, next);
    await this.pruneTerminal(ctx);
    return next;
  }

  /** Keep at most KB_TERMINAL_PROPOSALS_MAX terminal files: the oldest decided
   *  go first. Pending files are never touched; the audit keeps every record. */
  private async pruneTerminal(ctx: WorkspaceContext): Promise<void> {
    const cache = ctx.cache;
    if (!cache) return;
    while (cache.terminal.size > KB_TERMINAL_PROPOSALS_MAX) {
      const oldest = cache.oldestTerminal();
      if (!oldest) return;
      cache.forget(oldest);
      try {
        const proposal = await this.readProposalFile(ctx.ws, oldest);
        if (isPendingState(proposal.state)) {
          cache.track(proposal);
          continue;
        }
        await fs.promises.unlink(this.paths.proposalFile(ctx.ws, oldest));
      } catch (err) {
        kbLog('an old decided proposal could not be removed', {
          errno: err instanceof KbOpError ? err.code : errnoCode(err),
          ids: [ctx.ws, oldest],
        });
      }
    }
  }

  /** Expire pending proposals past the TTL (reconciled first). */
  private async expireOld(ctx: WorkspaceContext, index: KbIndex): Promise<void> {
    const cache = await this.loadCache(ctx, index);
    const cutoff = this.now() - KB_PENDING_TTL_MS;
    for (const [id, item] of [...cache.pending]) {
      if (item.createdAtMs >= cutoff) continue;
      let proposal: KbProposal;
      try {
        proposal = await this.readProposalFile(ctx.ws, id);
      } catch (err) {
        if (!(err instanceof KbOpError)) throw err;
        continue;
      }
      proposal = await this.reconcileProposal(ctx, proposal, index);
      if (isPendingState(proposal.state)) {
        await this.transition(ctx, proposal, 'expired', SYSTEM_ACTOR, 'ttl');
      }
    }
  }

  // ── Settings ──────────────────────────────────────────────

  /** Never creates anything. Absent or malformed settings read as the safe values
   *  (state 'absent' / 'corrupt'). */
  readSettings(
    ws: unknown,
  ): Promise<KbResult<{ settings: KbSettings; state: SettingsRead['state'] }>> {
    return this.run('readSettings', ws, async (ctx) => {
      if ((await this.beginRead(ctx.ws)) === 'absent') {
        return { ok: true, settings: { ...KB_SAFE_SETTINGS }, state: 'absent' };
      }
      const read = await this.readSettingsFile(ctx.ws);
      return { ok: true, settings: read.settings, state: read.state };
    });
  }

  /** Change kbEnabled / operatorConfirm (booleans only). A malformed file is
   *  never overwritten; a failed audit refuses the change. */
  writeSettings(ws: unknown, patch: unknown): Promise<KbResult<{ settings: KbSettings }>> {
    return this.run('writeSettings', ws, async (ctx) => {
      if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      for (const [key, value] of Object.entries(patch)) {
        if (!SETTINGS_PATCH_KEYS.includes(key) || typeof value !== 'boolean') {
          return kbFailure('invalid', KB_INVALID_INPUT_REASON);
        }
      }
      await this.beginMutation(ctx, { auditQuota: true });
      const current = await this.readSettingsFile(ctx.ws);
      if (current.state === 'corrupt')
        return kbFailure('corrupt_settings', KB_CORRUPT_SETTINGS_REASON);
      const settings: KbSettings = { ...current.settings, ...(patch as Partial<KbSettings>) };
      await ctx.audit.append([
        {
          event: 'settings_changed',
          actor: OPERATOR_ACTOR,
          detail: {
            reason: `kbEnabled=${settings.kbEnabled},operatorConfirm=${settings.operatorConfirm}`,
          },
        },
      ]);
      await writeFileSecure(
        this.paths.settingsFile(ctx.ws),
        `${JSON.stringify({ version: KB_FILE_FORMAT_VERSION, ...settings }, null, 2)}\n`,
      );
      return { ok: true, settings };
    });
  }

  // ── Entries ───────────────────────────────────────────────

  listEntries(ws: unknown): Promise<KbResult<{ kbVersion: number; entries: KbEntryMeta[] }>> {
    return this.run('listEntries', ws, async (ctx) => {
      if ((await this.beginRead(ctx.ws)) === 'absent')
        return { ok: true, kbVersion: 0, entries: [] };
      const index = await this.requireIndex(ctx.ws);
      return { ok: true, kbVersion: index.kbVersion, entries: index.entries.map(entryMeta) };
    });
  }

  /** One entry's content, verified against the index's sha256. A mismatch (or a
   *  blob that is missing, not a plain file, or the wrong size) is `tampered`
   *  with no content; it is audited once per blob, and only while this process
   *  holds the lock. */
  readEntry(
    ws: unknown,
    entryId: unknown,
  ): Promise<KbResult<{ entry: KbEntryMeta; content: string }>> {
    return this.run('readEntry', ws, async (ctx) => {
      if (!isValidKbId(entryId)) return kbFailure('invalid', KB_INVALID_ID_REASON);
      if ((await this.beginRead(ctx.ws)) === 'absent')
        return kbFailure('not_found', KB_NOT_FOUND_REASON);
      const index = await this.requireIndex(ctx.ws);
      const entry = index.entries.find((item) => item.id === entryId);
      if (!entry) return kbFailure('not_found', KB_NOT_FOUND_REASON);
      const read = await readBoundedFile(this.paths.blobFile(ctx.ws, entry.blob), entry.size);
      if (read.state === 'error') fail('io', KB_IO_REASON);
      const text =
        read.state === 'ok' && sha256Hex(read.bytes) === entry.sha256
          ? decodeSafeText(read.bytes)
          : null;
      if (text === null) {
        await this.recordTampered(ctx, entry);
        return kbFailure('tampered', KB_TAMPERED_REASON);
      }
      return { ok: true, entry: entryMeta(entry), content: text };
    });
  }

  private async recordTampered(ctx: WorkspaceContext, entry: KbIndexEntry): Promise<void> {
    kbLog('an entry blob does not match the index', { ids: [ctx.ws, entry.id] });
    if (ctx.tamperedRecorded.has(entry.blob)) return;
    if (!(await this.writable())) return;
    try {
      await ctx.audit.append([
        {
          event: 'tampered',
          actor: SYSTEM_ACTOR,
          entryId: entry.id,
          detail: { sha256: entry.sha256, size: entry.size, reason: 'blob_mismatch' },
        },
      ]);
      ctx.tamperedRecorded.add(entry.blob);
    } catch (err) {
      kbLog('tampering could not be audited', { errno: errnoCode(err), ids: [ctx.ws, entry.id] });
    }
  }

  // ── Proposals ─────────────────────────────────────────────

  /** Submit a create, replace or delete. Checked inside the queue against the
   *  current index: title and content rules, title uniqueness, the target and its
   *  base, and the pending quotas (after lazily expiring old proposals). */
  submitProposal(ws: unknown, input: unknown): Promise<KbResult<{ proposal: KbProposalMeta }>> {
    return this.run('submitProposal', ws, async (ctx) => {
      if (!isPlainObject(input)) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      const { kind, targetEntryId, title: rawTitle, content: rawContent } = input;
      if (kind !== 'create' && kind !== 'replace' && kind !== 'delete') {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      const proposer = parseProposer(input.proposer);
      if (!proposer) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      if (kind === 'create' ? targetEntryId !== undefined : !isValidKbId(targetEntryId)) {
        return kbFailure('invalid', KB_INVALID_ID_REASON);
      }
      let title: { title: string; titleKey: string } | undefined;
      if (rawTitle !== undefined || kind === 'create') {
        if (kind === 'delete') return kbFailure('invalid', KB_INVALID_INPUT_REASON);
        const normalized = normalizeTitle(rawTitle);
        if (!normalized) return kbFailure('invalid', KB_INVALID_TITLE_REASON);
        title = normalized;
      }
      let content: { bytes: Buffer; text: string } | undefined;
      if (kind === 'delete') {
        if (rawContent !== undefined) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      } else {
        if (typeof rawContent !== 'string') return kbFailure('invalid', KB_INVALID_CONTENT_REASON);
        const checked = checkContent(rawContent);
        if (checked === 'too_large') return kbFailure('too_large', KB_TOO_LARGE_REASON);
        if (checked === 'invalid') return kbFailure('invalid', KB_INVALID_CONTENT_REASON);
        content = checked;
      }

      await this.beginMutation(ctx, { auditQuota: true });
      const index = await this.requireIndex(ctx.ws);
      await this.expireOld(ctx, index);
      const cache = await this.loadCache(ctx, index);

      let base: { sha256: string; version: number } | undefined;
      if (kind === 'create') {
        if (index.entries.some((entry) => entry.titleKey === title?.titleKey)) {
          return kbFailure('conflict', KB_TITLE_CONFLICT_REASON);
        }
      } else {
        const target = index.entries.find((entry) => entry.id === targetEntryId);
        if (!target) return kbFailure('not_found', KB_NOT_FOUND_REASON);
        if (
          title &&
          index.entries.some((e) => e.id !== target.id && e.titleKey === title?.titleKey)
        ) {
          return kbFailure('conflict', KB_TITLE_CONFLICT_REASON);
        }
        base = { sha256: target.sha256, version: target.version };
      }
      if (cache.pending.size >= KB_PENDING_PROPOSALS_MAX) {
        return kbFailure('quota', KB_QUOTA_PENDING_REASON);
      }
      if (cache.pendingFor(proposerKeyFor(proposer)) >= KB_PENDING_PER_PROPOSER_MAX) {
        return kbFailure('quota', KB_QUOTA_PROPOSER_REASON);
      }

      const fields: Parameters<typeof proposalDigest>[0] = {
        kind,
        targetEntryId: kind === 'create' ? undefined : (targetEntryId as string),
        baseSha256: base?.sha256,
        baseVersion: base?.version,
        title: title?.title,
        contentSha256: content ? sha256Hex(content.bytes) : undefined,
      };
      const proposal: KbProposal = {
        version: KB_FILE_FORMAT_VERSION,
        id: crypto.randomUUID(),
        workspaceId: ctx.ws,
        ...fields,
        content: content?.text,
        proposer,
        state: 'pending',
        createdAt: this.nowIso(),
        digest: proposalDigest(fields),
      };
      await ctx.audit.append([
        {
          event: 'proposal_submitted',
          actor: agentActor(proposer),
          proposalId: proposal.id,
          entryId: proposal.targetEntryId,
          detail: {
            kind,
            digest: proposal.digest,
            sha256: proposal.contentSha256,
            size: content?.bytes.length,
          },
        },
      ]);
      await this.writeProposalFile(ctx, proposal);
      return { ok: true, proposal: proposalMeta(proposal) };
    });
  }

  /** A curator Agent's decision: approve (commit, or pending_operator when high
   *  impact and operator confirmation is on) or reject. */
  decideProposal(
    ws: unknown,
    proposalId: unknown,
    decision: unknown,
  ): Promise<KbResult<KbDecisionResult>> {
    return this.run('decideProposal', ws, async (ctx) => {
      if (!isPlainObject(decision)) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      const { action, digest } = decision;
      if (action !== 'approve' && action !== 'reject') {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      const actor = parseProposer(decision.actor);
      if (!actor) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      return this.decide(ctx, proposalId, digest, { by: 'agent', action }, agentActor(actor));
    });
  }

  /** The operator's decision: confirm a pending_operator proposal (commit), or
   *  reject a pending or pending_operator one. */
  operatorDecide(
    ws: unknown,
    proposalId: unknown,
    decision: unknown,
  ): Promise<KbResult<KbDecisionResult>> {
    return this.run('operatorDecide', ws, async (ctx) => {
      if (!isPlainObject(decision)) return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      const { action, digest } = decision;
      if (action !== 'confirm' && action !== 'reject') {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      return this.decide(ctx, proposalId, digest, { by: 'operator', action }, OPERATOR_ACTOR);
    });
  }

  private async decide(
    ctx: WorkspaceContext,
    proposalId: unknown,
    digest: unknown,
    request: KbDecisionRequest,
    actor: KbAuditActor,
  ): Promise<KbResult<KbDecisionResult>> {
    if (!isValidKbId(proposalId)) return kbFailure('invalid', KB_INVALID_ID_REASON);
    if (typeof digest !== 'string' || !KB_SHA256_PATTERN.test(digest)) {
      return kbFailure('invalid', KB_INVALID_INPUT_REASON);
    }
    await this.beginMutation(ctx, { auditQuota: true });
    const index = await this.requireIndex(ctx.ws);
    await this.loadCache(ctx, index);
    let proposal = await this.readProposalFile(ctx.ws, proposalId);
    if (!proposalIntact(proposal)) {
      kbLog('a proposal does not match its integrity data', { ids: [ctx.ws, proposalId] });
      return kbFailure('tampered', KB_TAMPERED_REASON);
    }
    proposal = await this.reconcileProposal(ctx, proposal, index);
    if (proposal.digest !== digest) return kbFailure('digest_mismatch', KB_DIGEST_MISMATCH_REASON);

    const contentBytes =
      proposal.content === undefined ? 0 : Buffer.byteLength(proposal.content, 'utf-8');
    const settings = (await this.readSettingsFile(ctx.ws)).settings;
    const needsOperator = isHighImpact(proposal, contentBytes) && settings.operatorConfirm;
    const plan = planDecision(proposal.state, request, needsOperator);
    if (plan === 'repeated') return { ok: true, state: proposal.state, repeated: true };
    if (plan === 'state') return kbFailure('state', KB_STATE_REASON);
    if (plan === 'rejected') {
      const next = await this.transition(ctx, proposal, 'rejected', actor);
      return { ok: true, state: next.state };
    }
    if (!this.baseMatches(proposal, index)) {
      await this.transition(ctx, proposal, 'stale', SYSTEM_ACTOR, 'base_changed');
      return kbFailure('stale', KB_STALE_REASON);
    }
    if (plan === 'pending_operator') {
      const next = await this.transition(ctx, proposal, 'pending_operator', actor);
      return { ok: true, state: next.state };
    }
    const kbVersion = await this.commitProposal(ctx, proposal, index, actor);
    return { ok: true, state: 'approved', kbVersion };
  }

  /** A replace or delete still targets the very entry it was made against. */
  private baseMatches(proposal: KbProposal, index: KbIndex): boolean {
    if (proposal.kind === 'create') return true;
    const target = index.entries.find((entry) => entry.id === proposal.targetEntryId);
    return (
      !!target && target.sha256 === proposal.baseSha256 && target.version === proposal.baseVersion
    );
  }

  /** The commit sequence (see the file comment). Returns the new kbVersion. */
  private async commitProposal(
    ctx: WorkspaceContext,
    proposal: KbProposal,
    indexBefore: KbIndex,
    actor: KbAuditActor,
  ): Promise<number> {
    await this.reconcileApplied(ctx, indexBefore);
    const index = indexBefore;
    const dropped =
      index.applied.length >= KB_APPLIED_RING_MAX ? index.applied[0].proposalId : undefined;
    if (dropped !== undefined && ctx.cache?.pending.has(dropped)) {
      // Its reconciliation could not be written: dropping it from the ring now
      // would let it be committed twice. Refuse until it is approved on disk.
      kbLog('a commit waits for an earlier proposal to be marked approved', {
        ids: [ctx.ws, dropped],
      });
      fail('io', KB_IO_REASON);
    }
    const at = this.nowIso();
    const content =
      proposal.content === undefined ? undefined : Buffer.from(proposal.content, 'utf-8');
    if (content && content.length > KB_ENTRY_CONTENT_MAX_BYTES)
      fail('too_large', KB_TOO_LARGE_REASON);
    const target = index.entries.find((entry) => entry.id === proposal.targetEntryId);
    if (proposal.kind !== 'create' && !target) fail('stale', KB_STALE_REASON);
    const newTitle = proposal.title ?? target?.title;
    const newTitleKey = newTitle === undefined ? undefined : titleKeyFor(newTitle);
    if (
      newTitleKey !== undefined &&
      index.entries.some((entry) => entry.id !== target?.id && entry.titleKey === newTitleKey)
    ) {
      fail('conflict', KB_TITLE_CONFLICT_REASON);
    }
    if (proposal.kind === 'create' && index.entries.length >= KB_ENTRIES_MAX) {
      fail('quota', KB_QUOTA_ENTRIES_REASON);
    }
    const totalBefore = index.entries.reduce((sum, entry) => sum + entry.size, 0);
    const totalAfter = totalBefore - (target?.size ?? 0) + (content?.length ?? 0);
    if (totalAfter > KB_TOTAL_CONTENT_MAX_BYTES) fail('quota', KB_QUOTA_TOTAL_REASON);

    let entries: KbIndexEntry[];
    let changed: KbIndexEntry | undefined;
    const blobId = content ? crypto.randomUUID() : undefined;
    if (proposal.kind === 'create') {
      changed = {
        id: crypto.randomUUID(),
        title: newTitle as string,
        titleKey: newTitleKey as string,
        blob: blobId as string,
        sha256: proposal.contentSha256 as string,
        size: (content as Buffer).length,
        version: 1,
        sourceProposalId: proposal.id,
        createdAt: at,
        updatedAt: at,
      };
      entries = [...index.entries, changed];
    } else if (proposal.kind === 'replace' && target) {
      changed = {
        ...target,
        title: newTitle as string,
        titleKey: newTitleKey as string,
        blob: blobId as string,
        sha256: proposal.contentSha256 as string,
        size: (content as Buffer).length,
        version: target.version + 1,
        sourceProposalId: proposal.id,
        updatedAt: at,
      };
      entries = index.entries.map((entry) =>
        entry.id === target.id ? (changed as KbIndexEntry) : entry,
      );
    } else {
      entries = index.entries.filter((entry) => entry.id !== target?.id);
    }
    const kbVersion = index.kbVersion + 1;
    const applied = [...index.applied, { proposalId: proposal.id, kbVersion }].slice(
      -KB_APPLIED_RING_MAX,
    );
    const nextIndex: KbIndex = { version: KB_FILE_FORMAT_VERSION, kbVersion, entries, applied };
    const indexData = serializeIndex(nextIndex);
    if (Buffer.byteLength(indexData, 'utf-8') > KB_INDEX_FILE_MAX_BYTES) {
      fail('too_large', KB_TOO_LARGE_REASON);
    }
    const entryId = changed?.id ?? target?.id;
    const ids = [ctx.ws, proposal.id];

    // 1. commit_started: nothing has changed yet, so a failure aborts cleanly.
    this.hooks.commitStep?.('audit_started');
    await ctx.audit.append([
      {
        event: 'commit_started',
        actor,
        proposalId: proposal.id,
        entryId,
        detail: {
          kind: proposal.kind,
          digest: proposal.digest,
          sha256: changed?.sha256,
          size: changed?.size,
          oldSha256: target?.sha256,
          oldSize: target?.size,
        },
      },
    ]);
    // 2. The new blob, made durable before anything points at it.
    if (content && blobId) {
      this.hooks.commitStep?.('write_blob');
      await writeFileSecure(this.paths.blobFile(ctx.ws, blobId), content);
      await fsyncDirectory(this.paths.blobsDir(ctx.ws), ids);
    }
    // 3. The commit point.
    this.hooks.commitStep?.('write_index');
    await writeFileSecure(this.paths.indexFile(ctx.ws), indexData);
    const indexDurable = await fsyncDirectory(this.paths.workspaceDir(ctx.ws), ids);

    // 4-6: the commit stands; failures from here on are only logged.
    let proposalUpdated = false;
    try {
      this.hooks.commitStep?.('update_proposal');
      await this.writeProposalFile(ctx, this.finalized(proposal, 'approved', actor.kind));
      proposalUpdated = true;
    } catch (err) {
      kbLog('a committed proposal could not be marked approved', { errno: errnoCode(err), ids });
    }
    try {
      this.hooks.commitStep?.('audit_done');
      await ctx.audit.append([
        {
          event: COMMIT_EVENT[proposal.kind],
          actor,
          proposalId: proposal.id,
          entryId,
          detail: {
            kind: proposal.kind,
            sha256: changed?.sha256,
            size: changed?.size,
            oldSha256: target?.sha256,
            oldSize: target?.size,
          },
        },
        {
          event: 'commit_done',
          actor,
          proposalId: proposal.id,
          entryId,
          detail: { kind: proposal.kind, digest: proposal.digest, reason: 'committed' },
        },
      ]);
    } catch (err) {
      kbLog('commit_done could not be audited', { errno: errnoCode(err), ids });
    }
    try {
      this.hooks.commitStep?.('remove_old_blob');
      const oldBlob = target?.blob;
      if (indexDurable && oldBlob && !entries.some((entry) => entry.blob === oldBlob)) {
        await fs.promises.unlink(this.paths.blobFile(ctx.ws, oldBlob));
      }
    } catch (err) {
      kbLog('a replaced blob could not be removed; it is left as an orphan', {
        errno: errnoCode(err),
        ids,
      });
    }
    if (proposalUpdated) await this.pruneTerminal(ctx);
    return kbVersion;
  }

  /** Void every pending and pending_operator proposal of a workspace (it is being
   *  removed, or its Agent is). Terminal proposals are left as they are. */
  voidWorkspaceProposals(ws: unknown, reason: unknown): Promise<KbResult<{ voided: number }>> {
    return this.run('voidWorkspaceProposals', ws, async (ctx) => {
      if (typeof reason !== 'string' || !KB_VOID_REASONS.includes(reason)) {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      if ((await this.beginRead(ctx.ws)) === 'absent') return { ok: true, voided: 0 };
      await this.beginMutation(ctx, { auditQuota: true });
      const index = await this.requireIndex(ctx.ws);
      const cache = await this.loadCache(ctx, index);
      let voided = 0;
      for (const id of [...cache.pending.keys()]) {
        let proposal: KbProposal;
        try {
          proposal = await this.readProposalFile(ctx.ws, id);
        } catch (err) {
          if (!(err instanceof KbOpError)) throw err;
          continue;
        }
        proposal = await this.reconcileProposal(ctx, proposal, index);
        if (!isPendingState(proposal.state)) continue;
        await this.transition(ctx, proposal, 'voided', SYSTEM_ACTOR, reason);
        voided++;
      }
      return { ok: true, voided };
    });
  }

  /** Proposal metadata (never content), optionally filtered. Pending proposals
   *  that were committed are reconciled first -- only while this process holds
   *  the lock; otherwise the result says reconciliationSkipped. */
  listProposals(
    ws: unknown,
    filter: unknown = {},
  ): Promise<KbResult<{ proposals: KbProposalMeta[]; reconciliationSkipped?: true }>> {
    return this.run('listProposals', ws, async (ctx) => {
      if (!isPlainObject(filter) || !hasOnlyKeys(filter, ['state', 'proposerKey'])) {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      const { state, proposerKey } = filter;
      if (state !== undefined && !isProposalState(state)) {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      if (
        proposerKey !== undefined &&
        (typeof proposerKey !== 'string' || !isWellFormedText(proposerKey))
      ) {
        return kbFailure('invalid', KB_INVALID_INPUT_REASON);
      }
      if ((await this.beginRead(ctx.ws)) === 'absent') return { ok: true, proposals: [] };
      const writable = await this.writable();
      const index = writable ? await this.requireIndex(ctx.ws) : null;
      const proposals: KbProposalMeta[] = [];
      for (const name of (await readDirectoryNames(this.paths.proposalsDir(ctx.ws))).sort()) {
        const match = PROPOSAL_FILE_PATTERN.exec(name);
        if (!match) continue;
        let proposal: KbProposal;
        try {
          proposal = await this.readProposalFile(ctx.ws, match[1]);
        } catch (err) {
          if (!(err instanceof KbOpError)) throw err;
          continue;
        }
        if (index) proposal = await this.reconcileProposal(ctx, proposal, index);
        if (state !== undefined && proposal.state !== state) continue;
        if (proposerKey !== undefined && proposerKeyFor(proposal.proposer) !== proposerKey)
          continue;
        proposals.push(proposalMeta(proposal));
      }
      return writable
        ? { ok: true, proposals }
        : { ok: true, proposals, reconciliationSkipped: true };
    });
  }

  /** One proposal, content included (reconciled first, as listProposals). */
  readProposal(
    ws: unknown,
    proposalId: unknown,
  ): Promise<KbResult<{ proposal: KbProposal; reconciliationSkipped?: true }>> {
    return this.run('readProposal', ws, async (ctx) => {
      if (!isValidKbId(proposalId)) return kbFailure('invalid', KB_INVALID_ID_REASON);
      if ((await this.beginRead(ctx.ws)) === 'absent')
        return kbFailure('not_found', KB_NOT_FOUND_REASON);
      let proposal = await this.readProposalFile(ctx.ws, proposalId);
      if (!(await this.writable())) return { ok: true, proposal, reconciliationSkipped: true };
      proposal = await this.reconcileProposal(ctx, proposal, await this.requireIndex(ctx.ws));
      return { ok: true, proposal };
    });
  }

  /** Remove blobs nothing references and staging files, both older than
   *  KB_SWEEP_MIN_AGE_MS. Only a healthy index allows it; only plain files with
   *  our own naming are touched. */
  sweepOrphanBlobs(ws: unknown): Promise<KbResult<{ removed: number }>> {
    return this.run('sweepOrphanBlobs', ws, async (ctx) => {
      if ((await this.beginRead(ctx.ws)) === 'absent') return { ok: true, removed: 0 };
      await this.beginMutation(ctx, { auditQuota: false });
      const index = await this.requireIndex(ctx.ws);
      const referenced = new Set(index.entries.map((entry) => entry.blob));
      const cutoff = this.now() - KB_SWEEP_MIN_AGE_MS;
      let removed = 0;
      for (const name of await readDirectoryNames(this.paths.blobsDir(ctx.ws))) {
        const blob = BLOB_FILE_PATTERN.exec(name);
        if (blob ? referenced.has(blob[1]) : !BLOB_TMP_PATTERN.test(name)) continue;
        const filePath = path.join(this.paths.blobsDir(ctx.ws), name);
        try {
          const stats = await fs.promises.lstat(filePath);
          if (!stats.isFile() || stats.mtimeMs > cutoff) continue;
          await fs.promises.unlink(filePath);
          removed++;
        } catch (err) {
          kbLog('an orphan blob could not be removed', { errno: errnoCode(err), ids: [ctx.ws] });
        }
      }
      return { ok: true, removed };
    });
  }

  /** Check the whole audit chain (rotated files included). Read-only. */
  verifyAudit(ws: unknown): Promise<KbResult<KbAuditVerification>> {
    return this.run('verifyAudit', ws, async (ctx) => {
      if ((await this.beginRead(ctx.ws)) === 'absent') return { ok: true, lines: 0 };
      return { ok: true, ...(await verifyAuditFiles(this.paths, ctx.ws)) };
    });
  }
}

const defaultStores = new Map<string, KbStore>();

/** The process's store for the current ~/.pixel-agents/kb (one per KB root). */
export function kbStore(): KbStore {
  const paths = KbPaths.forHome();
  let store = defaultStores.get(paths.root);
  if (!store) {
    store = new KbStore({ paths });
    defaultStores.set(paths.root, store);
  }
  return store;
}
