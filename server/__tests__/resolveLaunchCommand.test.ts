import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveLaunchCommand } from '../src/terminal/resolveLaunchCommand.js';

/**
 * Windows node-pty (both official and @lydell forks) does NOT resolve bare
 * command names through PATH: spawn('claude', …) throws `File not found: `
 * with an EMPTY path suffix. Providers hand us bare names because that is
 * what a real terminal would resolve; this suite pins the absolutisation.
 *
 * The whole suite runs against a fake PATH/PATHEXT env + real files in a temp
 * dir, and `platform` is passed explicitly (never monkeypatched) — the
 * documented convention for host-specific behaviour.
 */

describe('resolveLaunchCommand', () => {
  let tempDir: string;
  let binDir: string;
  let otherDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resolve-test-'));
    binDir = path.join(tempDir, 'bin');
    otherDir = path.join(tempDir, 'other');
    fs.mkdirSync(binDir);
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(binDir, 'claude.exe'), '');
    fs.writeFileSync(path.join(binDir, 'hermes.exe'), '');
    // A batch shim later on PATH than the exe: extension priority decides.
    fs.writeFileSync(path.join(otherDir, 'claude.cmd'), '@echo off\r\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function env(overrides: Record<string, string | undefined> = {}) {
    return {
      PATH: `${binDir}${path.delimiter}${otherDir}`,
      PATHEXT: '.EXE;.CMD;.BAT;.COM',
      ...overrides,
    };
  }

  it('absolutises a bare name to the first PATH hit (.exe wins over .cmd)', () => {
    const r = resolveLaunchCommand('claude', ['--session-id', 'x'], {
      platform: 'win32',
      env: env(),
    });
    expect(r.command).toBe(path.join(binDir, 'claude.exe'));
    expect(r.args).toEqual(['--session-id', 'x']);
  });

  it('wraps batch-only hits through cmd.exe with /d /c', () => {
    fs.rmSync(path.join(binDir, 'hermes.exe'));
    fs.writeFileSync(path.join(otherDir, 'hermes.bat'), '@echo off\r\n');
    const r = resolveLaunchCommand('hermes', ['chat'], {
      platform: 'win32',
      env: { ...env(), COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(r.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(r.args).toEqual(['/d', '/c', path.join(otherDir, 'hermes.bat'), 'chat']);
  });

  it('falls back to bare cmd.exe when COMSPEC is unset', () => {
    fs.rmSync(path.join(binDir, 'claude.exe'));
    const r = resolveLaunchCommand('claude', [], {
      platform: 'win32',
      env: { ...env(), COMSPEC: undefined },
    });
    expect(r.command).toBe('cmd.exe');
  });

  it('throws an actionable error when the name is nowhere on PATH', () => {
    expect(() => resolveLaunchCommand('nosuchcli', [], { platform: 'win32', env: env() })).toThrow(
      /nosuchcli.*not found on PATH/i,
    );
  });

  it('passes through anything with a path separator untouched', () => {
    const r = resolveLaunchCommand('C:\\tools\\claude.exe', ['a'], {
      platform: 'win32',
      env: env(),
    });
    expect(r.command).toBe('C:\\tools\\claude.exe');
    expect(r.args).toEqual(['a']);
  });

  it('is a pass-through on POSIX (posix_spawnp resolves PATH there)', () => {
    const r = resolveLaunchCommand('claude', ['--x'], { platform: 'linux', env: env() });
    expect(r.command).toBe('claude');
  });

  it('tolerates a missing PATH entirely (throws the actionable error, not a crash)', () => {
    expect(() =>
      resolveLaunchCommand('claude', [], { platform: 'win32', env: { PATH: undefined } }),
    ).toThrow(/not found on PATH/i);
  });

  it('skips PATH entries that are not directories without throwing', () => {
    const withFileEntry = {
      ...env(),
      PATH: `${path.join(tempDir, 'not-a-dir')}${path.delimiter}${binDir}`,
    };
    const r = resolveLaunchCommand('claude', [], { platform: 'win32', env: withFileEntry });
    expect(r.command).toBe(path.join(binDir, 'claude.exe'));
  });
});
