import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type KbStore, kbStore } from '../src/kbStore.js';
import {
  approve,
  auditLines,
  makeWorkspaceDirs,
  mode,
  OTHER_WS,
  Processes,
  proposer,
  readIndexFile,
  seedEntries,
  singleStore,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DIGEST = 'a'.repeat(64);

function mkfifo(p: string): void {
  const result = spawnSync('mkfifo', [p]);
  if (result.status !== 0) throw new Error('mkfifo failed');
}

/** Every file under `dir`, relative, with its bytes (for "nothing changed"). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, name);
    const stats = fs.lstatSync(full);
    if (stats.isFile()) out.set(name, fs.readFileSync(full).toString('base64'));
    else out.set(name, stats.isDirectory() ? 'dir' : 'other');
  }
  return out;
}

describe('KB ids (acceptance 2)', () => {
  let temp: TempHome;
  let store: KbStore;
  beforeEach(() => {
    temp = useTempHome();
    store = singleStore(temp.paths);
  });
  afterEach(() => temp.restore());

  const BAD_IDS: unknown[] = [
    '../x',
    '..',
    'a/b',
    '',
    UUID.toUpperCase(),
    42,
    null,
    {},
    'a\0b',
    `../${OTHER_WS}/proposals/${UUID}`,
    'Default',
    `${UUID}.json`,
  ];

  it('refuses every malformed workspace, proposal and entry id, touching nothing', async () => {
    const outside = snapshot(temp.home);
    for (const bad of BAD_IDS) {
      const label = JSON.stringify(bad);
      expect(await store.readSettings(bad), label).toMatchObject({ ok: false, code: 'invalid' });
      expect(await store.writeSettings(bad, { kbEnabled: true }), label).toMatchObject({
        code: 'invalid',
      });
      expect(await store.listEntries(bad), label).toMatchObject({ code: 'invalid' });
      expect(await store.listProposals(bad), label).toMatchObject({ code: 'invalid' });
      expect(await store.verifyAudit(bad), label).toMatchObject({ code: 'invalid' });
      expect(await store.sweepOrphanBlobs(bad), label).toMatchObject({ code: 'invalid' });
      expect(await store.voidWorkspaceProposals(bad, 'workspace_removed'), label).toMatchObject({
        code: 'invalid',
      });
      expect(
        await store.submitProposal(bad, {
          kind: 'create',
          title: 't',
          content: 'c',
          proposer: proposer(),
        }),
        label,
      ).toMatchObject({ code: 'invalid' });
      expect(await store.readEntry(WS, bad), label).toMatchObject({ code: 'invalid' });
      expect(await store.readProposal(WS, bad), label).toMatchObject({ code: 'invalid' });
      expect(
        await store.decideProposal(WS, bad, {
          action: 'approve',
          digest: DIGEST,
          actor: proposer(),
        }),
        label,
      ).toMatchObject({ code: 'invalid' });
      expect(
        await store.operatorDecide(WS, bad, { action: 'confirm', digest: DIGEST }),
        label,
      ).toMatchObject({ code: 'invalid' });
      for (const kind of ['replace', 'delete']) {
        expect(
          await store.submitProposal(WS, {
            kind,
            targetEntryId: bad,
            content: kind === 'replace' ? 'c' : undefined,
            proposer: proposer(),
          }),
          label,
        ).toMatchObject({ code: 'invalid' });
      }
    }
    // Only the 'default' workspace may have been created (by the WS-scoped calls,
    // which refused before writing anything at all).
    expect(snapshot(temp.home)).toEqual(outside);
  });

  it("accepts 'default' and a lowercase UUID, and keeps workspaces apart", async () => {
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
    expect(await store.writeSettings(OTHER_WS, { kbEnabled: true })).toMatchObject({ ok: true });
    expect(fs.existsSync(temp.paths.settingsFile(WS))).toBe(true);
    expect(fs.existsSync(temp.paths.settingsFile(OTHER_WS))).toBe(true);
    const p = await submitCreate(store, 'Only here', 'body');
    expect(await store.readProposal(WS, p.id)).toMatchObject({ ok: true });
    expect(await store.readProposal(OTHER_WS, p.id)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await approve(store, p, OTHER_WS)).toMatchObject({ ok: false, code: 'not_found' });
    const workspaces = fs.readdirSync(temp.kbRoot).filter((name) => !name.startsWith('.lock.'));
    expect(workspaces.sort()).toEqual([WS, OTHER_WS].sort());
  });
});

describe('the process store and list filters', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('kbStore() is one store per KB root, under the current HOME', () => {
    const store = kbStore();
    expect(kbStore()).toBe(store);
    expect(store.paths.root).toBe(temp.kbRoot);
  });

  it('refuses an unknown state or a malformed proposer filter', async () => {
    const store = singleStore(temp.paths);
    for (const filter of [
      { state: 'done' },
      { state: 1 },
      { proposerKey: '\uD800' },
      { other: 1 },
      'x',
    ]) {
      expect(await store.listProposals(WS, filter), JSON.stringify(filter)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    const p = await submitCreate(store, 'Filtered', 'x', proposer(7));
    const byState = await store.listProposals(WS, { state: 'pending' });
    expect(byState.ok && byState.proposals.map((x) => x.id)).toEqual([p.id]);
    expect(byState.ok && 'content' in byState.proposals[0]).toBe(false);
    const byProposer = await store.listProposals(WS, { proposerKey: `${proposer(7).instance}:7` });
    expect(byProposer.ok && byProposer.proposals).toHaveLength(1);
    const none = await store.listProposals(WS, { proposerKey: `${proposer(7).instance}:8` });
    expect(none.ok && none.proposals).toHaveLength(0);
  });
});

describe('KB directories and modes (acceptance 3)', () => {
  let temp: TempHome;
  let store: KbStore;
  beforeEach(() => {
    temp = useTempHome();
    store = singleStore(temp.paths);
  });
  afterEach(() => temp.restore());

  it('creates every level 0700 and every file 0600', async () => {
    await store.writeSettings(WS, { operatorConfirm: false });
    const p = await submitCreate(store, 'Modes', 'content');
    expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
    for (const dir of [
      temp.kbRoot,
      temp.paths.workspaceDir(WS),
      temp.paths.blobsDir(WS),
      temp.paths.proposalsDir(WS),
    ]) {
      expect(mode(dir), dir).toBe(0o700);
    }
    const index = readIndexFile(temp.paths);
    for (const file of [
      temp.paths.settingsFile(WS),
      temp.paths.indexFile(WS),
      temp.paths.auditFile(WS),
      temp.paths.proposalFile(WS, p.id),
      temp.paths.blobFile(WS, index.entries[0].blob),
    ]) {
      expect(mode(file), file).toBe(0o600);
    }
  });

  it('refuses a kb or workspace directory that is a symlink, writing nothing through it', async () => {
    const elsewhere = path.join(temp.home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(path.dirname(temp.kbRoot), { recursive: true });
    fs.symlinkSync(elsewhere, temp.kbRoot);
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
      ok: false,
      code: 'unsafe_storage',
    });
    expect(await store.readSettings(WS)).toMatchObject({ ok: false, code: 'unsafe_storage' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);

    fs.unlinkSync(temp.kbRoot);
    fs.mkdirSync(temp.kbRoot, { mode: 0o700 });
    fs.symlinkSync(elsewhere, temp.paths.workspaceDir(WS));
    expect(await submitCreate(store, 't', 'c').catch((e: Error) => e.message)).toBe(
      'submit failed: unsafe_storage',
    );
    expect(await store.listEntries(WS)).toMatchObject({ ok: false, code: 'unsafe_storage' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses directories with the wrong mode or owner, without fixing them', async () => {
    makeWorkspaceDirs(temp.paths);
    fs.chmodSync(temp.paths.blobsDir(WS), 0o755);
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
      code: 'unsafe_storage',
    });
    expect(await store.listEntries(WS)).toMatchObject({ code: 'unsafe_storage' });
    expect(mode(temp.paths.blobsDir(WS))).toBe(0o755);
    expect(fs.existsSync(temp.paths.settingsFile(WS))).toBe(false);

    fs.chmodSync(temp.paths.blobsDir(WS), 0o700);
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
      code: 'unsafe_storage',
    });
    expect(await store.readSettings(WS)).toMatchObject({ code: 'unsafe_storage' });
    expect(fs.existsSync(temp.paths.settingsFile(WS))).toBe(false);
  });

  it('answers unsafe_storage on win32 (simulated), creating nothing', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
        code: 'unsafe_storage',
      });
      expect(await store.readSettings(WS)).toMatchObject({ code: 'unsafe_storage' });
      expect(await store.listEntries(WS)).toMatchObject({ code: 'unsafe_storage' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(fs.existsSync(path.join(temp.home, '.pixel-agents'))).toBe(false);
  });
});

describe('KB settings (acceptance 4)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('reads safe values from a missing file without creating anything', async () => {
    const store = singleStore(temp.paths);
    expect(await store.readSettings(WS)).toEqual({
      ok: true,
      settings: { kbEnabled: false, operatorConfirm: true },
      state: 'absent',
    });
    expect(fs.existsSync(path.join(temp.home, '.pixel-agents'))).toBe(false);
    makeWorkspaceDirs(temp.paths);
    expect(await store.readSettings(WS)).toMatchObject({ state: 'absent' });
    expect(fs.readdirSync(temp.paths.workspaceDir(WS)).sort()).toEqual(['blobs', 'proposals']);
  });

  it('fills missing fields with safe values', async () => {
    makeWorkspaceDirs(temp.paths);
    fs.writeFileSync(temp.paths.settingsFile(WS), '{"version":1,"kbEnabled":true}', {
      mode: 0o600,
    });
    const store = singleStore(temp.paths);
    expect(await store.readSettings(WS)).toEqual({
      ok: true,
      settings: { kbEnabled: true, operatorConfirm: true },
      state: 'ok',
    });
    expect(await store.writeSettings(WS, { operatorConfirm: false })).toEqual({
      ok: true,
      settings: { kbEnabled: true, operatorConfirm: false },
    });
  });

  it('treats a malformed file as safe values, and never overwrites it', async () => {
    makeWorkspaceDirs(temp.paths);
    const store = singleStore(temp.paths);
    for (const text of [
      '{ not json',
      '[]',
      '{"kbEnabled":"yes"}',
      '{"version":2}',
      '{"version":1,"extra":true}',
      '"string"',
      `{"kbEnabled":true,"pad":"${'x'.repeat(5000)}"}`,
    ]) {
      fs.writeFileSync(temp.paths.settingsFile(WS), text, { mode: 0o600 });
      expect(await store.readSettings(WS), text).toEqual({
        ok: true,
        settings: { kbEnabled: false, operatorConfirm: true },
        state: 'corrupt',
      });
      expect(await store.writeSettings(WS, { kbEnabled: true }), text).toMatchObject({
        ok: false,
        code: 'corrupt_settings',
      });
      expect(fs.readFileSync(temp.paths.settingsFile(WS), 'utf-8')).toBe(text);
    }
  });

  it('accepts only known keys with boolean values', async () => {
    const store = singleStore(temp.paths);
    for (const patch of [
      { other: true },
      { kbEnabled: 'true' },
      { operatorConfirm: 1 },
      {},
      null,
      [],
      'kbEnabled',
      { kbEnabled: true, version: 1 },
    ]) {
      expect(await store.writeSettings(WS, patch), JSON.stringify(patch)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    expect(fs.existsSync(temp.paths.settingsFile(WS))).toBe(false);
  });

  it('refuses the change with io when its audit line cannot be written', async () => {
    let failAudit = false;
    const store = singleStore(temp.paths, {
      hooks: {
        auditAppend: () => {
          if (failAudit) throw Object.assign(new Error('injected'), { code: 'EIO' });
        },
      },
    });
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
    const before = fs.readFileSync(temp.paths.settingsFile(WS), 'utf-8');
    failAudit = true;
    expect(await store.writeSettings(WS, { kbEnabled: false })).toMatchObject({
      ok: false,
      code: 'io',
    });
    expect(fs.readFileSync(temp.paths.settingsFile(WS), 'utf-8')).toBe(before);
    expect(auditLines(temp.paths).filter((l) => l.event === 'settings_changed')).toHaveLength(1);
  });
});

describe('KB index corruption (acceptance 5)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  function variants(): { name: string; text: string }[] {
    const entries = seedEntries(temp.paths, 2, 8);
    const good = readIndexFile(temp.paths);
    const withEntries = (list: unknown[]) => JSON.stringify({ ...good, entries: list });
    return [
      { name: 'not JSON', text: '{ nope' },
      { name: 'wrong structure', text: JSON.stringify({ version: 1, entries: [] }) },
      { name: 'extra key', text: JSON.stringify({ ...good, extra: 1 }) },
      { name: 'blob with ../', text: withEntries([{ ...entries[0], blob: '../x' }, entries[1]]) },
      {
        name: 'duplicate id',
        text: withEntries([entries[0], { ...entries[1], id: entries[0].id }]),
      },
      {
        name: 'duplicate blob reference',
        text: withEntries([entries[0], { ...entries[1], blob: entries[0].blob }]),
      },
      {
        name: 'duplicate titleKey',
        text: withEntries([
          { ...entries[0], title: 'Same', titleKey: 'same' },
          { ...entries[1], title: 'same', titleKey: 'same' },
        ]),
      },
      {
        name: 'titleKey not matching its title',
        text: withEntries([{ ...entries[0], titleKey: 'forged' }, entries[1]]),
      },
      {
        name: 'size over the cap',
        text: withEntries([{ ...entries[0], size: 70000 }, entries[1]]),
      },
    ];
  }

  it('answers corrupt_index for reads, refuses writes and sweeps, and leaves every byte', async () => {
    const store = singleStore(temp.paths);
    for (const variant of variants()) {
      fs.writeFileSync(temp.paths.indexFile(WS), variant.text, { mode: 0o600 });
      const blobsBefore = fs.readdirSync(temp.paths.blobsDir(WS)).sort();
      expect(blobsBefore).toHaveLength(2);
      const label = variant.name;
      expect(await store.listEntries(WS), label).toMatchObject({ code: 'corrupt_index' });
      expect(await store.readEntry(WS, UUID), label).toMatchObject({ code: 'corrupt_index' });
      expect(
        await store.submitProposal(WS, {
          kind: 'create',
          title: 't',
          content: 'c',
          proposer: proposer(),
        }),
        label,
      ).toMatchObject({ code: 'corrupt_index' });
      expect(await store.sweepOrphanBlobs(WS), label).toMatchObject({ code: 'corrupt_index' });
      expect(fs.readFileSync(temp.paths.indexFile(WS), 'utf-8'), label).toBe(variant.text);
      expect(fs.readdirSync(temp.paths.blobsDir(WS)).sort(), label).toEqual(blobsBefore);
      expect(fs.readdirSync(temp.paths.proposalsDir(WS)), label).toEqual([]);
    }
  });

  it('treats a missing index next to existing blobs as corrupt and never rebuilds it', async () => {
    seedEntries(temp.paths, 3, 8);
    fs.unlinkSync(temp.paths.indexFile(WS));
    const blobsBefore = fs.readdirSync(temp.paths.blobsDir(WS)).sort();
    const store = singleStore(temp.paths);
    expect(await store.listEntries(WS)).toMatchObject({ code: 'corrupt_index' });
    expect(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 't',
        content: 'c',
        proposer: proposer(),
      }),
    ).toMatchObject({ code: 'corrupt_index' });
    expect(await store.sweepOrphanBlobs(WS)).toMatchObject({ code: 'corrupt_index' });
    expect(fs.existsSync(temp.paths.indexFile(WS))).toBe(false);
    expect(fs.readdirSync(temp.paths.blobsDir(WS)).sort()).toEqual(blobsBefore);
  });
});

describe('KB read rules (acceptance 6)', () => {
  let temp: TempHome;
  let store: KbStore;
  beforeEach(async () => {
    temp = useTempHome();
    store = singleStore(temp.paths);
  });
  afterEach(() => temp.restore());

  async function withEntryAndProposal(): Promise<{
    blob: string;
    entryId: string;
    proposalId: string;
  }> {
    const p = await submitCreate(store, 'Read rules', 'content');
    expect(await approve(store, p)).toMatchObject({ ok: true, state: 'approved' });
    const pending = await submitCreate(store, 'Pending one', 'more', proposer(2));
    const index = readIndexFile(temp.paths);
    return { blob: index.entries[0].blob, entryId: index.entries[0].id, proposalId: pending.id };
  }

  for (const kind of ['fifo', 'symlink'] as const) {
    it(`never blocks or follows when a file is replaced by a ${kind}`, async () => {
      const { blob, entryId, proposalId } = await withEntryAndProposal();
      const decoy = path.join(temp.home, 'decoy');
      fs.writeFileSync(decoy, '{}');
      const swap = (target: string) => {
        fs.rmSync(target, { force: true });
        if (kind === 'fifo') mkfifo(target);
        else fs.symlinkSync(decoy, target);
      };

      swap(temp.paths.blobFile(WS, blob));
      expect(await store.readEntry(WS, entryId)).toMatchObject({ ok: false, code: 'tampered' });

      swap(temp.paths.proposalFile(WS, proposalId));
      expect(await store.readProposal(WS, proposalId)).toMatchObject({
        ok: false,
        code: 'tampered',
      });

      swap(temp.paths.settingsFile(WS));
      expect(await store.readSettings(WS)).toMatchObject({ ok: true, state: 'corrupt' });

      const indexCopy = fs.readFileSync(temp.paths.indexFile(WS));
      swap(temp.paths.indexFile(WS));
      expect(await store.listEntries(WS)).toMatchObject({ ok: false, code: 'corrupt_index' });
      fs.rmSync(temp.paths.indexFile(WS));
      fs.writeFileSync(temp.paths.indexFile(WS), indexCopy, { mode: 0o600 });

      fs.rmSync(temp.paths.settingsFile(WS), { force: true });
      swap(temp.paths.auditFile(WS));
      expect(await store.verifyAudit(WS)).toMatchObject({ ok: false, code: 'tampered' });
      expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
        ok: false,
        code: 'io',
      });
      expect(fs.readFileSync(decoy, 'utf-8')).toBe('{}');
    });
  }

  it('answers too_large past the caps', async () => {
    const { proposalId } = await withEntryAndProposal();
    fs.writeFileSync(temp.paths.proposalFile(WS, proposalId), ' '.repeat(160 * 1024 + 1));
    expect(await store.readProposal(WS, proposalId)).toMatchObject({ code: 'too_large' });
    fs.writeFileSync(temp.paths.indexFile(WS), ' '.repeat(1024 * 1024 + 1));
    expect(await store.listEntries(WS)).toMatchObject({ code: 'too_large' });
  });

  it('refuses a proposal file whose id, workspace or structure is off', async () => {
    const { proposalId } = await withEntryAndProposal();
    const file = temp.paths.proposalFile(WS, proposalId);
    const good = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const otherId = crypto.randomUUID();
    for (const bad of [
      { ...good, id: otherId },
      { ...good, workspaceId: OTHER_WS },
      { ...good, extra: true },
      { ...good, state: 'unknown' },
      { ...good, proposer: { ...(good.proposer as object), agentId: 0 } },
      { ...good, content: undefined },
      { ...good, decidedAt: new Date().toISOString() },
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      expect(await store.readProposal(WS, proposalId), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: 'tampered',
      });
    }
    // A file copied under another proposal's name is not that proposal.
    fs.writeFileSync(file, JSON.stringify(good));
    fs.copyFileSync(file, temp.paths.proposalFile(WS, otherId));
    expect(await store.readProposal(WS, otherId)).toMatchObject({ ok: false, code: 'tampered' });
  });
});

describe('tampering without the lock, and leaks (acceptance 18, 19)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('a reader without the lock answers tampered, returns no content, and writes no audit', async () => {
    const processes = new Processes(temp.paths);
    const writer = processes.spawn().store;
    const p = await submitCreate(writer, 'Secret title', 'secret content body');
    expect(await approve(writer, p)).toMatchObject({ ok: true });
    const reader = processes.spawn().store; // the writer is alive: never acquires
    const index = readIndexFile(temp.paths);
    fs.writeFileSync(temp.paths.blobFile(WS, index.entries[0].blob), 'secret content bodX');
    const auditBefore = fs.readFileSync(temp.paths.auditFile(WS));
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    const result = await reader.readEntry(WS, index.entries[0].id);
    expect(result).toMatchObject({ ok: false, code: 'tampered' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fs.readFileSync(temp.paths.auditFile(WS)).equals(auditBefore)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(temp.home);
      expect(line).not.toContain('secret');
      expect(line).not.toContain('Secret title');
    }
  });

  it('records tampering once per blob while holding the lock', async () => {
    const store = singleStore(temp.paths);
    const p = await submitCreate(store, 'Tamper me', 'original');
    await approve(store, p);
    const index = readIndexFile(temp.paths);
    fs.writeFileSync(temp.paths.blobFile(WS, index.entries[0].blob), 'originaX');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 3; i++) {
      const result = await store.readEntry(WS, index.entries[0].id);
      expect(result).toEqual({ ok: false, code: 'tampered', reason: expect.any(String) });
    }
    const tampered = auditLines(temp.paths).filter((line) => line.event === 'tampered');
    expect(tampered).toHaveLength(1);
    expect(tampered[0]).toMatchObject({ entryId: index.entries[0].id });
  });

  it('no failure result or log line carries content, titles or the HOME path', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    const store = singleStore(temp.paths);
    const results: unknown[] = [];
    results.push(await store.writeSettings(WS, { operatorConfirm: false }));
    const p = await submitCreate(store, 'Leaky Title', 'leaky content');
    results.push(await approve(store, p));
    results.push(await approve(store, { id: p.id, digest: DIGEST }));
    results.push(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 'leaky title',
        content: 'leaky dup',
        proposer: proposer(3),
      }),
    );
    results.push(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 'Leaky‮',
        content: 'leaky\u0000',
        proposer: proposer(3),
      }),
    );
    const index = readIndexFile(temp.paths);
    fs.writeFileSync(temp.paths.blobFile(WS, index.entries[0].blob), 'leaky contenX');
    results.push(await store.readEntry(WS, index.entries[0].id));
    fs.writeFileSync(temp.paths.indexFile(WS), '{ leaky');
    results.push(await store.listEntries(WS));
    for (const result of results.filter((r) => !(r as { ok: boolean }).ok)) {
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/leaky/i);
      expect(text).not.toContain(temp.home);
    }
    expect(results.filter((r) => !(r as { ok: boolean }).ok).length).toBeGreaterThanOrEqual(5);
    for (const line of logs) {
      expect(line).not.toMatch(/leaky/i);
      expect(line).not.toContain(temp.home);
    }
  });

  it('logs only the errno when mkdir fails with EACCES (the error message names HOME)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(
      Object.assign(new Error(`EACCES: permission denied, mkdir '${temp.kbRoot}'`), {
        code: 'EACCES',
      }),
    );
    const store = singleStore(temp.paths);
    const result = await store.writeSettings(WS, { kbEnabled: true });
    expect(result).toMatchObject({ ok: false, code: 'io' });
    expect(JSON.stringify(result)).not.toContain(temp.home);
    expect(logs.join('\n')).toContain('EACCES');
    for (const line of logs) expect(line).not.toContain(temp.home);
  });
});

describe('sweepOrphanBlobs (acceptance 21)', () => {
  let temp: TempHome;
  beforeEach(() => {
    temp = useTempHome();
  });
  afterEach(() => temp.restore());

  it('removes only old, unreferenced, UUID-named plain files and old staging files', async () => {
    const [entry] = seedEntries(temp.paths, 1, 8);
    const store = singleStore(temp.paths);
    const blobs = temp.paths.blobsDir(WS);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const make = (name: string, age: Date | null) => {
      const p = path.join(blobs, name);
      fs.writeFileSync(p, 'x', { mode: 0o600 });
      if (age) fs.utimesSync(p, age, age);
      return p;
    };
    fs.utimesSync(temp.paths.blobFile(WS, entry.blob), old, old);
    const orphanOld = make(`${crypto.randomUUID()}.md`, old);
    const orphanYoung = make(`${crypto.randomUUID()}.md`, null);
    const notUuid = make('notes.md', old);
    const upper = make(`${crypto.randomUUID().toUpperCase()}.md`, old);
    const tmpOld = make(`${crypto.randomUUID()}.md.1234.${crypto.randomUUID()}.tmp`, old);
    const tmpYoung = make(`${crypto.randomUUID()}.md.1234.${crypto.randomUUID()}.tmp`, null);
    const strayTmp = make('random.tmp', old);
    const fifo = path.join(blobs, `${crypto.randomUUID()}.md`);
    mkfifo(fifo);
    fs.utimesSync(fifo, old, old);
    const outside = path.join(temp.home, 'outside.md');
    fs.writeFileSync(outside, 'keep');
    const link = path.join(blobs, `${crypto.randomUUID()}.md`);
    fs.symlinkSync(outside, link);
    fs.lutimesSync(link, old, old);
    const dir = path.join(blobs, `${crypto.randomUUID()}.md`);
    fs.mkdirSync(dir);
    fs.utimesSync(dir, old, old);

    expect(await store.sweepOrphanBlobs(WS)).toEqual({ ok: true, removed: 2 });
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(tmpOld)).toBe(false);
    for (const kept of [
      temp.paths.blobFile(WS, entry.blob),
      orphanYoung,
      notUuid,
      upper,
      tmpYoung,
      strayTmp,
      fifo,
      dir,
      outside,
    ]) {
      expect(fs.existsSync(kept), kept).toBe(true);
    }
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
