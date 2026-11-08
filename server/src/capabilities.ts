/**
 * Capabilities: per-agent identity tokens Pixel Agents issues to the PTY agents
 * it launches (standalone only).
 *
 * A capability says "this caller is the agent the office launched as id N in
 * Workspace W". It guards against MISUSE, not against a hostile local user: an
 * agent running as the same OS user can read the server's environment, its
 * token file and other agents' capabilities, and can type into any terminal
 * through /terminal. It is not an isolation boundary.
 *
 * Rules this module enforces:
 * - the token is 32 random bytes (base64url, `pxa_kb_` prefix) and exists in
 *   exactly two places: the agent's PTY environment and the caller of issue().
 *   Memory holds only its sha256 digest. Neither the token nor the digest is
 *   ever put on AgentState, persisted, broadcast, logged or passed in argv;
 * - verify() re-checks the live facts every time, not just the digest: the
 *   agent is still in the MAIN store, its PTY session is still held, it is still
 *   in the Workspace the capability was issued for, and that Workspace still
 *   exists. The sessionId is recorded for audit only (/clear rewrites it);
 * - invalidation listens to the main store instance only. The sub-agent shadow
 *   store (subagentWatch.ts) is a different instance and never reaches here;
 * - an invalidated entry is deleted, so moving an agent back to its original
 *   Workspace never revives an old token.
 *
 * Known consequences: a launch issues nothing unless the caller injects
 * isKbEnabled (S2 never does, so production holds no capability); removing a
 * Workspace permanently revokes its PTY agents' capabilities; editing a
 * Workspace's Directories does not move running agents (so does not revoke);
 * the token is inherited by every descendant process of the agent's claude.
 */

import * as crypto from 'crypto';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CAPABILITY_BEARER_PREFIX,
  CAPABILITY_ENV_NAME,
  CAPABILITY_TOKEN_BYTES,
  CAPABILITY_TOKEN_PATTERN,
  CAPABILITY_TOKEN_PREFIX,
} from './constants.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import { listWorkspaces } from './workspaces.js';

/** What a valid capability proves. `sessionId` is the one at issue time. */
export interface CapabilityClaims {
  agentId: number;
  sessionId: string;
  /** Normalized Workspace id (the default is `DEFAULT_WORKSPACE_ID`). */
  workspaceId: string;
  /** Issue sequence number of this registry, independent of agent ids. */
  serial: number;
}

/** A freshly issued capability: the token to hand to the agent, and the one
 *  revocation that applies to exactly this grant. */
export interface CapabilityGrant {
  readonly token: string;
  revoke(): void;
}

/** The live facts verify() checks; injectable so tests and hosts share one rule. */
export interface CapabilityRegistryDeps {
  store: AgentStateStore;
  ptyManager: PtySessionManager;
}

/**
 * The single canonical key for a Workspace: undefined and the default's id
 * name the same Workspace. Used for every comparison and every table key here
 * and in curators.ts.
 */
export function workspaceKey(workspaceId: string | undefined): string {
  return workspaceId === undefined || workspaceId === DEFAULT_WORKSPACE_ID
    ? DEFAULT_WORKSPACE_ID
    : workspaceId;
}

/** Whether a normalized Workspace key names a Workspace that exists now. */
export function workspaceKeyExists(key: string): boolean {
  return key === DEFAULT_WORKSPACE_ID || listWorkspaces().some((w) => w.id === key);
}

/**
 * The token out of a raw token or an `Authorization` header value. Strict: one
 * exact `Bearer ` prefix and nothing around the token; anything else is null.
 */
function parseToken(presented: unknown): string | null {
  if (typeof presented !== 'string' || presented.length === 0) return null;
  const raw = presented.startsWith(CAPABILITY_BEARER_PREFIX)
    ? presented.slice(CAPABILITY_BEARER_PREFIX.length)
    : presented;
  return CAPABILITY_TOKEN_PATTERN.test(raw) ? raw : null;
}

function digestOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Remove every spelling of the capability variable from an environment copy.
 * Case-insensitive on Windows, where the environment is. Returns the input
 * object unchanged when there was nothing to remove.
 */
