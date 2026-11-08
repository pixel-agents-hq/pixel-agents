import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type KbDecisionRequest,
  type KbProposal,
  type KbProposalState,
  planDecision,
} from '../src/kbProposals.js';
import type { KbStore } from '../src/kbStore.js';
import { sha256Hex } from '../src/textSafety.js';
import {
  approve,
  auditLines,
  INSTANCE_B,
  operator,
  Processes,
  proposer,
  readIndexFile,
  readJson,
  reject,
  seedEntries,
  seedTerminalProposal,
  singleStore,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function proposalFile(temp: TempHome, id: string): KbProposal {
  return readJson(temp.paths.proposalFile(WS, id)) as KbProposal;
}

function pendingCache(store: KbStore): Map<string, { proposerKey: string }> {
  const internals = store as unknown as {
    workspaces: Map<string, { cache: { pending: Map<string, { proposerKey: string }> } | null }>;
  };
  return internals.workspaces.get(WS)?.cache?.pending ?? new Map();
}

async function submitReplace(store: KbStore, entryId: string, content: string, agentId = 1) {
  const result = await store.submitProposal(WS, {
    kind: 'replace',
    targetEntryId: entryId,
    content,
    proposer: proposer(agentId),
  });
  if (!result.ok) throw new Error(`replace failed: ${result.code}`);
  return { id: result.proposal.id, digest: result.proposal.digest };
}

async function submitDelete(store: KbStore, entryId: string, agentId = 1) {
  const result = await store.submitProposal(WS, {
    kind: 'delete',
    targetEntryId: entryId,
    proposer: proposer(agentId),
  });
  if (!result.ok) throw new Error(`delete failed: ${result.code}`);
  return { id: result.proposal.id, digest: result.proposal.digest };
}

describe('proposal tampering (acceptance 7)', () => {
  let temp: TempHome;
  let store: KbStore;
  beforeEach(() => {
    temp = useTempHome();
    store = singleStore(temp.paths);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => temp.restore());

  it('answers tampered, changing nothing, when content changed but the digest was kept', async () => {
    const p = await submitCreate(store, 'Honest', 'reviewed text');
    const file = temp.paths.proposalFile(WS, p.id);
    const stored = proposalFile(temp, p.id);
    fs.writeFileSync(file, JSON.stringify({ ...stored, content: 'swapped text' }));
    const before = fs.readFileSync(file, 'utf-8');
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'tampered' });
    expect(await operator(store, p, 'reject')).toMatchObject({ ok: false, code: 'tampered' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(readIndexFile(temp.paths).entries).toEqual([]);

    // A digest-bound field changed under the same digest is caught too.
    fs.writeFileSync(file, JSON.stringify({ ...stored, title: 'Other' }));
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'tampered' });
    expect(proposalFile(temp, p.id).state).toBe('pending');
  });
});

