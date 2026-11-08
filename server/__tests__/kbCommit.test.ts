import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KbProposal } from '../src/kbProposals.js';
import type { KbCommitStep, KbStore } from '../src/kbStore.js';
import {
  approve,
  auditLines,
  operator,
  Processes,
  proposer,
  readIndexFile,
  readJson,
  reject,
  seedEntries,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function stateOf(temp: TempHome, id: string): string {
  return (readJson(temp.paths.proposalFile(WS, id)) as KbProposal).state;
}

function pendingIds(store: KbStore): string[] {
  const internals = store as unknown as {
    workspaces: Map<string, { cache: { pending: Map<string, unknown> } | null }>;
  };
  return [...(internals.workspaces.get(WS)?.cache?.pending.keys() ?? [])];
}

/** A store whose commit steps fail while `failing` names them. */
function faultyStore(temp: TempHome, clock?: () => number) {
  const failing = new Set<KbCommitStep>();
  const processes = new Processes(temp.paths);
  const proc = processes.spawn({
    now: clock,
    hooks: {
      commitStep: (step) => {
        if (failing.has(step)) throw Object.assign(new Error('injected'), { code: 'EIO' });
      },
    },
  });
  return { ...proc, processes, failing };
}

function blobNames(temp: TempHome): string[] {
  return fs.readdirSync(temp.paths.blobsDir(WS)).sort();
}

function backdate(filePath: string, ms: number): void {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(filePath, at, at);
}

describe('commit sequence under injected failures (acceptance 14)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => temp.restore());

  it('step 1 (commit_started) failing: io, and nothing changed at all', async () => {
    const { store, failing } = faultyStore(temp);
    const p = await submitCreate(store, 'Never', 'content');
    const indexBefore = fs.readFileSync(temp.paths.indexFile(WS), 'utf-8');
    const auditBefore = fs.readFileSync(temp.paths.auditFile(WS), 'utf-8');
    failing.add('audit_started');
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'io' });
    expect(fs.readFileSync(temp.paths.indexFile(WS), 'utf-8')).toBe(indexBefore);
    expect(fs.readFileSync(temp.paths.auditFile(WS), 'utf-8')).toBe(auditBefore);
    expect(blobNames(temp)).toEqual([]);
    expect(stateOf(temp, p.id)).toBe('pending');
  });

  it('a real audit write failure at step 1 is io with the index unchanged', async () => {
    let failAudit = false;
    const store = new Processes(temp.paths).spawn({
      hooks: {
        auditAppend: (inputs) => {
          if (failAudit && inputs[0].event === 'commit_started') throw new Error('disk full');
        },
      },
    }).store;
    const p = await submitCreate(store, 'Audit fails', 'content');
    const indexBefore = fs.readFileSync(temp.paths.indexFile(WS), 'utf-8');
    failAudit = true;
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'io' });
    expect(fs.readFileSync(temp.paths.indexFile(WS), 'utf-8')).toBe(indexBefore);
    expect(blobNames(temp)).toEqual([]);
  });

  it('failing after step 2: the index still points at the old state, the orphan sweeps after an hour', async () => {
    const [entry] = seedEntries(temp.paths, 1, 8);
    const { store, failing } = faultyStore(temp);
    const p = await submitCreate(store, 'Orphaned', 'content');
    const indexBefore = fs.readFileSync(temp.paths.indexFile(WS), 'utf-8');
    failing.add('write_index');
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'io' });
    expect(fs.readFileSync(temp.paths.indexFile(WS), 'utf-8')).toBe(indexBefore);
    expect(stateOf(temp, p.id)).toBe('pending');
    const orphan = blobNames(temp).find((name) => name !== `${entry.blob}.md`)!;
    expect(orphan).toBeDefined();
    failing.clear();
    expect(await store.sweepOrphanBlobs(WS)).toEqual({ ok: true, removed: 0 }); // too young
    backdate(path.join(temp.paths.blobsDir(WS), orphan), 2 * 60 * 60 * 1000);
    backdate(temp.paths.blobFile(WS, entry.blob), 2 * 60 * 60 * 1000);
    expect(await store.sweepOrphanBlobs(WS)).toEqual({ ok: true, removed: 1 });
    expect(blobNames(temp)).toEqual([`${entry.blob}.md`]);
    // The proposal can still be approved afterwards.
    expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
  });

  it('failing after step 3: the new content is readable, the proposal still pending on disk', async () => {
    const { store, failing } = faultyStore(temp);
    const p = await submitCreate(store, 'Committed', 'the new content');
    failing.add('update_proposal');
    expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved', kbVersion: 1 });
    const index = readIndexFile(temp.paths);
    expect(index.applied.map((a) => a.proposalId)).toEqual([p.id]);
    expect(await store.readEntry(WS, index.entries[0].id)).toMatchObject({
      ok: true,
      content: 'the new content',
    });
    expect(stateOf(temp, p.id)).toBe('pending');
  });

  for (const step of ['update_proposal', 'audit_done'] as const) {
    it(`step ${step === 'update_proposal' ? 4 : 5} failing is only logged; the index stays consistent`, async () => {
      const { store, failing } = faultyStore(temp);
      const p = await submitCreate(store, 'Logged', 'body');
      failing.add(step);
      expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
      const index = readIndexFile(temp.paths);
      expect(index.entries).toHaveLength(1);
      expect(blobNames(temp)).toEqual([`${index.entries[0].blob}.md`]);
      const done = auditLines(temp.paths).filter((line) => line.event === 'commit_done');
      expect(done).toHaveLength(step === 'audit_done' ? 0 : 1);
      expect(stateOf(temp, p.id)).toBe(step === 'update_proposal' ? 'pending' : 'approved');
    });
  }

  it('step 6 failing leaves only an orphan blob', async () => {
    const [entry] = seedEntries(temp.paths, 1, 8);
    const { store, failing } = faultyStore(temp);
    await store.writeSettings(WS, { operatorConfirm: false });
    const replace = await store.submitProposal(WS, {
      kind: 'replace',
      targetEntryId: entry.id,
      content: 'replacement',
      proposer: proposer(),
    });
    if (!replace.ok) throw new Error('submit failed');
    failing.add('remove_old_blob');
    expect(await approve(store, replace.proposal)).toMatchObject({ ok: true, state: 'approved' });
    const index = readIndexFile(temp.paths);
    expect(index.entries[0].blob).not.toBe(entry.blob);
    expect(blobNames(temp).sort()).toEqual(
      [`${entry.blob}.md`, `${index.entries[0].blob}.md`].sort(),
    );
    expect(await store.readEntry(WS, entry.id)).toMatchObject({ content: 'replacement' });
    // Without the fault the old blob goes.
    failing.clear();
    const again = await store.submitProposal(WS, {
      kind: 'replace',
      targetEntryId: entry.id,
      content: 'third',
      proposer: proposer(),
    });
    if (!again.ok) throw new Error('submit failed');
    await approve(store, again.proposal);
    expect(blobNames(temp)).toHaveLength(2); // the first orphan + the current blob
  });

  it('a crash right after the commit point is completed by the next process', async () => {
    const { store, pid, processes, failing } = faultyStore(temp);
    const p = await submitCreate(store, 'Crash', 'body');
    for (const step of ['update_proposal', 'audit_done', 'remove_old_blob'] as const)
      failing.add(step);
    expect(await approve(store, p)).toMatchObject({ ok: true });
    processes.kill(pid);
    const next = processes.spawn().store;
    expect(await next.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true }); // takes the lock
    const listed = await next.listProposals(WS);
    expect(listed).toMatchObject({ ok: true });
    expect(listed.ok && listed.proposals.find((x) => x.id === p.id)?.state).toBe('approved');
    expect(readIndexFile(temp.paths).kbVersion).toBe(1);
  });
});

