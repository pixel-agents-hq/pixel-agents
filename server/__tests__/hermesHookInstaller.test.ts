import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

let tempHome: string;

const fsyncControl = vi.hoisted(() => ({ afterSync: undefined as (() => void) | undefined }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      actual.fsyncSync(fd);
      fsyncControl.afterSync?.();
    },
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

const { areHooksInstalled, installHooks, uninstallHooks } =
  await import('../src/providers/hook/hermes/hermesHookInstaller.js');

describe('Hermes hook installer', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-hermes-test-'));
    process.env['HERMES_HOME'] = path.join(tempHome, 'hermes-home');
  });

  afterEach(() => {
    fsyncControl.afterSync = undefined;
    delete process.env['HERMES_HOME'];
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('preserves comments and unrelated targets, creates one backup, and uninstalls only owned entries', async () => {
    const configPath = path.join(process.env['HERMES_HOME']!, 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const source = [
      '# user comment',
      'model: test',
      'hooks:',
      '  outbound:',
      '    # keep this target',
      '    - name: user-target',
      '      url: https://example.test/hook',
      '      events: [on_session_start]',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, source, { mode: 0o640 });

    await installHooks('http://127.0.0.1:43123', 'local-secret');
    const installed = fs.readFileSync(configPath, 'utf8');
    expect(installed).toContain('# user comment');
    expect(installed).toContain('# keep this target');
    expect(installed).toContain('user-target');
    expect(await areHooksInstalled()).toBe(true);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(`${configPath}.pixel-agents.backup`, 'utf8')).toBe(source);

    const firstInstall = installed;
    await installHooks('http://127.0.0.1:43123', 'local-secret');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(firstInstall);

    await uninstallHooks();
    const value = parse(fs.readFileSync(configPath, 'utf8')) as {
      hooks: { outbound: Array<{ name: string }> };
    };
    expect(value.hooks.outbound).toEqual([expect.objectContaining({ name: 'user-target' })]);
    expect(await areHooksInstalled()).toBe(false);
  });

  it('fans out to live server registry entries and rejects automatic non-loopback setup', async () => {
    const registry = path.join(tempHome, '.pixel-agents', 'servers');
    fs.mkdirSync(registry, { recursive: true });
    for (const [port, token] of [
      [41001, 'one'],
      [41002, 'two'],
    ] as const) {
      fs.writeFileSync(
        path.join(registry, `${port}.json`),
        JSON.stringify({ pid: process.pid, port, token }),
      );
    }
    await installHooks('http://127.0.0.1:49999', 'fallback');
    const value = parse(
      fs.readFileSync(path.join(process.env['HERMES_HOME']!, 'config.yaml'), 'utf8'),
    ) as { hooks: { outbound: Array<{ url: string; secret: string }> } };
    expect(value.hooks.outbound.map((target) => [target.url, target.secret])).toEqual([
      ['http://127.0.0.1:41001/api/hooks/hermes', 'one'],
      ['http://127.0.0.1:41002/api/hooks/hermes', 'two'],
    ]);
    await expect(installHooks('https://agents.example.com', 'secret')).rejects.toThrow(
      'restricted to loopback',
    );
  });

  it('refuses a config edit that lands after the temporary file is synced', async () => {
    const configPath = path.join(process.env['HERMES_HOME']!, 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model: before\n', { mode: 0o600 });
    let edited = false;
    fsyncControl.afterSync = () => {
      if (!edited) {
        edited = true;
        fs.writeFileSync(configPath, 'model: concurrent\n', { mode: 0o600 });
      }
    };

    await expect(installHooks('http://127.0.0.1:43123', 'local-secret')).rejects.toThrow(
      'changed during installation',
    );
    fsyncControl.afterSync = undefined;

    expect(fs.readFileSync(configPath, 'utf8')).toBe('model: concurrent\n');
    expect(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('does not follow a stale deterministic temporary-file symlink', async () => {
    const configPath = path.join(process.env['HERMES_HOME']!, 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model: before\n', { mode: 0o600 });
    const victimPath = path.join(tempHome, 'victim.txt');
    fs.writeFileSync(victimPath, 'leave me alone');
    const legacyTempPath = `${configPath}.pixel-agents.tmp`;
    fs.symlinkSync(victimPath, legacyTempPath);

    await installHooks('http://127.0.0.1:43123', 'local-secret');

    expect(fs.readFileSync(victimPath, 'utf8')).toBe('leave me alone');
    expect(fs.lstatSync(legacyTempPath).isSymbolicLink()).toBe(true);
    expect(await areHooksInstalled()).toBe(true);
  });
});