describe('quotas, expiry and pruning (acceptance 9)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('caps one proposer (instance:agentId) at 20 pending, others still submit', async () => {
    const store = singleStore(temp.paths);
    for (let i = 0; i < 20; i++) await submitCreate(store, `Mine ${i}`, 'x', proposer(1));
    expect(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 'Mine 20',
        content: 'x',
        proposer: proposer(1),
      }),
    ).toMatchObject({ ok: false, code: 'quota' });
    // Same agentId on another instance is another proposer; so is another agent.
    await submitCreate(store, 'Theirs', 'x', proposer(1, INSTANCE_B));
    await submitCreate(store, 'Other agent', 'x', proposer(2));
  });

  it('a failed first scan of proposals/ leaves no partial cache: the next call scans again and the quota holds', async () => {
    const processes = new Processes(temp.paths);
    const first = processes.spawn();
    for (let i = 0; i < 20; i++) await submitCreate(first.store, `Mine ${i}`, 'x', proposer(1));
    processes.kill(first.pid);

    // A restarted server: its first scan of proposals/ fails once.
    const second = processes.spawn().store;
    const realReaddir = fs.promises.readdir;
    let failed = false;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((
      dir: Parameters<typeof realReaddir>[0],
      ...rest: unknown[]
    ) => {
      if (!failed && String(dir).endsWith('proposals')) {
        failed = true;
        return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      }
      return (realReaddir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as unknown as typeof fs.promises.readdir);
    try {
      const input = {
        kind: 'create' as const,
        title: 'Mine 20',
        content: 'x',
        proposer: proposer(1),
      };
      expect(await second.submitProposal(WS, input)).toMatchObject({ ok: false, code: 'io' });
      // The failed scan must not have left an empty cache behind.
      expect(await second.submitProposal(WS, input)).toMatchObject({ ok: false, code: 'quota' });
      expect(pendingCache(second).size).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it('caps the workspace at 100 pending', async () => {
    const store = singleStore(temp.paths);
    for (let agent = 1; agent <= 5; agent++) {
      for (let i = 0; i < 20; i++)
        await submitCreate(store, `A${agent} ${i}`, 'x', proposer(agent));
    }
    expect(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 'One too many',
        content: 'x',
        proposer: proposer(6),
      }),
    ).toMatchObject({ ok: false, code: 'quota' });
  }, 60_000);

  it('expires proposals pending for more than 14 days when the next one is submitted', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = singleStore(temp.paths, { now: () => clock });
    const old = await submitCreate(store, 'Old', 'x', proposer(1));
    const edge = await submitCreate(store, 'Edge', 'x', proposer(2));
    clock += 1;
    const fresh = await submitCreate(store, 'Fresh', 'x', proposer(3));
    clock += 14 * DAY_MS; // old and edge: 14 days + 1 ms; fresh: exactly 14 days
    await submitCreate(store, 'Trigger', 'x', proposer(4));
    expect(proposalFile(temp, old.id).state).toBe('expired');
    expect(proposalFile(temp, old.id).content).toBeUndefined();
    expect(proposalFile(temp, edge.id).state).toBe('expired');
    expect(proposalFile(temp, fresh.id).state).toBe('pending');
    const expired = auditLines(temp.paths).filter((line) => line.event === 'proposal_expired');
    expect(expired.map((line) => line.proposalId).sort()).toEqual([old.id, edge.id].sort());
    expect(await approve(store, old)).toMatchObject({ ok: false, code: 'state' });
  });

  it('keeps at most 1000 decided proposal files, oldest removed first, pending and audit kept', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const processes = new Processes(temp.paths);
    const first = processes.spawn({ now: () => clock });
    const pending = await submitCreate(first.store, 'Still pending', 'x', proposer(1));
    clock += 1000;
    const a = await submitCreate(first.store, 'Rejected early', 'x', proposer(2));
    expect(await reject(first.store, a)).toMatchObject({ ok: true, state: 'rejected' });
    const seeded = Array.from({ length: 1000 }, (_, i) =>
      seedTerminalProposal(temp.paths, new Date(clock + 1000 + i).toISOString()),
    );
    processes.kill(first.pid); // a restart: the next store scans the directory again
    clock += 10_000;
    const second = processes.spawn({ now: () => clock }).store;
    const b = await submitCreate(second, 'Rejected late', 'x', proposer(3));
    expect(await reject(second, b)).toMatchObject({ ok: true, state: 'rejected' });

    const files = fs.readdirSync(temp.paths.proposalsDir(WS));
    expect(files).toHaveLength(1001); // 1000 decided + 1 pending
    expect(fs.existsSync(temp.paths.proposalFile(WS, a.id))).toBe(false);
    expect(fs.existsSync(temp.paths.proposalFile(WS, seeded[0].id))).toBe(false);
    expect(fs.existsSync(temp.paths.proposalFile(WS, seeded[1].id))).toBe(true);
    expect(fs.existsSync(temp.paths.proposalFile(WS, b.id))).toBe(true);
    expect(proposalFile(temp, pending.id).state).toBe('pending');
    const aEvents = auditLines(temp.paths)
      .filter((line) => line.proposalId === a.id)
      .map((line) => line.event);
    expect(aEvents).toEqual(['proposal_submitted', 'proposal_rejected']);
  }, 60_000);

  it('keeps the cached pending counts equal to a fresh scan', async () => {
    const processes = new Processes(temp.paths);
    const first = processes.spawn();
    const store = first.store;
    await store.writeSettings(WS, { operatorConfirm: false });
    const made = [];
    for (let i = 0; i < 12; i++)
      made.push(await submitCreate(store, `C ${i}`, 'x', proposer(1 + (i % 3))));
    await approve(store, made[0]);
    await reject(store, made[1]);
    await operator(store, made[2], 'reject');
    await store.voidWorkspaceProposals(WS, 'agent_removed');
    for (let i = 12; i < 17; i++) made.push(await submitCreate(store, `C ${i}`, 'x', proposer(4)));
    const cached = new Map([...pendingCache(store)].map(([id, item]) => [id, item.proposerKey]));

    processes.kill(first.pid);
    const fresh = processes.spawn().store;
    await submitCreate(fresh, 'Probe', 'x', proposer(9)); // first use: one scan
    const scanned = new Map([...pendingCache(fresh)].map(([id, item]) => [id, item.proposerKey]));
    scanned.delete([...scanned.keys()].find((id) => !cached.has(id))!);
    expect(scanned).toEqual(cached);
    expect(cached.size).toBe(5);
  });
});

