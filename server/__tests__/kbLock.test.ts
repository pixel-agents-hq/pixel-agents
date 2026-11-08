import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KB_LOCK_TARGET_PATTERN } from '../src/constants.js';
import { isProcessAlive, type KbLockFs, KbWriterLock, lockGeneration } from '../src/kbLock.js';
import {
  approve,
  auditLines,
  deferred,
  makeWorkspaceDirs,
  observedLockFs,
  Processes,
  proposer,
  readIndexFile,
  submitCreate,
  type TempHome,
  useTempHome,
  WS,
} from './kbHarness.js';

function target(pid: number): string {
  return `kbwriter:${pid}:${crypto.randomUUID()}:1700000000000`;
}

function generationsOn(root: string): number[] {
  return fs
    .readdirSync(root)
    .map((name) => lockGeneration(name))
    .filter((g): g is number => g !== null)
    .sort((a, b) => a - b);
}

describe('the KB writer lock (acceptance 17)', () => {
  let temp: TempHome;
  let root: string;
  let processes: Processes;
  let violations: string[];
  let nextPid = 700_001;

  beforeEach(() => {
    temp = useTempHome();
    root = temp.kbRoot;
    makeWorkspaceDirs(temp.paths);
    processes = new Processes(temp.paths);
    violations = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    // (l) Across every scenario: nobody ever unlinked the highest generation.
    expect(violations).toEqual([]);
    temp.restore();
  });

  function lock(options: { fs?: KbLockFs; pid?: number } = {}): {
    pid: number;
    lock: KbWriterLock;
  } {
    const pid = options.pid ?? nextPid++;
    processes.alive.add(pid);
    return {
      pid,
      lock: new KbWriterLock(root, {
        pid,
        isProcessAlive: processes.isAlive,
        fs: options.fs ?? observedLockFs(root, { violations }),
      }),
    };
  }

  function plant(generation: number, pid: number, alive: boolean): string {
    if (alive) processes.alive.add(pid);
    const t = target(pid);
    fs.symlinkSync(t, path.join(root, `.lock.${generation}`));
    return t;
  }

  it('(a) with no generation, exactly one of N simultaneous processes acquires', async () => {
    const n = 6;
    let arrived = 0;
    const barrier = deferred();
    const contenders = Array.from({ length: n }, () => {
      let first = true;
      return lock({
        fs: observedLockFs(root, {
          violations,
          beforeReaddir: async () => {
            if (!first) return;
            first = false;
            if (++arrived === n) barrier.resolve();
            await barrier.promise;
          },
        }),
      });
    });
    const states = await Promise.all(contenders.map((c) => c.lock.acquire()));
    expect(states.filter((s) => s === 'held')).toHaveLength(1);
    expect(states.filter((s) => s === 'locked')).toHaveLength(n - 1);
    expect(generationsOn(root)).toEqual([1]);
  });

  it('(b) a live holder (alive, or EPERM) means locked, and no higher generation', async () => {
    plant(3, 4242, true);
    expect(await lock().lock.acquire()).toBe('locked');
    expect(generationsOn(root)).toEqual([3]);

    // EPERM: pid 1 exists but belongs to another user; the real check says alive.
    expect(isProcessAlive(1)).toBe(true);
    fs.unlinkSync(path.join(root, '.lock.3'));
    fs.symlinkSync(target(1), path.join(root, '.lock.3'));
    const real = new KbWriterLock(root, { fs: observedLockFs(root, { violations }) });
    expect(await real.acquire()).toBe('locked');
    expect(generationsOn(root)).toEqual([3]);
  });

  it('(c) over a dead holder, creates n+1, confirms, then clears lower generations', async () => {
    plant(1, 4001, false);
    plant(2, 4002, false);
    const { lock: l } = lock();
    expect(await l.acquire()).toBe('held');
    expect(generationsOn(root)).toEqual([3]);
    expect(fs.readlinkSync(path.join(root, '.lock.3'))).toMatch(KB_LOCK_TARGET_PATTERN);
    expect(await l.verifyHeld()).toBe(true);
    expect(await l.acquire()).toBe('held');
  });

  it('(d) two processes over the same dead holder: one wins, the KB shows one writer', async () => {
    plant(1, 4001, false);
    let atSymlink = 0;
    const barrier = deferred();
    const gate = () =>
      observedLockFs(root, {
        violations,
        beforeSymlink: async () => {
          if (++atSymlink === 2) barrier.resolve();
          await barrier.promise;
        },
      });
    const a = processes.spawn({ fs: gate() });
    const b = processes.spawn({ fs: gate() });
    const submit = (store: typeof a.store, title: string, agentId: number) =>
      store.submitProposal(WS, {
        kind: 'create',
        title,
        content: title,
        proposer: proposer(agentId),
      });
    const [ra, rb] = await Promise.all([
      submit(a.store, 'From A', 1),
      submit(b.store, 'From B', 2),
    ]);
    const winner = ra.ok ? a.store : b.store;
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect((ra.ok ? rb : ra) as { code: string }).toMatchObject({ code: 'locked' });
    expect(generationsOn(root)).toEqual([2]);
    const won = (ra.ok ? ra : rb) as { ok: true; proposal: { id: string; digest: string } };
    expect(await approve(winner, won.proposal)).toMatchObject({ ok: true });
    const loser = ra.ok ? b.store : a.store;
    expect(await loser.writeSettings(WS, { kbEnabled: true })).toMatchObject({ code: 'locked' });
    const index = readIndexFile(temp.paths);
    expect(index.entries.map((e) => e.title)).toEqual([ra.ok ? 'From A' : 'From B']);
    expect(auditLines(temp.paths).map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(await winner.verifyAudit(WS)).toEqual({ ok: true, lines: 4 });
  });

  it('(e) an unparseable highest generation is never taken over or removed', async () => {
    plant(1, 4001, false);
    const cases: { name: string; make: (p: string) => void }[] = [
      { name: 'a plain file', make: (p) => fs.writeFileSync(p, target(4002)) },
      { name: 'a directory', make: (p) => fs.mkdirSync(p) },
      { name: 'garbage target', make: (p) => fs.symlinkSync('garbage', p) },
      { name: 'pid 0', make: (p) => fs.symlinkSync(`kbwriter:0:${crypto.randomUUID()}:1`, p) },
      {
        name: 'upper-case instance',
        make: (p) => fs.symlinkSync(`kbwriter:5:${crypto.randomUUID().toUpperCase()}:1`, p),
      },
      { name: 'extra field', make: (p) => fs.symlinkSync(`${target(4003)}:x`, p) },
    ];
    for (const c of cases) {
      const p = path.join(root, '.lock.2');
      c.make(p);
      expect(await lock().lock.acquire(), c.name).toBe('locked');
      expect(fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink(), c.name).toBe(true);
      expect(generationsOn(root), c.name).toEqual([1, 2]);
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('(f) a generation is never observable half-written', async () => {
    const observed: string[] = [];
    const peek = (linkPath: string) => {
      try {
        observed.push(fs.readlinkSync(linkPath));
      } catch (err) {
        observed.push((err as NodeJS.ErrnoException).code ?? 'error');
      }
    };
    plant(1, 4001, false);
    const real = observedLockFs(root, { violations });
    const watching: KbLockFs = {
      ...real,
      symlink: async (t, linkPath) => {
        peek(linkPath);
        const pending = real.symlink(t, linkPath);
        peek(linkPath);
        await pending;
        peek(linkPath);
      },
    };
    const { lock: l } = lock({ fs: watching });
    expect(await l.acquire()).toBe('held');
    expect(observed.length).toBe(3);
    for (const value of observed) {
      expect(value === 'ENOENT' || KB_LOCK_TARGET_PATTERN.test(value), value).toBe(true);
    }
    expect(observed[observed.length - 1]).toMatch(KB_LOCK_TARGET_PATTERN);
  });

  it('(g) a higher generation appearing later stops the next write before any change', async () => {
    const holder = processes.spawn({ fs: observedLockFs(root, { violations }) });
    expect(await holder.store.writeSettings(WS, { kbEnabled: true })).toMatchObject({ ok: true });
    const p = await submitCreate(holder.store, 'Before', 'x');
    plant(2, 4999, true);
    const before = fs
      .readdirSync(temp.paths.workspaceDir(WS), { recursive: true })
      .map(String)
      .sort();
    const bytes = (f: string) => fs.readFileSync(f, 'utf-8');
    const audit = bytes(temp.paths.auditFile(WS));
    const settings = bytes(temp.paths.settingsFile(WS));
    expect(await holder.store.writeSettings(WS, { kbEnabled: false })).toMatchObject({
      code: 'locked',
    });
    expect(await approve(holder.store, p)).toMatchObject({ code: 'locked' });
    expect(await holder.store.sweepOrphanBlobs(WS)).toMatchObject({ code: 'locked' });
    expect(bytes(temp.paths.auditFile(WS))).toBe(audit);
    expect(bytes(temp.paths.settingsFile(WS))).toBe(settings);
    expect(
      fs.readdirSync(temp.paths.workspaceDir(WS), { recursive: true }).map(String).sort(),
    ).toEqual(before);
    expect(generationsOn(root)).toEqual([1, 2]);
  });

  it('(h) failing to clear lower generations does not affect holding', async () => {
    plant(1, 4001, false);
    const real = observedLockFs(root, { violations });
    const stubborn: KbLockFs = {
      ...real,
      unlink: async () => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' });
      },
    };
    const { lock: l } = lock({ fs: stubborn });
    expect(await l.acquire()).toBe('held');
    expect(generationsOn(root)).toEqual([1, 2]);
    expect(await l.verifyHeld()).toBe(true);
  });

  it('(i) a finished holder leaves its generation; the next process takes n+1, never back to 1', async () => {
    const first = lock();
    expect(await first.lock.acquire()).toBe('held');
    processes.kill(first.pid); // process exit: nothing is removed
    expect(generationsOn(root)).toEqual([1]);
    const second = lock();
    expect(await second.lock.acquire()).toBe('held');
    expect(generationsOn(root)).toEqual([2]);
    processes.kill(second.pid);
    expect(generationsOn(root)).toEqual([2]);
    const third = lock();
    expect(await third.lock.acquire()).toBe('held');
    expect(generationsOn(root)).toEqual([3]);
  });

  it('(j) ignores names that are not a generation (zero, leading zero, sign, > 12 digits)', async () => {
    const ignored = [
      '.lock.0',
      '.lock.01',
      '.lock.-1',
      '.lock.+1',
      '.lock.1234567890123',
      '.lock.1a',
      '.lock.',
    ];
    for (const name of ignored) {
      expect(lockGeneration(name), name).toBeNull();
      fs.symlinkSync(target(4242), path.join(root, name));
    }
    processes.alive.add(4242);
    expect(lockGeneration('.lock.999999999999')).toBe(999999999999);
    expect(await lock().lock.acquire()).toBe('held');
    expect(generationsOn(root)).toEqual([1]);
    for (const name of ignored)
      expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
  });

  describe("(k) the reviewer's interleaving", () => {
    it('X paused before its symlink resumes after Y finished and Z writes: X is locked', async () => {
      plant(1, 4001, false); // W, dead
      const xPaused = deferred();
      const xResume = deferred();
      const x = processes.spawn({
        instance: crypto.randomUUID(),
        fs: observedLockFs(root, {
          violations,
          beforeSymlink: async () => {
            xPaused.resolve();
            await xResume.promise;
          },
        }),
      });
      const xResult = x.store.submitProposal(WS, {
        kind: 'create',
        title: 'From X',
        content: 'x',
        proposer: proposer(1),
      });
      await xPaused.promise; // X has read the dead generation 1

      const y = processes.spawn({ fs: observedLockFs(root, { violations }) });
      const py = await submitCreate(y.store, 'From Y', 'y', proposer(2));
      expect(await approve(y.store, py)).toMatchObject({ ok: true });
      expect(generationsOn(root)).toEqual([2]);
      processes.kill(y.pid); // Y ends normally

      const z = processes.spawn({ fs: observedLockFs(root, { violations }) });
      const pz = await submitCreate(z.store, 'From Z', 'z', proposer(3));
      expect(generationsOn(root)).toEqual([3]);

      xResume.resolve();
      expect(await xResult).toMatchObject({ ok: false, code: 'locked' });
      expect(generationsOn(root)).toEqual([2, 3]); // X's late generation 2: lower, harmless

      expect(await approve(z.store, pz)).toMatchObject({ ok: true }); // Z still holds
      const index = readIndexFile(temp.paths);
      expect(index.entries.map((e) => e.title)).toEqual(['From Y', 'From Z']);
      const lines = auditLines(temp.paths);
      expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
      expect(lines.some((l) => (l.actor as { agentId?: number }).agentId === 1)).toBe(false);
      expect(await z.store.verifyAudit(WS)).toEqual({ ok: true, lines: lines.length });
    });

    it('X resuming after Y finished but before Z: X takes n+2 and Z is locked', async () => {
      plant(1, 4001, false);
      const xPaused = deferred();
      const xResume = deferred();
      let gated = true;
      const x = processes.spawn({
        fs: observedLockFs(root, {
          violations,
          beforeSymlink: async () => {
            if (!gated) return;
            gated = false;
            xPaused.resolve();
            await xResume.promise;
          },
        }),
      });
      const xResult = x.store.writeSettings(WS, { kbEnabled: true });
      await xPaused.promise;
      const y = processes.spawn({ fs: observedLockFs(root, { violations }) });
      expect(await y.store.writeSettings(WS, { operatorConfirm: false })).toMatchObject({
        ok: true,
      });
      processes.kill(y.pid);
      xResume.resolve();
      expect(await xResult).toMatchObject({ ok: true }); // EEXIST on 2, then 3 over dead Y
      expect(generationsOn(root)).toEqual([3]);
      const z = processes.spawn({ fs: observedLockFs(root, { violations }) });
      expect(await z.store.writeSettings(WS, { kbEnabled: false })).toMatchObject({
        code: 'locked',
      });
      const lines = auditLines(temp.paths);
      expect(lines.map((l) => l.seq)).toEqual([1, 2]);
      expect(await x.store.verifyAudit(WS)).toEqual({ ok: true, lines: 2 });
    });
  });

  it('(l) the highest generation survives confirmation failures and normal exits', async () => {
    plant(5, 4005, true);
    const loser = lock();
    expect(await loser.lock.acquire()).toBe('locked');
    processes.kill(loser.pid);
    expect(generationsOn(root)).toEqual([5]);
    processes.kill(4005);
    const holder = lock();
    expect(await holder.lock.acquire()).toBe('held');
    processes.kill(holder.pid);
    expect(generationsOn(root)).toEqual([6]);
    // A stale contender creating a generation below the highest never confirms.
    const stale = new KbWriterLock(root, {
      pid: nextPid++,
      isProcessAlive: () => false,
      fs: {
        ...observedLockFs(root, { violations }),
        readdir: (() => {
          let calls = 0;
          return async (dir: string) => {
            calls++;
            const names = await fs.promises.readdir(dir);
            // First look: pretend only generation 3 exists (an old view).
            return calls === 1 ? names.filter((n) => n !== '.lock.6').concat('.lock.3') : names;
          };
        })(),
        readlink: async (p: string) =>
          path.basename(p) === '.lock.3' ? target(4003) : fs.promises.readlink(p),
      },
    });
    expect(await stale.acquire()).toBe('locked');
    expect(generationsOn(root)).toEqual([4, 6]);
  });
});
