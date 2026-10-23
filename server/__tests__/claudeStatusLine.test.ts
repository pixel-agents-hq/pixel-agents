import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  installHooks,
  installStatusLine,
  setStatusLineInstalled,
  statusLineState,
  uninstallHooks,
  uninstallStatusLine,
} = await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { SETTINGS_BACKUP_SUFFIX } = await import('../src/providers/hook/claude/constants.js');

function settingsPath(): string {
  return path.join(tmpBase, '.claude', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
}

function writeSettings(value: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2));
}

function ourStatusLine(): Record<string, unknown> {
  return {
    type: 'command',
    command: `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-statusline.js')}"`,
    padding: 0,
  };
}

describe('usage meter status line', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-statusline-test-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('is off with no settings file, and on once installed', async () => {
    expect(statusLineState()).toBe('off');
    await installStatusLine();
    expect(readSettings().statusLine).toEqual(ourStatusLine());
    expect(statusLineState()).toBe('on');
  });

  it('keeps the rest of settings.json', async () => {
    writeSettings({ permissions: { allow: ['Bash(ls)'] }, model: 'opus' });
    await installStatusLine();
    const settings = readSettings();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.model).toBe('opus');
  });

  it("never replaces the user's own status line", async () => {
    const theirs = { type: 'command', command: '~/.claude/statusline.sh' };
    writeSettings({ statusLine: theirs });
    expect(statusLineState()).toBe('foreign');
    await expect(installStatusLine()).rejects.toThrow(/already has a status line/);
    expect(readSettings().statusLine).toEqual(theirs);
  });

  it("uninstall removes ours and leaves the user's own alone", async () => {
    await installStatusLine();
    await uninstallStatusLine();
    expect(readSettings().statusLine).toBeUndefined();
    expect(statusLineState()).toBe('off');

    const theirs = { type: 'command', command: '/usr/local/bin/my-line' };
    writeSettings({ statusLine: theirs });
    await uninstallStatusLine();
    expect(readSettings().statusLine).toEqual(theirs);
  });

  it('reports an unparseable file and writes nothing', async () => {
    fs.writeFileSync(settingsPath(), '{ broken');
    expect(statusLineState()).toBe('unreadable');
    await expect(installStatusLine()).rejects.toThrow(/usage meter not installed/);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ broken');
  });

  it('a statusLine running a lookalike path is not ours', async () => {
    const lookalike = {
      type: 'command',
      command: `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-statusline.js.bak')}"`,
    };
    writeSettings({ statusLine: lookalike });
    expect(statusLineState()).toBe('foreign');
  });

  it('hooks install/uninstall leave the status line alone', async () => {
    await installStatusLine();
    await installHooks();
    await uninstallHooks();
    expect(readSettings().statusLine).toEqual(ourStatusLine());
  });

  it('backs up nothing when the file holds only our own output', async () => {
    // Fresh home: our status line creates the file, then hooks are added.
    await installStatusLine();
    await installHooks();
    expect(fs.existsSync(settingsPath() + SETTINGS_BACKUP_SUFFIX)).toBe(false);
  });

  it('the toggle copies the script before writing, and aborts when it is missing', async () => {
    const pkg = path.join(tmpBase, 'pkg');
    await expect(setStatusLineInstalled(pkg, true)).rejects.toThrow(/script missing/);
    expect(fs.existsSync(settingsPath())).toBe(false);

    fs.mkdirSync(path.join(pkg, 'dist', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'dist', 'hooks', 'claude-statusline.js'), '// script');
    await setStatusLineInstalled(pkg, true);
    expect(
      fs.existsSync(path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-statusline.js')),
    ).toBe(true);
    expect(statusLineState()).toBe('on');

    await setStatusLineInstalled(pkg, false);
    expect(statusLineState()).toBe('off');
  });
});
