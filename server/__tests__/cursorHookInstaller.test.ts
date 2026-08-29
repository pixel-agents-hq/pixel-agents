import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks } =
  await import('../src/providers/hook/cursor/cursorHookInstaller.js');
const { CURSOR_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } =
  await import('../src/providers/hook/cursor/constants.js');

function hooksPathFor(): string {
  return path.join(tmpBase, '.cursor', 'hooks.json');
}

function readHooks(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(hooksPathFor(), 'utf-8'));
}

function ourCommand(): string {
  return `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'cursor-hook.js')}"`;
}

function allCommands(): string[] {
  const hooks = (readHooks().hooks ?? {}) as Record<string, Array<{ command?: string }>>;
  return Object.values(hooks).flatMap((entries) => entries.map((h) => h.command ?? ''));
}

describe('cursorHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cursor-hook-test-'));
    fs.mkdirSync(path.join(tmpBase, '.cursor'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('installHooks adds version 1 and one command per subscribed event', async () => {
    await installHooks();
    const file = readHooks();
    expect(file.version).toBe(1);
    const hooks = file.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    expect(allCommands().filter((c) => c === ourCommand())).toHaveLength(CURSOR_HOOK_EVENTS.length);
  });

  it('installHooks is idempotent', async () => {
    await installHooks();
    await installHooks();
    expect(allCommands().filter((c) => c === ourCommand())).toHaveLength(CURSOR_HOOK_EVENTS.length);
  });

  it('areHooksInstalled is false before install and true after', async () => {
    expect(areHooksInstalled()).toBe(false);
    await installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  it('areHooksInstalled is true for a partial install', () => {
    fs.writeFileSync(
      hooksPathFor(),
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: ourCommand(), timeout: 5 }] },
      }),
    );
    expect(areHooksInstalled()).toBe(true);
  });

  it('preserves unrelated keys and third-party hooks on install', async () => {
    const thirdParty = { command: 'node /elsewhere/other-tool.js' };
    fs.writeFileSync(
      hooksPathFor(),
      JSON.stringify({
        version: 1,
        extra: { keep: true },
        hooks: { afterFileEdit: [thirdParty], sessionStart: [thirdParty] },
      }),
    );

    await installHooks();

    const file = readHooks();
    expect(file.extra).toEqual({ keep: true });
    const hooks = file.hooks as Record<string, Array<{ command?: string }>>;
    expect(hooks.afterFileEdit).toEqual([thirdParty]);
    expect(hooks.sessionStart[0]).toEqual(thirdParty);
    expect(hooks.sessionStart.some((h) => h.command === ourCommand())).toBe(true);
  });

  it('never touches a third-party hook that happens to be named cursor-hook.js', async () => {
    const lookalike = { command: 'node /opt/other-tool/cursor-hook.js' };
    fs.writeFileSync(hooksPathFor(), JSON.stringify({ version: 1, hooks: { stop: [lookalike] } }));

    await installHooks();
    const stop = (readHooks().hooks as Record<string, unknown[]>)['stop'];
    expect(stop[0]).toEqual(lookalike);

    await uninstallHooks();
    expect((readHooks().hooks as Record<string, unknown[]>)['stop']).toEqual([lookalike]);
  });

  it('uninstallHooks removes only our commands', async () => {
    const thirdParty = { command: 'node /elsewhere/other-tool.js' };
    fs.writeFileSync(
      hooksPathFor(),
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [thirdParty] },
      }),
    );
    await installHooks();
    await uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
    const hooks = readHooks().hooks as Record<string, unknown[]>;
    expect(hooks.sessionStart).toEqual([thirdParty]);
  });

  it('leaves a malformed hooks.json byte-for-byte unchanged on install', async () => {
    const malformed = '{ "hooks": { "stop": [] }, }';
    fs.writeFileSync(hooksPathFor(), malformed);
    await expect(installHooks()).rejects.toThrow(/Couldn't parse/);
    expect(fs.readFileSync(hooksPathFor(), 'utf-8')).toBe(malformed);
    expect(fs.existsSync(hooksPathFor() + SETTINGS_BACKUP_SUFFIX)).toBe(false);
  });

  it('backs up hooks.json once before the first modification of user content', async () => {
    const original = JSON.stringify({ version: 1, extra: true, hooks: {} });
    fs.writeFileSync(hooksPathFor(), original);
    await installHooks();
    expect(fs.readFileSync(hooksPathFor() + SETTINGS_BACKUP_SUFFIX, 'utf-8')).toBe(original);
    await installHooks();
    expect(fs.readFileSync(hooksPathFor() + SETTINGS_BACKUP_SUFFIX, 'utf-8')).toBe(original);
  });
});