describe('the state machine (acceptance 10)', () => {
  it('matches the transition table for every state and request', () => {
    const requests: KbDecisionRequest[] = [
      { by: 'agent', action: 'approve' },
      { by: 'agent', action: 'reject' },
      { by: 'operator', action: 'confirm' },
      { by: 'operator', action: 'reject' },
    ];
    const expected: Record<KbProposalState, string[]> = {
      pending: ['commit|pending_operator', 'rejected', 'state', 'rejected'],
      pending_operator: ['state', 'rejected', 'commit', 'rejected'],
      approved: ['repeated', 'state', 'repeated', 'state'],
      rejected: ['state', 'repeated', 'state', 'repeated'],
      stale: ['state', 'state', 'state', 'state'],
      voided: ['state', 'state', 'state', 'state'],
      expired: ['state', 'state', 'state', 'state'],
    };
    for (const [state, row] of Object.entries(expected) as [KbProposalState, string[]][]) {
      requests.forEach((request, i) => {
        const options = row[i].split('|');
        expect(planDecision(state, request, false), `${state} ${JSON.stringify(request)}`).toBe(
          options[0],
        );
        expect(planDecision(state, request, true), `${state} ${JSON.stringify(request)}`).toBe(
          options[options.length - 1],
        );
      });
    }
  });

  describe('on disk', () => {
    let temp: TempHome;
    let store: KbStore;
    let entryId: string;
    beforeEach(() => {
      temp = useTempHome();
      [{ id: entryId }] = seedEntries(temp.paths, 1, 8);
      store = singleStore(temp.paths);
    });
    afterEach(() => temp.restore());

    it('performs every legal transition with its actor', async () => {
      // pending -> approved (curator), low impact.
      const low = await submitCreate(store, 'Low', 'small', proposer(1));
      expect(await approve(store, low)).toMatchObject({
        ok: true,
        state: 'approved',
        kbVersion: 2,
      });
      // pending -> pending_operator -> approved (operator confirm).
      const high = await submitReplace(store, entryId, 'new body', 2);
      expect(await approve(store, high)).toEqual({ ok: true, state: 'pending_operator' });
      expect(await operator(store, high, 'confirm')).toMatchObject({
        ok: true,
        state: 'approved',
        kbVersion: 3,
      });
      expect(proposalFile(temp, high.id)).toMatchObject({
        state: 'approved',
        decidedBy: 'operator',
      });
      // pending -> rejected by the curator and by the operator.
      const r1 = await submitCreate(store, 'R1', 'x', proposer(3));
      expect(await reject(store, r1)).toEqual({ ok: true, state: 'rejected' });
      expect(proposalFile(temp, r1.id).decidedBy).toBe('agent');
      const r2 = await submitCreate(store, 'R2', 'x', proposer(3));
      expect(await operator(store, r2, 'reject')).toEqual({ ok: true, state: 'rejected' });
      expect(proposalFile(temp, r2.id).decidedBy).toBe('operator');
      // pending_operator -> rejected by the curator and by the operator.
      const index = readIndexFile(temp.paths);
      const d1 = await submitDelete(store, index.entries[0].id, 4);
      expect(await approve(store, d1)).toMatchObject({ state: 'pending_operator' });
      expect(await reject(store, d1)).toEqual({ ok: true, state: 'rejected' });
      const d2 = await submitDelete(store, index.entries[0].id, 4);
      expect(await approve(store, d2)).toMatchObject({ state: 'pending_operator' });
      expect(await operator(store, d2, 'reject')).toEqual({ ok: true, state: 'rejected' });
      const events = auditLines(temp.paths).map((line) => line.event);
      expect(events.filter((e) => e === 'proposal_pending_operator')).toHaveLength(3);
      expect(events.filter((e) => e === 'proposal_rejected')).toHaveLength(4);
      const decided = auditLines(temp.paths).filter((line) => line.event === 'proposal_rejected');
      expect(decided.map((line) => (line.actor as { kind: string }).kind)).toEqual([
        'agent',
        'operator',
        'agent',
        'operator',
      ]);
    });

    it('refuses every illegal transition with state, changing nothing', async () => {
      const p = await submitCreate(store, 'P', 'x', proposer(1));
      expect(await operator(store, p, 'confirm')).toMatchObject({ ok: false, code: 'state' });
      expect(proposalFile(temp, p.id).state).toBe('pending');

      const high = await submitReplace(store, entryId, 'body', 2);
      await approve(store, high);
      const kbVersion = readIndexFile(temp.paths).kbVersion;
      expect(await approve(store, high)).toMatchObject({ ok: false, code: 'state' });
      expect(await approve(store, high)).toMatchObject({ ok: false, code: 'state' });
      expect(readIndexFile(temp.paths).kbVersion).toBe(kbVersion);
      expect(proposalFile(temp, high.id).state).toBe('pending_operator');

      expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
      expect(await reject(store, p)).toMatchObject({ ok: false, code: 'state' });
      expect(await operator(store, p, 'reject')).toMatchObject({ ok: false, code: 'state' });

      const r = await submitCreate(store, 'R', 'x', proposer(3));
      await reject(store, r);
      expect(await approve(store, r)).toMatchObject({ ok: false, code: 'state' });
      expect(await operator(store, r, 'confirm')).toMatchObject({ ok: false, code: 'state' });

      const v = await submitCreate(store, 'V', 'x', proposer(4));
      const v2 = await submitReplace(store, entryId, 'other', 4);
      await approve(store, v2); // pending_operator, voided below
      await store.voidWorkspaceProposals(WS, 'workspace_removed');
      for (const proposal of [v, v2, high]) {
        expect(await approve(store, proposal)).toMatchObject({ ok: false, code: 'state' });
        expect(await operator(store, proposal, 'confirm')).toMatchObject({
          ok: false,
          code: 'state',
        });
      }
      expect(readIndexFile(temp.paths).kbVersion).toBe(kbVersion + 1);
    });

    it('answers a repeat of a terminal transition with repeated, audited once, after the digest check', async () => {
      const p = await submitCreate(store, 'Twice', 'x', proposer(1));
      expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
      const lines = auditLines(temp.paths).length;
      const kbVersion = readIndexFile(temp.paths).kbVersion;
      expect(await approve(store, p)).toEqual({ ok: true, state: 'approved', repeated: true });
      expect(await approve(store, { id: p.id, digest: 'f'.repeat(64) })).toMatchObject({
        ok: false,
        code: 'digest_mismatch',
      });
      const r = await submitCreate(store, 'Rejected', 'x', proposer(2));
      await reject(store, r);
      const afterReject = auditLines(temp.paths).length;
      expect(await reject(store, r)).toEqual({ ok: true, state: 'rejected', repeated: true });
      expect(await operator(store, r, 'reject')).toEqual({
        ok: true,
        state: 'rejected',
        repeated: true,
      });
      expect(auditLines(temp.paths).length).toBe(afterReject);
      expect(afterReject).toBe(lines + 2); // only r's submit and reject
      expect(readIndexFile(temp.paths).kbVersion).toBe(kbVersion);

      const high = await submitReplace(store, entryId, 'changed', 3);
      await approve(store, high);
      await operator(store, high, 'confirm');
      const afterConfirm = auditLines(temp.paths).length;
      expect(await operator(store, high, 'confirm')).toEqual({
        ok: true,
        state: 'approved',
        repeated: true,
      });
      expect(auditLines(temp.paths).length).toBe(afterConfirm);
    });

    it('answers digest_mismatch for a pending proposal without changing it', async () => {
      const p = await submitCreate(store, 'Reviewed', 'x', proposer(1));
      expect(await approve(store, { id: p.id, digest: '0'.repeat(64) })).toMatchObject({
        ok: false,
        code: 'digest_mismatch',
      });
      expect(proposalFile(temp, p.id).state).toBe('pending');
      expect(readIndexFile(temp.paths).kbVersion).toBe(1);
    });
  });
});