export function withoutCapabilityEnv<T extends Record<string, string | undefined>>(
  env: T,
  platform: NodeJS.Platform = process.platform,
): T {
  const matches = (key: string) =>
    platform === 'win32'
      ? key.toUpperCase() === CAPABILITY_ENV_NAME.toUpperCase()
      : key === CAPABILITY_ENV_NAME;
  if (!Object.keys(env).some(matches)) return env;
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (matches(key)) delete copy[key];
  }
  return copy;
}

type RevokedListener = (agentId: number) => void;

export class CapabilityRegistry {
  /** sha256(token) hex -> claims. The only place a capability lives. */
  private readonly entries = new Map<string, CapabilityClaims>();
  private readonly revokedListeners = new Set<RevokedListener>();
  private nextSerial = 1;
  private readonly store: AgentStateStore;
  private readonly ptyManager: PtySessionManager;

  constructor(deps: CapabilityRegistryDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    // The MAIN store instance only: the shadow store's agents (ids from
    // 1 000 000) are never seen here.
    this.store.on('agentRemoved', (id) => this.revokeAgent(id));
    this.store.on('agentWorkspaceChanged', (id) => this.revokeAgent(id));
    this.store.on('agentsCleared', (ids) => {
      for (const id of ids) this.revokeAgent(id);
    });
  }

  /** Number of live entries (tests and diagnostics of the registry itself). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Issue a capability for an agent being launched. Synchronous: the token is
   * generated with the blocking randomBytes so a launch cannot interleave.
   */
  issue(input: {
    agentId: number;
    sessionId: string;
    workspaceId: string | undefined;
  }): CapabilityGrant {
    const token =
      CAPABILITY_TOKEN_PREFIX + crypto.randomBytes(CAPABILITY_TOKEN_BYTES).toString('base64url');
    const digest = digestOf(token);
    this.entries.set(digest, {
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: workspaceKey(input.workspaceId),
      serial: this.nextSerial++,
    });
    return {
      token,
      // Exactly this grant, by the digest captured here: never "everything of
      // agent N", which could hit a later grant for a reused id.
      revoke: () => this.drop(digest),
    };
  }

  /**
   * The claims of a presented capability (raw token or `Authorization` header
   * value), or null. A capability whose live facts no longer hold is revoked
   * on the spot.
   */
  verify(presented: unknown): CapabilityClaims | null {
    const token = parseToken(presented);
    if (token === null) return null;
    const digest = digestOf(token);
    const claims = this.entries.get(digest);
    if (!claims) return null;
    if (!this.stillHolds(claims)) {
      this.drop(digest);
      return null;
    }
    return { ...claims };
  }

  /** The claims of a live capability held by this agent, or null. */
  validFor(agentId: number): CapabilityClaims | null {
    for (const [digest, claims] of [...this.entries]) {
      if (claims.agentId !== agentId) continue;
      if (this.stillHolds(claims)) return { ...claims };
      this.drop(digest);
    }
    return null;
  }

  /** Revoke every capability of an agent (it left the store or its Workspace). */
  revokeAgent(agentId: number): void {
    for (const [digest, claims] of [...this.entries]) {
      if (claims.agentId === agentId) this.drop(digest);
    }
  }

  /** Called once per revoked agent, after its last capability is gone. */
  onRevoked(listener: RevokedListener): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  /** The live re-check: everything but the digest that must still be true. */
  private stillHolds(claims: CapabilityClaims): boolean {
    const agent = this.store.get(claims.agentId);
    if (!agent) return false;
    if (!this.ptyManager.has(claims.agentId)) return false;
    if (workspaceKey(agent.workspaceId) !== claims.workspaceId) return false;
    return workspaceKeyExists(claims.workspaceId);
  }

  /** The single revocation entry point: delete, then tell the listeners
   *  (curators) once the agent holds nothing any more. */
  private drop(digest: string): void {
    const claims = this.entries.get(digest);
    if (!claims) return;
    this.entries.delete(digest);
    for (const other of this.entries.values()) {
      if (other.agentId === claims.agentId) return;
    }
    for (const listener of [...this.revokedListeners]) {
      try {
        listener(claims.agentId);
      } catch (err) {
        console.error('[Pixel Agents] Capability revocation listener failed:', err);
      }
    }
  }
}
