import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KB_AUDIT_GENESIS_PREV } from '../src/kbAudit.js';
import { canonicalJson } from '../src/kbFiles.js';
import type { KbStore } from '../src/kbStore.js';
import { sha256Hex } from '../src/textSafety.js';
import {
  approve,
  auditLines,
  chainedAuditText,
  makeWorkspaceDirs,
  Processes,
  proposer,
  singleStore,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

function rawLines(temp: TempHome): string[] {
  return fs
    .readFileSync(temp.paths.auditFile(WS), 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('the audit log (acceptance 16)', () => {
  let temp: TempHome;
  let store: KbStore;
  beforeEach(() => {
    temp = useTempHome();
    store = singleStore(temp.paths);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => temp.restore());

  it('chains every line to the one before it', async () => {
    await store.writeSettings(WS, { operatorConfirm: false });
    const p = await submitCreate(store, 'Chained', 'body');
    await approve(store, p);
    const lines = auditLines(temp.paths);
    expect(lines.map((l) => l.event)).toEqual([
      'settings_changed',
      'proposal_submitted',
      'commit_started',
      'entry_created',
      'commit_done',
    ]);
    let prev = KB_AUDIT_GENESIS_PREV;
    lines.forEach((line, i) => {
      expect(line.seq).toBe(i + 1);
      expect(line.prev).toBe(prev);
      const { hash, ...base } = line;
      expect(sha256Hex(Buffer.from(prev + canonicalJson(base)))).toBe(hash);
      prev = hash as string;
    });
    expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 5 });
  });

  it('keeps 100 concurrent appends whole and in sequence', async () => {
    const submissions = Array.from({ length: 100 }, (_, i) =>
      store.submitProposal(WS, {
        kind: 'create',
        title: `Concurrent ${i}`,
        content: 'x',
        proposer: proposer(1 + (i % 5)),
      }),
    );
    const results = await Promise.all(submissions);
    expect(results.every((r) => r.ok)).toBe(true);
    const lines = rawLines(temp);
    expect(lines).toHaveLength(100);
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 100 });
  }, 60_000);

  it('reports a partial last line, cuts it before the next append, and the chain still verifies', async () => {
    await store.writeSettings(WS, { kbEnabled: true });
    await store.writeSettings(WS, { kbEnabled: false });
    fs.appendFileSync(temp.paths.auditFile(WS), '{"seq":3,"ts":"partial');
    expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 2, residual: true });
    expect(await store.listEntries(WS)).toMatchObject({ ok: true });

    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
    const text = fs.readFileSync(temp.paths.auditFile(WS), 'utf-8');
    expect(text).not.toContain('partial');
    expect(text.endsWith('\n')).toBe(true);
    expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 3 });
  });

  it('starts a new process from the tail behind a residual', async () => {
    const processes = new Processes(temp.paths);
    const first = processes.spawn();
    await first.store.writeSettings(WS, { kbEnabled: true });
    fs.appendFileSync(temp.paths.auditFile(WS), '{"broken');
    processes.kill(first.pid);
    const second = processes.spawn().store;
    expect(await second.writeSettings(WS, { kbEnabled: false })).toMatchObject({ ok: true });
    expect(await second.verifyAudit(WS)).toEqual({ ok: true, lines: 2 });
  });

  const tamperings: { name: string; edit: (line: string) => string }[] = [
    { name: 'a changed value', edit: (line) => line.replace('"operator"', '"agent"') },
    { name: 'a duplicate key', edit: (line) => line.replace('{"actor"', '{"seq":2,"actor"') },
    { name: 'extra whitespace', edit: (line) => line.replace('","', '", "') },
  ];
  for (const tampering of tamperings) {
    it(`reports brokenAt for ${tampering.name} in a middle line, and KB operations carry on`, async () => {
      for (let i = 0; i < 4; i++) await store.writeSettings(WS, { kbEnabled: i % 2 === 0 });
      const lines = rawLines(temp);
      const edited = tampering.edit(lines[1]);
      expect(edited).not.toBe(lines[1]);
      JSON.parse(edited); // still JSON: only the canonical check can catch it
      lines[1] = edited;
      fs.writeFileSync(temp.paths.auditFile(WS), `${lines.join('\n')}\n`);
      expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 1, brokenAt: 2 });
      expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
      const p = await submitCreate(store, 'Still works', 'x');
      expect(await approve(store, p)).toMatchObject({ ok: true });
    });
  }

  it('rotates past 4 MiB, continuing the chain into the new file', async () => {
    makeWorkspaceDirs(temp.paths);
    const text = chainedAuditText(4000, 'p'.repeat(900));
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
    fs.writeFileSync(temp.paths.auditFile(WS), text, { mode: 0o600 });
    const lastHash = (JSON.parse(text.trimEnd().split('\n').pop()!) as { hash: string }).hash;

    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
    const names = fs.readdirSync(temp.paths.workspaceDir(WS)).filter((n) => n.startsWith('audit'));
    expect(names.sort()).toEqual(['audit.1-4000.jsonl', 'audit.jsonl']);
    expect(
      fs.readFileSync(path.join(temp.paths.workspaceDir(WS), 'audit.1-4000.jsonl'), 'utf-8'),
    ).toBe(text);
    const fresh = auditLines(temp.paths);
    expect(fresh.map((l) => l.event)).toEqual(['audit_rotated', 'settings_changed']);
    expect(fresh[0]).toMatchObject({ seq: 4001, prev: lastHash });
    expect(await store.verifyAudit(WS)).toEqual({ ok: true, lines: 4002 });
    expect(
      fs.statSync(path.join(temp.paths.workspaceDir(WS), 'audit.1-4000.jsonl')).mode & 0o777,
    ).toBe(0o600);
  });

  it('refuses changes with quota once the audit total passes 32 MiB, deleting nothing', async () => {
    const p = await submitCreate(store, 'Before full', 'x');
    const archive = path.join(temp.paths.workspaceDir(WS), 'audit.1-99999.jsonl');
    fs.writeFileSync(archive, Buffer.alloc(32 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    // A restart (the first writer's pid is unknown, i.e. dead, to this set of
    // processes): the new process measures the total on its first change.
    store = new Processes(temp.paths).spawn().store;
    expect(await store.writeSettings(WS, { kbEnabled: true })).toMatchObject({
      ok: false,
      code: 'quota',
    });
    expect(
      await store.submitProposal(WS, {
        kind: 'create',
        title: 'Full',
        content: 'x',
        proposer: proposer(2),
      }),
    ).toMatchObject({ ok: false, code: 'quota' });
    expect(await approve(store, p)).toMatchObject({ ok: false, code: 'quota' });
    expect(await store.listEntries(WS)).toMatchObject({ ok: true });
    expect(fs.statSync(archive).size).toBe(32 * 1024 * 1024 + 1);
  });

  it('never records a title or content', async () => {
    await store.writeSettings(WS, { operatorConfirm: false });
    const p = await submitCreate(store, 'Distinctive Title Words', 'distinctive body words');
    await approve(store, p);
    await store.voidWorkspaceProposals(WS, 'workspace_removed');
    const text = fs.readFileSync(temp.paths.auditFile(WS), 'utf-8');
    expect(text).not.toMatch(/distinctive/i);
    for (const line of auditLines(temp.paths)) {
      const detailKeys = Object.keys(line.detail as object);
      for (const key of detailKeys) {
        expect(['sha256', 'size', 'oldSha256', 'oldSize', 'digest', 'kind', 'reason']).toContain(
          key,
        );
      }
    }
  });
});