describe('stale proposals (acceptance 11)', () => {
  let temp: TempHome;
  let store: KbStore;
  let entryId: string;
  beforeEach(async () => {
    temp = useTempHome();
    [{ id: entryId }] = seedEntries(temp.paths, 1, 8);
    store = singleStore(temp.paths);
    await store.writeSettings(WS, { operatorConfirm: false });
  });
  afterEach(() => temp.restore());

  it('commits the first of two replaces and turns the second stale, KB unchanged', async () => {
    const first = await submitReplace(store, entryId, 'first', 1);
    const second = await submitReplace(store, entryId, 'second', 2);
    const removal = await submitDelete(store, entryId, 3);
    expect(await approve(store, first)).toMatchObject({ ok: true, state: 'approved' });
    const after = readIndexFile(temp.paths);
    expect(await approve(store, second)).toMatchObject({ ok: false, code: 'stale' });
    expect(await approve(store, removal)).toMatchObject({ ok: false, code: 'stale' });
    expect(readIndexFile(temp.paths)).toEqual(after);
    expect(proposalFile(temp, second.id).state).toBe('stale');
    expect(proposalFile(temp, removal.id).state).toBe('stale');
    const entry = await store.readEntry(WS, entryId);
    expect(entry).toMatchObject({ ok: true, content: 'first' });
  });

  it('sees A -> B -> A as stale: same sha256, different version', async () => {
    const original = readIndexFile(temp.paths).entries[0];
    const content = fs.readFileSync(temp.paths.blobFile(WS, original.blob), 'utf-8');
    const old = await submitReplace(store, entryId, 'made at version 1', 1);
    await approve(store, await submitReplace(store, entryId, 'B', 2));
    await approve(store, await submitReplace(store, entryId, content, 3));
    const now = readIndexFile(temp.paths).entries[0];
    expect(now.sha256).toBe(original.sha256);
    expect(now.version).toBe(3);
    expect(await approve(store, old)).toMatchObject({ ok: false, code: 'stale' });
    expect(readIndexFile(temp.paths).entries[0]).toEqual(now);
  });
});

