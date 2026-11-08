/**
 * Knowledge Base proposals: the file format, its integrity data, and the state
 * machine every decision is checked against. The orchestration (queue, lock,
 * commit, reconciliation) lives in kbStore.ts.
 *
 * proposals/<uuid>.json is read strictly: the id must equal the file name, the
 * workspaceId the directory, every field its shape. `digest` binds what a
 * reviewer saw -- sha256 of the canonical JSON of {kind, targetEntryId,
 * baseSha256, baseVersion, title, contentSha256}, absent fields omitted -- and is
 * recomputed (with contentSha256 from the content) before any decision. On
 * reaching a terminal state the content is dropped; only its hash stays.
 *
 * States: pending -> pending_operator | approved | rejected | stale | voided |
 * expired; pending_operator -> approved | rejected | stale | voided | expired.
 * approved, rejected, stale, voided and expired are terminal.
 */

import {
  KB_ENTRY_CONTENT_MAX_BYTES,
  KB_FILE_FORMAT_VERSION,
  KB_HIGH_IMPACT_CREATE_BYTES,
  KB_PROPOSER_STRING_MAX_LENGTH,
  KB_SHA256_PATTERN,
} from './constants.js';
import { canonicalJson } from './kbFiles.js';
import { isValidKbId, normalizeTitle } from './kbIds.js';
import { decodeSafeText, isWellFormedText, sha256Hex } from './textSafety.js';

export type KbProposalKind = 'create' | 'replace' | 'delete';
export type KbProposalState =
  'pending' | 'pending_operator' | 'approved' | 'rejected' | 'stale' | 'voided' | 'expired';
export type KbDecidedBy = 'agent' | 'operator' | 'system';

/** Who submitted (or, for a curator's decision, who decided). */
export interface KbProposer {
  instance: string;
  agentId: number;
  sessionId: string;
  serial: number;
}

export interface KbProposal {
  version: number;
  id: string;
  workspaceId: string;
  kind: KbProposalKind;
  targetEntryId?: string;
  baseSha256?: string;
  baseVersion?: number;
  title?: string;
  contentSha256?: string;
  content?: string;
  proposer: KbProposer;
  state: KbProposalState;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: KbDecidedBy;
  digest: string;
}

/** A proposal as listed: everything but the content. */
export type KbProposalMeta = Omit<KbProposal, 'content'>;

const KINDS: readonly string[] = ['create', 'replace', 'delete'];
const STATES: readonly string[] = [
  'pending',
  'pending_operator',
  'approved',
  'rejected',
  'stale',
  'voided',
  'expired',
];
const DECIDED_BY: readonly string[] = ['agent', 'operator', 'system'];
const PROPOSAL_KEYS: readonly string[] = [
  'version',
  'id',
  'workspaceId',
  'kind',
  'targetEntryId',
  'baseSha256',
  'baseVersion',
  'title',
  'contentSha256',
  'content',
  'proposer',
  'state',
  'createdAt',
  'decidedAt',
  'decidedBy',
  'digest',
];
const PROPOSER_KEYS: readonly string[] = ['instance', 'agentId', 'sessionId', 'serial'];

export function isProposalState(value: unknown): value is KbProposalState {
  return typeof value === 'string' && STATES.includes(value);
}

export function isPendingState(state: KbProposalState): boolean {
  return state === 'pending' || state === 'pending_operator';
}

export function proposerKeyFor(proposer: KbProposer): string {
  return `${proposer.instance}:${proposer.agentId}`;
}

/** sha256 of the canonical JSON of what a reviewer decides on. */
export function proposalDigest(fields: {
  kind: KbProposalKind;
  targetEntryId?: string;
  baseSha256?: string;
  baseVersion?: number;
  title?: string;
  contentSha256?: string;
}): string {
  return sha256Hex(
    Buffer.from(
      canonicalJson({
        kind: fields.kind,
        targetEntryId: fields.targetEntryId,
        baseSha256: fields.baseSha256,
        baseVersion: fields.baseVersion,
        title: fields.title,
        contentSha256: fields.contentSha256,
      }),
      'utf-8',
    ),
  );
}

