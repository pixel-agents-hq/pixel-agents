/**
 * Shared fixtures for the Knowledge Base storage tests: a temporary HOME, store
 * construction with simulated processes (distinct pids and instances, an
 * injectable liveness answer), and direct on-disk seeding for limits that would
 * take thousands of real operations to reach.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

import { buildAuditLine, KB_AUDIT_GENESIS_PREV, type KbAuditInput } from '../src/kbAudit.js';
import { KbPaths } from '../src/kbFiles.js';
import { normalizeTitle } from '../src/kbIds.js';
import { type KbLockFs, lockGeneration } from '../src/kbLock.js';
import { type KbProposal, type KbProposer, proposalDigest } from '../src/kbProposals.js';
import { type KbIndex, type KbIndexEntry, KbStore, type KbStoreHooks } from '../src/kbStore.js';
import { sha256Hex } from '../src/textSafety.js';

export const WS = 'default';
export const OTHER_WS = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
export const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

export interface TempHome {
  home: string;
  kbRoot: string;
  paths: KbPaths;
  restore(): void;
}

/** Point HOME at a fresh temporary directory (never the real ~/.pixel-agents). */
export function useTempHome(): TempHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kb-'));
  const original = process.env.HOME;
  process.env.HOME = home;
  const kbRoot = path.join(home, '.pixel-agents', 'kb');
  return {
    home,
    kbRoot,
    paths: new KbPaths(kbRoot),
    restore() {
      vi.restoreAllMocks();
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function proposer(agentId = 1, instance = INSTANCE_A, serial = 0): KbProposer {
  return { instance, agentId, sessionId: `session-${agentId}`, serial };
}

/** Fake pids, unique across every Processes set in the test run. */
let nextFakePid = 900_001;

/** Simulated server processes sharing one KB root: each store has its own pid
 *  and lock instance, and `alive` decides which of them still run (a pid this
 *  set never spawned counts as dead). */
export class Processes {
  readonly alive = new Set<number>();

  constructor(private readonly paths: KbPaths) {}

  isAlive = (pid: number): boolean => this.alive.has(pid);

  spawn(
    options: { fs?: KbLockFs; now?: () => number; hooks?: KbStoreHooks; instance?: string } = {},
  ): { pid: number; store: KbStore } {
    const pid = nextFakePid++;
    this.alive.add(pid);
    const store = new KbStore({
      paths: this.paths,
      now: options.now,
      hooks: options.hooks,
      lock: {
        pid,
        instance: options.instance,
        isProcessAlive: this.isAlive,
        fs: options.fs,
      },
    });
    return { pid, store };
  }

  kill(pid: number): void {
    this.alive.delete(pid);
  }
}

/** A store whose lock pid is fake and always alive (one process per test). */
export function singleStore(
  paths: KbPaths,
  options: { now?: () => number; hooks?: KbStoreHooks } = {},
): KbStore {
  return new Processes(paths).spawn(options).store;
}

/** The real lock fs calls, with an optional hook before each and a guard that
 *  records any unlink of the generation that is the highest at that moment. */
export function observedLockFs(
  root: string,
  options: {
    beforeSymlink?: (linkPath: string) => Promise<void>;
    beforeReaddir?: () => Promise<void>;
    violations?: string[];
  } = {},
): KbLockFs {
  return {
    readdir: async (dir) => {
      await options.beforeReaddir?.();
      return fs.promises.readdir(dir);
    },
    symlink: async (target, linkPath) => {
      await options.beforeSymlink?.(linkPath);
      await fs.promises.symlink(target, linkPath);
    },
    readlink: (linkPath) => fs.promises.readlink(linkPath),
    unlink: async (linkPath) => {
      const generations = fs
        .readdirSync(root)
        .map((name) => lockGeneration(name))
        .filter((g): g is number => g !== null);
      const highest = Math.max(...generations);
      if (lockGeneration(path.basename(linkPath)) === highest) {
        options.violations?.push(path.basename(linkPath));
      }
      await fs.promises.unlink(linkPath);
    },
  };
}

/** A promise with its resolver, for pausing an fs call at a chosen point. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function readIndexFile(paths: KbPaths, ws = WS): KbIndex {
  return readJson(paths.indexFile(ws)) as KbIndex;
}

export function auditLines(paths: KbPaths, ws = WS): Record<string, unknown>[] {
  const file = paths.auditFile(ws);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function mode(p: string): number {
  return fs.lstatSync(p).mode & 0o777;
}

/** Create the workspace directories (0700) the way the store would. */
export function makeWorkspaceDirs(paths: KbPaths, ws = WS): void {
  for (const dir of [
    path.dirname(paths.root),
    paths.root,
    paths.workspaceDir(ws),
    paths.blobsDir(ws),
    paths.proposalsDir(ws),
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

/** Write `count` entries of `size` bytes straight to disk (index + blobs). */
export function seedEntries(
  paths: KbPaths,
  count: number,
  size: number,
  ws = WS,
  kbVersion = count,
): KbIndexEntry[] {
  makeWorkspaceDirs(paths, ws);
  const at = new Date().toISOString();
  const entries: KbIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const content = Buffer.alloc(size, 0x61 + (i % 26));
    const blob = crypto.randomUUID();
    fs.writeFileSync(paths.blobFile(ws, blob), content, { mode: 0o600 });
    const title = normalizeTitle(`Seeded ${i}`)!;
    entries.push({
      id: crypto.randomUUID(),
      title: title.title,
      titleKey: title.titleKey,
      blob,
      sha256: sha256Hex(content),
      size,
      version: 1,
      sourceProposalId: crypto.randomUUID(),
      createdAt: at,
      updatedAt: at,
    });
  }
  const index: KbIndex = { version: 1, kbVersion, entries, applied: [] };
  fs.writeFileSync(paths.indexFile(ws), `${JSON.stringify(index)}\n`, { mode: 0o600 });
  return entries;
}

/** A well-formed terminal (rejected) proposal file written straight to disk. */
export function seedTerminalProposal(paths: KbPaths, decidedAt: string, ws = WS): KbProposal {
  const title = `Seeded proposal ${crypto.randomUUID()}`;
  const fields = { kind: 'create' as const, title, contentSha256: sha256Hex(Buffer.from('x')) };
  const proposal: KbProposal = {
    version: 1,
    id: crypto.randomUUID(),
    workspaceId: ws,
    ...fields,
    proposer: proposer(99),
    state: 'rejected',
    createdAt: decidedAt,
    decidedAt,
    decidedBy: 'agent',
    digest: proposalDigest(fields),
  };
  fs.writeFileSync(paths.proposalFile(ws, proposal.id), JSON.stringify(proposal), {
    mode: 0o600,
  });
  return proposal;
}

/** `count` valid chained audit lines, as one string (for rotation tests). */
export function chainedAuditText(count: number, padReason: string): string {
  let prev = KB_AUDIT_GENESIS_PREV;
  const lines: string[] = [];
  const input: KbAuditInput = {
    event: 'settings_changed',
    actor: { kind: 'operator' },
    detail: { reason: padReason },
  };
  for (let seq = 1; seq <= count; seq++) {
    const { line, hash } = buildAuditLine(input, seq, new Date(0).toISOString(), prev);
    lines.push(line);
    prev = hash;
  }
  return `${lines.join('\n')}\n`;
}

/** Submit a create and return the proposal metadata (throws on failure). */
export async function submitCreate(
  store: KbStore,
  title: string,
  content: string,
  by: KbProposer = proposer(),
  ws = WS,
): Promise<{ id: string; digest: string }> {
  const result = await store.submitProposal(ws, { kind: 'create', title, content, proposer: by });
  if (!result.ok) throw new Error(`submit failed: ${result.code}`);
  return { id: result.proposal.id, digest: result.proposal.digest };
}

export function approve(
  store: KbStore,
  p: { id: string; digest: string },
  ws = WS,
  actor: KbProposer = proposer(500),
) {
  return store.decideProposal(ws, p.id, { action: 'approve', digest: p.digest, actor });
}

export function reject(
  store: KbStore,
  p: { id: string; digest: string },
  ws = WS,
  actor: KbProposer = proposer(500),
) {
  return store.decideProposal(ws, p.id, { action: 'reject', digest: p.digest, actor });
}

export function operator(
  store: KbStore,
  p: { id: string; digest: string },
  action: 'confirm' | 'reject',
  ws = WS,
) {
  return store.operatorDecide(ws, p.id, { action, digest: p.digest });
}