describe('concurrency and limits (acceptance 12)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  function expectConsistent(): void {
    const index = readIndexFile(temp.paths);
    const blobs = fs.readdirSync(temp.paths.blobsDir(WS)).sort();
    expect(blobs).toEqual(index.entries.map((entry) => `${entry.blob}.md`).sort());
    for (const entry of index.entries) {
      const bytes = fs.readFileSync(temp.paths.blobFile(WS, entry.blob));
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.size);
    }
  }

  it('lets concurrent approvals fill the 5 MiB total and no further', async () => {
    seedEntries(temp.paths, 78, 65536); // 5 111 808 bytes: room for exactly two more
    const store = singleStore(temp.paths);
    await store.writeSettings(WS, { operatorConfirm: false });
    const made = [];
    for (let i = 0; i < 10; i++) {
      made.push(await submitCreate(store, `Big ${i}`, String(i).repeat(65536), proposer(1 + i)));
    }
    const results = await Promise.all(made.map((p) => approve(store, p)));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(2);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'quota')).toBe(true);
    expect(ok.map((r) => (r.ok ? r.kbVersion : 0))).toEqual([79, 80]);
    const index = readIndexFile(temp.paths);
    expect(index.kbVersion).toBe(80);
    expect(index.entries.reduce((sum, e) => sum + e.size, 0)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expectConsistent();
    for (const [i, p] of made.entries()) {
      expect(proposalFile(temp, p.id).state).toBe(results[i].ok ? 'approved' : 'pending');
    }
  }, 60_000);

  it('refuses the 501st entry', async () => {
    seedEntries(temp.paths, 500, 1);
    const store = singleStore(temp.paths);
    const p = await submitCreate(store, 'Number 501', 'x');
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'quota' });
    expect(readIndexFile(temp.paths).entries).toHaveLength(500);
    expect(proposalFile(temp, p.id).state).toBe('pending');
  }, 60_000);

  it('commits only one of two concurrent creates with the same title', async () => {
    const store = singleStore(temp.paths);
    const a = await submitCreate(store, 'Same', 'a', proposer(1));
    const b = await submitCreate(store, 'same', 'b', proposer(2));
    const results = await Promise.all([approve(store, a), approve(store, b)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'conflict' });
    expect(readIndexFile(temp.paths).entries).toHaveLength(1);
    expectConsistent();
  });

  it('lets only one of a concurrent approve and operator decision win', async () => {
    const store = singleStore(temp.paths);
    const p = await submitCreate(store, 'Race', 'x');
    const results = await Promise.all([approve(store, p), operator(store, p, 'reject')]);
    expect(results.filter((r) => r.ok && !('repeated' in r))).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === 'state')).toHaveLength(1);
  });
});