/** Replace and delete always; a create when its content is past the threshold. */
export function isHighImpact(proposal: KbProposal, contentBytes: number): boolean {
  return proposal.kind !== 'create' || contentBytes > KB_HIGH_IMPACT_CREATE_BYTES;
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= KB_PROPOSER_STRING_MAX_LENGTH &&
    isWellFormedText(value)
  );
}

/** A proposer (or curator actor) record, or null: instance and sessionId
 *  non-empty strings of at most 128, agentId a positive safe integer, serial a
 *  non-negative safe integer, and no other key. */
export function parseProposer(raw: unknown): KbProposer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PROPOSER_KEYS.includes(key))) return null;
  const { instance, agentId, sessionId, serial } = record;
  if (!isBoundedString(instance) || !isBoundedString(sessionId)) return null;
  if (typeof agentId !== 'number' || !Number.isSafeInteger(agentId) || agentId <= 0) return null;
  if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < 0) return null;
  return { instance, agentId, sessionId, serial };
}

export type KbContentCheck = { bytes: Buffer; text: string } | 'invalid' | 'too_large';

/** Content rules: well-formed, at most KB_ENTRY_CONTENT_MAX_BYTES of UTF-8, and
 *  decodeSafeText-clean. Invisible-but-allowed characters (ZWSP, ZWJ, NBSP,
 *  U+2028, ...) pass: a display must escape them. */
export function checkContent(raw: unknown): KbContentCheck {
  let bytes: Buffer;
  if (typeof raw === 'string') {
    if (!isWellFormedText(raw)) return 'invalid';
    bytes = Buffer.from(raw, 'utf-8');
  } else if (Buffer.isBuffer(raw)) {
    bytes = raw;
  } else {
    return 'invalid';
  }
  if (bytes.length > KB_ENTRY_CONTENT_MAX_BYTES) return 'too_large';
  const text = decodeSafeText(bytes);
  if (text === null) return 'invalid';
  return { bytes, text };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && KB_SHA256_PATTERN.test(value);
}

function isStoredTitle(value: unknown): value is string {
  return normalizeTitle(value)?.title === value;
}

/**
 * The proposal in `raw`, or null when anything about it is off: an unknown key,
 * a wrong type, an id that is not the file's, a workspace that is not the
 * directory's, fields that do not fit the kind, content where the state has
 * none (or none where it must have one).
 */
export function parseProposal(raw: unknown, id: string, ws: string): KbProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PROPOSAL_KEYS.includes(key))) return null;
  const { version, kind, state, createdAt, decidedAt, decidedBy, digest } = record;
  if (version !== KB_FILE_FORMAT_VERSION || record.id !== id || !isValidKbId(id)) return null;
  if (record.workspaceId !== ws) return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (typeof state !== 'string' || !STATES.includes(state)) return null;
  if (!isIsoTimestamp(createdAt) || !isSha256(digest)) return null;
  const proposer = parseProposer(record.proposer);
  if (!proposer) return null;

  const terminal = !isPendingState(state as KbProposalState);
  if (terminal) {
    if (!isIsoTimestamp(decidedAt)) return null;
    if (typeof decidedBy !== 'string' || !DECIDED_BY.includes(decidedBy)) return null;
  } else if (decidedAt !== undefined || decidedBy !== undefined) {
    return null;
  }

  const { targetEntryId, baseSha256, baseVersion, title, contentSha256, content } = record;
  if (kind === 'create') {
    if (targetEntryId !== undefined || baseSha256 !== undefined || baseVersion !== undefined) {
      return null;
    }
    if (!isStoredTitle(title)) return null;
  } else {
    if (!isValidKbId(targetEntryId) || !isSha256(baseSha256)) return null;
    if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
      return null;
    }
    if (kind === 'replace' && title !== undefined && !isStoredTitle(title)) return null;
    if (kind === 'delete' && title !== undefined) return null;
  }
  if (kind === 'delete') {
    if (contentSha256 !== undefined || content !== undefined) return null;
  } else {
    if (!isSha256(contentSha256)) return null;
    if (terminal) {
      if (content !== undefined) return null;
    } else if (typeof checkContent(content) !== 'object') {
      return null;
    }
  }

  return {
    version: KB_FILE_FORMAT_VERSION,
    id,
    workspaceId: ws,
    kind: kind as KbProposalKind,
    targetEntryId: targetEntryId as string | undefined,
    baseSha256: baseSha256 as string | undefined,
    baseVersion: baseVersion as number | undefined,
    title: title as string | undefined,
    contentSha256: contentSha256 as string | undefined,
    content: content as string | undefined,
    proposer,
    state: state as KbProposalState,
    createdAt,
    decidedAt: decidedAt as string | undefined,
    decidedBy: decidedBy as KbDecidedBy | undefined,
    digest,
  };
}