describe('reconciliation after a commit whose proposal update failed (acceptance 15)', () => {
  let temp: TempHome;
  let clock: number;
  beforeEach(() => {
    temp = useTempHome();
    clock = Date.parse('2026-03-01T00:00:00.000Z');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => temp.restore());

  /** A committed-but-still-pending proposal X (high impact: confirmed by the operator). */
  async function committedButPending(options: { highImpact?: boolean } = {}) {
    const fx = faultyStore(temp, () => clock);
    const content = options.highImpact ? 'h'.repeat(20000) : 'small body';
    const x = await submitCreate(fx.store, 'X', content, proposer(1));
    fx.failing.add('update_proposal');
    fx.failing.add('audit_done');
    if (options.highImpact) {
      expect(await approve(fx.store, x)).toMatchObject({ state: 'pending_operator' });
      expect(await operator(fx.store, x, 'confirm')).toMatchObject({ ok: true, state: 'approved' });
      expect(stateOf(temp, x.id)).toBe('pending_operator');
    } else {
      expect(await approve(fx.store, x)).toMatchObject({ ok: true, state: 'approved' });
      expect(stateOf(temp, x.id)).toBe('pending');
    }
    fx.failing.clear();
    const kbVersion = readIndexFile(temp.paths).kbVersion;
    expect(readIndexFile(temp.paths).applied.map((a) => a.proposalId)).toContain(x.id);
    expect(pendingIds(fx.store)).toContain(x.id);
    return { ...fx, x, kbVersion };
  }

  function expectReconciled(store: KbStore, xId: string, kbVersion: number): void {
    expect(stateOf(temp, xId)).toBe('approved');
    expect((readJson(temp.paths.proposalFile(WS, xId)) as KbProposal).content).toBeUndefined();
    const done = auditLines(temp.paths).filter(
      (line) => line.event === 'commit_done' && line.proposalId === xId,
    );
    expect(done).toHaveLength(1);
    expect((done[0].detail as { reason: string }).reason).toBe('reconciled');
    expect(readIndexFile(temp.paths).kbVersion).toBe(kbVersion);
    expect(readIndexFile(temp.paths).entries).toHaveLength(1);
    expect(pendingIds(store)).not.toContain(xId);
    const wrong = auditLines(temp.paths).filter(
      (line) =>
        line.proposalId === xId &&
        ['proposal_voided', 'proposal_expired', 'proposal_rejected'].includes(line.event as string),
    );
    expect(wrong).toEqual([]);
  }

  it('voidWorkspaceProposals approves it instead of voiding it', async () => {
    const { store, x, kbVersion } = await committedButPending();
    expect(await store.voidWorkspaceProposals(WS, 'workspace_removed')).toEqual({
      ok: true,
      voided: 0,
    });
    expectReconciled(store, x.id, kbVersion);
  });

  it('voidWorkspaceProposals approves a pending_operator one too', async () => {
    const { store, x, kbVersion } = await committedButPending({ highImpact: true });
    expect(await store.voidWorkspaceProposals(WS, 'workspace_removed')).toEqual({
      ok: true,
      voided: 0,
    });
    expectReconciled(store, x.id, kbVersion);
  });

  it('TTL expiry on the next submit approves it instead of expiring it', async () => {
    const { store, x, kbVersion } = await committedButPending();
    clock += 15 * DAY_MS;
    await submitCreate(store, 'Later', 'x', proposer(2));
    expectReconciled(store, x.id, kbVersion);
  });

  it('listProposals approves it', async () => {
    const { store, x, kbVersion } = await committedButPending();
    const listed = await store.listProposals(WS);
    expect(listed).toMatchObject({ ok: true });
    expect(listed.ok && listed.reconciliationSkipped).toBeFalsy();
    expect(listed.ok && listed.proposals.find((p) => p.id === x.id)?.state).toBe('approved');
    expectReconciled(store, x.id, kbVersion);
  });

  it('readProposal approves it', async () => {
    const { store, x, kbVersion } = await committedButPending();
    expect(await store.readProposal(WS, x.id)).toMatchObject({
      ok: true,
      proposal: { state: 'approved' },
    });
    expectReconciled(store, x.id, kbVersion);
  });

  it('reject answers state (never rejected)', async () => {
    const { store, x, kbVersion } = await committedButPending();
    expect(await reject(store, x)).toMatchObject({ ok: false, code: 'state' });
    expectReconciled(store, x.id, kbVersion);
  });

  it('approve answers repeated without a second commit', async () => {
    const { store, x, kbVersion } = await committedButPending();
    expect(await approve(store, x)).toEqual({ ok: true, state: 'approved', repeated: true });
    expectReconciled(store, x.id, kbVersion);
  });

  it('operatorDecide confirm answers repeated, reject answers state', async () => {
    const { store, x, kbVersion } = await committedButPending({ highImpact: true });
    expect(await operator(store, x, 'confirm')).toEqual({
      ok: true,
      state: 'approved',
      repeated: true,
    });
    expect(await operator(store, x, 'reject')).toMatchObject({ ok: false, code: 'state' });
    expectReconciled(store, x.id, kbVersion);
  });

  it('is approved before 200 later commits push it out of the applied ring', async () => {
    const { store, x, kbVersion } = await committedButPending();
    const first = await submitCreate(store, 'After 0', 'x', proposer(2));
    expect(await approve(store, first)).toMatchObject({ ok: true });
    expect(stateOf(temp, x.id)).toBe('approved'); // reconciled before that commit
    for (let i = 1; i <= 200; i++) {
      const p = await submitCreate(store, `After ${i}`, 'x', proposer(2));
      expect(await approve(store, p)).toMatchObject({ ok: true });
    }
    const index = readIndexFile(temp.paths);
    expect(index.applied).toHaveLength(200);
    expect(index.applied.map((a) => a.proposalId)).not.toContain(x.id);
    expect(await approve(store, x)).toEqual({ ok: true, state: 'approved', repeated: true });
    expect(readIndexFile(temp.paths).kbVersion).toBe(kbVersion + 201);
    expect(index.entries).toHaveLength(202);
  }, 120_000);

  it('a reader without the lock skips reconciliation and says so', async () => {
    const { x, processes } = await committedButPending();
    const reader = processes.spawn().store; // the writer is alive
    const listed = await reader.listProposals(WS);
    expect(listed).toMatchObject({ ok: true, reconciliationSkipped: true });
    expect(listed.ok && listed.proposals.find((p) => p.id === x.id)?.state).toBe('pending');
    expect(await reader.readProposal(WS, x.id)).toMatchObject({
      ok: true,
      reconciliationSkipped: true,
      proposal: { state: 'pending' },
    });
    expect(stateOf(temp, x.id)).toBe('pending');
    expect(await reader.voidWorkspaceProposals(WS, 'workspace_removed')).toMatchObject({
      ok: false,
      code: 'locked',
    });
    expect(stateOf(temp, x.id)).toBe('pending');
  });
});
