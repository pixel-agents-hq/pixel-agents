import { describe, expect, it } from 'vitest';

import type { ResolveLaunchDeps } from '../src/terminal/resolveExecutable.js';
import { resolveLaunchCommand } from '../src/terminal/resolveExecutable.js';

const ARGS = ['--session-id', 'abc-123'];

const CMD_EXE = 'C:\\Windows\\system32\\cmd.exe';

/** PATHEXT spelled in lower case so the resolved paths read naturally; the
 *  host's usual upper-case spelling is covered by its own test below. */
const WINDOWS_ENV: Record<string, string> = {
  Path: 'C:\\bin',
  PATHEXT: '.com;.exe;.bat;.cmd',
  ComSpec: CMD_EXE,
};

/** A Windows host whose filesystem holds exactly `files`. NTFS compares names
 *  case-insensitively, so the probe does too. */
function windows(files: string[], env: Record<string, string> = WINDOWS_ENV): ResolveLaunchDeps {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return {
    platform: 'win32',
    env,
    isFile: (filePath) => present.has(filePath.toLowerCase()),
  };
}

describe('resolveLaunchCommand off Windows', () => {
  it('passes the command through untouched, whatever PATH holds', () => {
    // Only Windows needs the lookup: POSIX node-pty execvp()s the name itself.
    const deps: ResolveLaunchDeps = {
      platform: 'linux',
      env: { PATH: '/usr/local/bin' },
      isFile: () => true,
    };
    expect(resolveLaunchCommand('claude', ARGS, deps)).toEqual({ file: 'claude', args: ARGS });
  });
});

describe('resolveLaunchCommand on Windows', () => {
  it('finds claude.exe through PATH and PATHEXT', () => {
    // The shipped bug: node-pty tries `C:\bin\claude` literally, never the .exe.
    const deps = windows(['C:\\bin\\claude.exe']);
    expect(resolveLaunchCommand('claude', ARGS, deps)).toEqual({
      file: 'C:\\bin\\claude.exe',
      args: ARGS,
    });
  });

  it('walks PATH in order', () => {
    const deps = windows(['C:\\first\\claude.exe', 'C:\\second\\claude.exe'], {
      ...WINDOWS_ENV,
      Path: 'C:\\first;C:\\second',
    });
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe('C:\\first\\claude.exe');
  });

  it('prefers the earlier PATHEXT extension within one directory', () => {
    // cmd.exe's rule: every extension is tried in a directory before moving on,
    // so a .exe beats a .cmd shim beside it even though .cmd comes later.
    const deps = windows(['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe']);
    expect(resolveLaunchCommand('claude', ARGS, deps)).toEqual({
      file: 'C:\\bin\\claude.exe',
      args: ARGS,
    });
  });

  it('runs a .cmd shim through cmd.exe with a pre-quoted command line', () => {
    // An npm global install. CreateProcess cannot run a batch file; the whole
    // command line rides as ONE string so node-pty does not re-quote it, and
    // `/s` makes cmd.exe strip exactly the outer quotes.
    const npmBin = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm';
    const deps = windows([`${npmBin}\\claude.cmd`], { ...WINDOWS_ENV, Path: npmBin });
    expect(resolveLaunchCommand('claude', ARGS, deps)).toEqual({
      file: CMD_EXE,
      args: `/d /s /c ""${npmBin}\\claude.cmd" --session-id abc-123"`,
    });
  });

  it('quotes an argument containing whitespace on the cmd.exe command line', () => {
    const deps = windows(['C:\\bin\\claude.cmd']);
    const resolved = resolveLaunchCommand('claude', ['--prompt', 'hello world'], deps);
    expect(resolved?.args).toBe('/d /s /c "C:\\bin\\claude.cmd --prompt "hello world""');
  });

  it('falls back to cmd.exe when the env has no ComSpec', () => {
    const { ComSpec: _dropped, ...env } = WINDOWS_ENV;
    const deps = windows(['C:\\bin\\claude.cmd'], env);
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe('cmd.exe');
  });

  it('uses an absolute path as given, without a PATH search', () => {
    const deps = windows([]);
    expect(resolveLaunchCommand('D:\\tools\\claude.exe', ARGS, deps)).toEqual({
      file: 'D:\\tools\\claude.exe',
      args: ARGS,
    });
  });

  it('still routes an absolute .bat path through cmd.exe', () => {
    const deps = windows([]);
    expect(resolveLaunchCommand('D:\\tools\\claude.bat', ARGS, deps)).toEqual({
      file: CMD_EXE,
      args: '/d /s /c "D:\\tools\\claude.bat --session-id abc-123"',
    });
  });

  it('returns null when nothing on PATH matches', () => {
    expect(resolveLaunchCommand('claude', ARGS, windows([]))).toBeNull();
  });

  it('never matches a bare extensionless file', () => {
    // A POSIX wrapper script beside nothing else: CreateProcess could not run
    // it, so reporting "not found" is the honest answer (cmd.exe agrees).
    expect(resolveLaunchCommand('claude', ARGS, windows(['C:\\bin\\claude']))).toBeNull();
  });

  it('matches PATHEXT extensions case-insensitively, keeping their spelling', () => {
    // The host's default spelling is upper case; the file on disk is not. NTFS
    // does not care, and neither does CreateProcess, so the candidate keeps
    // PATHEXT's spelling rather than guessing the on-disk one.
    const deps = windows(['C:\\bin\\claude.exe'], { ...WINDOWS_ENV, PATHEXT: '.COM;.EXE' });
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe('C:\\bin\\claude.EXE');
  });

  it('recognises a shell script whatever the case of its extension', () => {
    const deps = windows(['C:\\bin\\claude.CMD']);
    expect(resolveLaunchCommand('claude.CMD', ARGS, deps)?.file).toBe(CMD_EXE);
  });

  it('tries a name that already carries an extension as given first', () => {
    const deps = windows(['C:\\bin\\claude.exe']);
    expect(resolveLaunchCommand('claude.exe', ARGS, deps)?.file).toBe('C:\\bin\\claude.exe');
  });

  it("uses Windows' default PATHEXT when the env has none", () => {
    const { PATHEXT: _dropped, ...env } = WINDOWS_ENV;
    const deps = windows(['C:\\bin\\claude.exe'], env);
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe('C:\\bin\\claude.EXE');
  });

  it('reads Path, PATHEXT and ComSpec whatever their casing', () => {
    // process.env is case-insensitive on Windows; a plain copy of it is not.
    const deps = windows(['C:\\bin\\claude.cmd'], {
      path: 'C:\\bin',
      pathext: '.exe;.cmd',
      comspec: CMD_EXE,
    });
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe(CMD_EXE);
  });

  it('skips empty PATH entries and unquotes quoted ones', () => {
    const deps = windows(['C:\\Program Files\\Claude\\claude.exe'], {
      ...WINDOWS_ENV,
      Path: ';"C:\\Program Files\\Claude";C:\\bin',
    });
    expect(resolveLaunchCommand('claude', ARGS, deps)?.file).toBe(
      'C:\\Program Files\\Claude\\claude.exe',
    );
  });
});