/** Whether the stored integrity data still matches: the content hashes to
 *  contentSha256 (while there is content) and the fields hash to digest. */
export function proposalIntact(proposal: KbProposal): boolean {
  if (proposal.content !== undefined) {
    const actual = sha256Hex(Buffer.from(proposal.content, 'utf-8'));
    if (actual !== proposal.contentSha256) return false;
  }
  return proposalDigest(proposal) === proposal.digest;
}

export function serializeProposal(proposal: KbProposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

export function proposalMeta(proposal: KbProposal): KbProposalMeta {
  const { content: _content, ...meta } = proposal;
  void _content;
  return meta;
}

/** The decision requested: a curator Agent's approve/reject, or the operator's
 *  confirm/reject. */
export type KbDecisionRequest =
  { by: 'agent'; action: 'approve' | 'reject' } | { by: 'operator'; action: 'confirm' | 'reject' };

export type KbDecisionPlan = 'commit' | 'pending_operator' | 'rejected' | 'repeated' | 'state';

/**
 * The state machine. Terminal states answer a repeat of the transition that
 * reached them with `repeated`, anything else with `state`; a curator's approve
 * of a pending_operator proposal is always `state` (only the operator confirms).
 */
export function planDecision(
  state: KbProposalState,
  request: KbDecisionRequest,
  needsOperator: boolean,
): KbDecisionPlan {
  const approving =
    (request.by === 'agent' && request.action === 'approve') ||
    (request.by === 'operator' && request.action === 'confirm');
  switch (state) {
    case 'approved':
      return approving ? 'repeated' : 'state';
    case 'rejected':
      return request.action === 'reject' ? 'repeated' : 'state';
    case 'stale':
    case 'voided':
    case 'expired':
      return 'state';
    case 'pending':
      if (request.action === 'reject') return 'rejected';
      if (request.by === 'operator') return 'state';
      return needsOperator ? 'pending_operator' : 'commit';
    case 'pending_operator':
      if (request.action === 'reject') return 'rejected';
      return request.by === 'operator' ? 'commit' : 'state';
  }
}

/**
 * The in-memory view of one workspace's proposals, built by one scan on first
 * use and kept current inside the queue: pending ids (with proposer key and
 * creation time, for quotas and expiry) and terminal ids (with decision time,
 * for pruning the oldest).
 */
export class KbProposalCache {
  readonly pending = new Map<string, { proposerKey: string; createdAtMs: number }>();
  readonly terminal = new Map<string, number>();

  track(proposal: KbProposal): void {
    if (isPendingState(proposal.state)) {
      this.terminal.delete(proposal.id);
      this.pending.set(proposal.id, {
        proposerKey: proposerKeyFor(proposal.proposer),
        createdAtMs: Date.parse(proposal.createdAt),
      });
    } else {
      this.pending.delete(proposal.id);
      this.terminal.set(proposal.id, Date.parse(proposal.decidedAt ?? proposal.createdAt));
    }
  }

  forget(id: string): void {
    this.pending.delete(id);
    this.terminal.delete(id);
  }

  pendingFor(proposerKey: string): number {
    let count = 0;
    for (const item of this.pending.values()) {
      if (item.proposerKey === proposerKey) count++;
    }
    return count;
  }

  /** The terminal id decided longest ago. */
  oldestTerminal(): string | null {
    let oldest: { id: string; at: number } | null = null;
    for (const [id, at] of this.terminal) {
      if (!oldest || at < oldest.at) oldest = { id, at };
    }
    return oldest?.id ?? null;
  }
}
