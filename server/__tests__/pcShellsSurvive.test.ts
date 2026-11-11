/**
 * PC shells are as durable as an agent's terminal and never die from editing
 * the office. Through the composed standalone server (as cli.ts composes and
 * restarts it), offices on /ws, the shell's terminal over its socket, real PTYs
 * running a real shell: with the PTY host a shell survives a server restart
 * under its id, its screen replayed; without it the shell ends with the
 * server; a saved shell whose terminal is gone is dropped; and neither its
 * piece leaving the layout nor its Directory being removed ends it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { readConfig, writeConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { RemotePtySessions } from '../src/terminal/remotePtySessions.js';
import {
  type Json,
  loadBundledAssets,
  seededLayout,
  seedLayoutFile,
  useStandaloneOffice,
  waitFor,
} from './helpers/officeMcpHarness.js';
import { FRONT_PC, OTHER_PC, pcShellDriver } from './helpers/pcShellDriver.js';

let catalog: Awaited<ReturnType<typeof loadBundledAssets>>['furniture']['catalog'] = [];
beforeAll(async () => {
  catalog = (await loadBundledAssets()).furniture.catalog;
});

/** A user Directory (config.json), mapped to the seeded layout's Blue room alone. */
function addDirectoryInBlueRoom(name: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = readConfig();
  cfg.directories = [...cfg.directories, { name, path: dir }];
  cfg.standalone.areaMappings = { [name]: ['Blue room'] };
  writeConfig(cfg);
}

/** The PC shells saved beside the agents (standalone-state.json). */
const savedShells = () => new FileStateAdapter({ namespace: 'standalone' }).loadPcShells();

const options = (name: string, ptyHost: boolean) => ({
  name,
  env: { SHELL: '/bin/sh' },
  layout: 'file' as const,
  catalog: () => catalog,
  prepare: ({ home }: { home: string }) => seedLayoutFile(home, seededLayout()),
  ptyHost,
});

describe('PC shells across a server restart, with the PTY host', () => {
  const h = useStandaloneOffice(options('pxl-pcs-host', true));
  const shells = pcShellDriver(h);

  it('come back under the same id, announced, with their screen', async () => {
    const mine = path.join(h.home, 'mine');
    addDirectoryInBlueRoom('mine', mine);
    const id = (await shells.open(FRONT_PC)).id as number;
    const announced = { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'mine' };
    // Saved beside the agents: the piece and the folder.
    expect(savedShells()).toEqual([{ ...announced, cwd: mine }]);
    const before = await shells.attach(id);
    before.type('echo BEFORE-$((40+2))\r');
    await before.waitFor(/BEFORE-42/);
    before.close();

    await h.restart();

    // The new server's first office lists it in its snapshot, as it was.
    expect(shells.shells()).toEqual([announced]);
    expect(h.pcShells.has(id)).toBe(true);
    // Its terminal replays the screen and still runs.
    const after = await shells.attach(id);
    await after.waitFor(/BEFORE-42/, 'the replayed screen');
    after.type('echo AFTER-$((6*7))\r');
    await after.waitFor(/AFTER-42/);

    // A new shell never takes a surviving shell's id (that would kill it).
    const next = (await shells.open(OTHER_PC)).id as number;
    expect(next).toBeGreaterThan(id);
    expect(h.pcShells.has(id)).toBe(true);
    expect(savedShells().map((s) => s.id)).toEqual([id, next]);
    after.close();
  });

  it('a shell that ended while no server ran is dropped: no card, nothing saved', async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    const pid = await waitFor(() => h.terminals.get(id)?.pid, 'the shell to start');

    await h.restart(async () => {
      process.kill(pid, 'SIGKILL');
      // Until the host has seen it go.
      await waitFor(async () => {
        const probe = await RemotePtySessions.connect({
          socketPath: path.join(h.home, 'h.sock'),
        });
        const gone = !probe.survivors().some((s) => s.agentId === id);
        await probe.shutdown();
        return gone;
      }, 'the PTY host to see the shell end');
    });

    expect(shells.shells()).toEqual([]);
    expect(h.pcShells.has(id)).toBe(false);
    expect(savedShells()).toEqual([]);
  });
});

describe('PC shells the PTY host kept without a saved record', () => {
  const h = useStandaloneOffice(options('pxl-pcs-orphan', true));
  const shells = pcShellDriver(h);

  it('come back as a card of their own (Home, no piece), and close from it', async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    await h.restart(() => {
      // The state file lost: the terminal still runs in the host.
      new FileStateAdapter({ namespace: 'standalone' }).savePcShells([]);
    });

    expect(shells.shells()).toEqual([{ id, uid: '', furnitureType: '' }]);
    expect(h.pcShells.has(id)).toBe(true);
    const term = await shells.attach(id);
    term.type('echo ORPHAN-$((40+2))\r');
    await term.waitFor(/ORPHAN-42/);

    shells.close(id, { confirmed: true });
    await waitFor(() => shells.shells()?.length === 0, 'the card gone');
    await waitFor(() => term.exited(), 'the shell ended');
    term.close();
  });
});

describe('PC shells across a server restart, in process (the shipped default)', () => {
  const h = useStandaloneOffice(options('pxl-pcs-inproc', false));
  const shells = pcShellDriver(h);

  it('end with the server and come back as nothing', async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    expect(savedShells().map((s) => s.id)).toEqual([id]);
    await h.restart();
    expect(shells.shells()).toEqual([]);
    expect(savedShells()).toEqual([]);
  });

  it('a saved shell with no terminal (a crash left it) is dropped at restore', async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    const saved = savedShells();
    await h.restart(() => {
      // What a crash leaves: the list as it was, the terminal gone with the process.
      new FileStateAdapter({ namespace: 'standalone' }).savePcShells(saved);
    });
    expect(shells.shells()).toEqual([]);
    expect(h.pcShells.has(id)).toBe(false);
    expect(savedShells()).toEqual([]);
  });
});

describe('PC shells outlive what they were opened from', () => {
  const h = useStandaloneOffice(options('pxl-pcs-edit', false));
  const shells = pcShellDriver(h);

  it('keep running, and their card, when their piece leaves the layout or their Directory goes', async () => {
    const mine = path.join(h.home, 'mine');
    addDirectoryInBlueRoom('mine', mine);
    const id = (await shells.open(FRONT_PC)).id as number;
    const announced = { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'mine' };
    const term = await shells.attach(id);

    // The PC deleted in the layout editor, and saved.
    const layout = seededLayout();
    layout.furniture = (layout.furniture as Json[]).filter((f) => f.uid !== FRONT_PC);
    h.send({ type: 'saveLayout', layout });
    // The shell's Directory removed.
    const before = h.received.length;
    h.send({ type: 'removeDirectory', path: mine });
    await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'directoriesLoaded'),
      'the Directory removed',
    );
    expect(readConfig().directories.some((d) => d.name === 'mine')).toBe(false);

    // Still running, and still announced as it was: a new office's snapshot too.
    term.type('echo STILL-$((40+2))\r');
    await term.waitFor(/STILL-42/);
    expect(shells.shells()).toEqual([announced]);
    const late = await h.connectOffice();
    expect(shells.shells(late.received)).toEqual([announced]);
    // Opening its piece's uid again answers with it, not a refusal.
    expect(await shells.open(FRONT_PC)).toEqual({ type: 'pcShellReady', id });
    term.close();
  });
});