describe('high impact and operator confirmation (acceptance 13)', () => {
  let temp: TempHome;
  let store: KbStore;
  let entries: { id: string }[];
  beforeEach(() => {
    temp = useTempHome();
    entries = seedEntries(temp.paths, 2, 8);
    store = singleStore(temp.paths);
  });
  afterEach(() => temp.restore());

  it('with confirmation on, holds replace, delete and >16384-byte creates for the operator', async () => {
    const before = readIndexFile(temp.paths);
    const replace = await submitReplace(store, entries[0].id, 'replacement', 1);
    const removal = await submitDelete(store, entries[1].id, 2);
    const big = await submitCreate(store, 'Big', 'x'.repeat(16385), proposer(3));
    for (const p of [replace, removal, big]) {
      expect(await approve(store, p)).toEqual({ ok: true, state: 'pending_operator' });
    }
    expect(readIndexFile(temp.paths)).toEqual(before);
    const exact = await submitCreate(
      store,
      'Exactly at the threshold',
      'x'.repeat(16384),
      proposer(4),
    );
    expect(await approve(store, exact)).toMatchObject({
      ok: true,
      state: 'approved',
      kbVersion: 3,
    });
    for (const p of [replace, removal, big]) {
      expect(await operator(store, p, 'confirm')).toMatchObject({ ok: true, state: 'approved' });
    }
    const after = readIndexFile(temp.paths);
    expect(after.kbVersion).toBe(6);
    expect(after.entries.map((e) => e.id)).not.toContain(entries[1].id);
    expect(await store.readEntry(WS, entries[0].id)).toMatchObject({ content: 'replacement' });
  });

  it('with confirmation off, commits high-impact proposals directly', async () => {
    await store.writeSettings(WS, { operatorConfirm: false });
    const replace = await submitReplace(store, entries[0].id, 'direct', 1);
    expect(await approve(store, replace)).toMatchObject({
      ok: true,
      state: 'approved',
      kbVersion: 3,
    });
    const big = await submitCreate(store, 'Big direct', 'y'.repeat(20000), proposer(2));
    expect(await approve(store, big)).toMatchObject({ ok: true, state: 'approved', kbVersion: 4 });
  });
});

describe('voidWorkspaceProposals (acceptance 20)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('voids pending and pending_operator only, audited, leaving terminal files as they are', async () => {
    const [entry] = seedEntries(temp.paths, 1, 8);
    const store = singleStore(temp.paths);
    const pending = await submitCreate(store, 'Pending', 'x', proposer(1));
    const held = await submitReplace(store, entry.id, 'held', 2);
    await approve(store, held);
    const approved = await submitCreate(store, 'Approved', 'x', proposer(3));
    await approve(store, approved);
    const rejected = await submitCreate(store, 'Rejected', 'x', proposer(4));
    await reject(store, rejected);
    const terminalBytes = [approved, rejected].map((p) =>
      fs.readFileSync(temp.paths.proposalFile(WS, p.id), 'utf-8'),
    );

    expect(await store.voidWorkspaceProposals(WS, 'bogus reason')).toMatchObject({
      code: 'invalid',
    });
    expect(await store.voidWorkspaceProposals(WS, 'workspace_removed')).toEqual({
      ok: true,
      voided: 2,
    });
    expect(proposalFile(temp, pending.id)).toMatchObject({ state: 'voided', decidedBy: 'system' });
    expect(proposalFile(temp, pending.id).content).toBeUndefined();
    expect(proposalFile(temp, held.id).state).toBe('voided');
    expect(
      [approved, rejected].map((p) => fs.readFileSync(temp.paths.proposalFile(WS, p.id), 'utf-8')),
    ).toEqual(terminalBytes);
    const voided = auditLines(temp.paths).filter((line) => line.event === 'proposal_voided');
    expect(voided.map((line) => line.proposalId).sort()).toEqual([pending.id, held.id].sort());
    expect(
      voided.every((line) => (line.detail as { reason: string }).reason === 'workspace_removed'),
    ).toBe(true);
    expect(await store.voidWorkspaceProposals(WS, 'workspace_removed')).toEqual({
      ok: true,
      voided: 0,
    });
  });

  it('does nothing for a workspace that was never created', async () => {
    const store = singleStore(temp.paths);
    expect(await store.voidWorkspaceProposals(WS, 'workspace_removed')).toEqual({
      ok: true,
      voided: 0,
    });
    expect(fs.existsSync(temp.kbRoot)).toBe(false);
  });
});
