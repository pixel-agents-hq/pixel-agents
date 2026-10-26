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
  installStatusLineBridge,
  isStatusLineBridgeInstalled,
  uninstallStatusLineBridge,
  STATUSLINE_EDITED_MESSAGE,
  STATUSLINE_NOT_COMMAND_MESSAGE,
} = await import('../src/providers/hook/claude/statusLineInstaller.js');
const { installHooks } = await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { wrappedStatusLineCommand, isBareOurStatusLine } =
  await import('../src/providers/hook/claude/statusLineBridge.js');
const { SETTINGS_BACKUP_SUFFIX } = await import('../src/providers/hook/claude/constants.js');

/** A fake package root holding the bundled bridge script. */
let packageRoot: string;

function settingsPath(): string {
  return path.join(tmpBase, '.claude', 'settings.json');
}

function writeSettings(value: unknown): string {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const raw = JSON.stringify(value, null, 2);
  fs.writeFileSync(settingsPath(), raw);
  return raw;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
}

function statusLine(): Record<string, unknown> | undefined {
  return readSettings().statusLine as Record<string, unknown> | undefined;
}

function scriptPath(): string {
  return path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-statusline.js');
}

/** A user status line with every shell feature that must survive the wrap. */
const USER_COMMAND = `bash ~/.claude/statusline.sh | sed 's/a/"b"/' && echo $COLUMNS`;

describe('status line bridge installer', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-statusline-'));
    packageRoot = path.join(tmpBase, 'pkg');
    fs.mkdirSync(path.join(packageRoot, 'dist', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'dist', 'hooks', 'claude-statusline.js'), '// bridge');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('wraps an existing status line, keeping its other fields, and restores it byte for byte', async () => {
    writeSettings({
      model: 'opus',
      statusLine: { type: 'command', command: USER_COMMAND, padding: 2, refreshInterval: 5 },
    });

    await installStatusLineBridge(packageRoot);

    const installed = statusLine()!;
    expect(isStatusLineBridgeInstalled()).toBe(true);
    expect(installed.command).toContain(scriptPath());
    expect(installed.padding).toBe(2);
    expect(installed.refreshInterval).toBe(5);
    expect(wrappedStatusLineCommand(installed.command as string)).toBe(USER_COMMAND);
    expect(fs.existsSync(scriptPath())).toBe(true);
    expect(readSettings().model).toBe('opus');

    await uninstallStatusLineBridge();

    expect(statusLine()).toEqual({
      type: 'command',
      command: USER_COMMAND,
      padding: 2,
      refreshInterval: 5,
    });
    expect(isStatusLineBridgeInstalled()).toBe(false);
  });

  it('adds a bare bridge when there is no status line, and removes it on uninstall', async () => {
    writeSettings({ model: 'opus' });

    await installStatusLineBridge(packageRoot);
    expect(statusLine()).toEqual({ type: 'command', command: `node "${scriptPath()}"` });
    expect(isBareOurStatusLine(statusLine())).toBe(true);

    await uninstallStatusLineBridge();
    expect(readSettings()).toEqual({ model: 'opus' });
  });

  it('is idempotent: a second install writes nothing and never double-wraps', async () => {
    writeSettings({ statusLine: { type: 'command', command: USER_COMMAND } });
    await installStatusLineBridge(packageRoot);
    const once = fs.readFileSync(settingsPath(), 'utf-8');

    await installStatusLineBridge(packageRoot);

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(once);
    expect(wrappedStatusLineCommand(statusLine()!.command as string)).toBe(USER_COMMAND);
  });

  it.each([
    ['a string', 'echo hi'],
    ['null', null],
    ['a non-command type', { type: 'static', text: 'hi' }],
    ['an empty command', { type: 'command', command: '  ' }],
  ])('refuses a status line that is %s and leaves the file untouched', async (_label, value) => {
    const raw = writeSettings({ statusLine: value });

    await expect(installStatusLineBridge(packageRoot)).rejects.toThrow(
      STATUSLINE_NOT_COMMAND_MESSAGE,
    );
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(raw);
  });

  it('refuses an unparseable settings file without writing', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');

    await expect(installStatusLineBridge(packageRoot)).rejects.toThrow(/usage bars not connected/);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ not json');
  });

  it('writes nothing when the bridge script is missing from the package', async () => {
    const raw = writeSettings({ statusLine: { type: 'command', command: USER_COMMAND } });
    fs.rmSync(path.join(packageRoot, 'dist'), { recursive: true });

    await expect(installStatusLineBridge(packageRoot)).rejects.toThrow(/script/);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(raw);
  });

  it('leaves alone a status line someone replaced after us', async () => {
    writeSettings({ statusLine: { type: 'command', command: USER_COMMAND } });
    await installStatusLineBridge(packageRoot);
    const replaced = writeSettings({ statusLine: { type: 'command', command: 'echo theirs' } });

    await uninstallStatusLineBridge();

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(replaced);
  });

  it('refuses to uninstall a bridge whose wrapped part was edited by hand', async () => {
    const raw = writeSettings({
      statusLine: { type: 'command', command: `node "${scriptPath()}" --wrap not@base64!` },
    });

    await expect(uninstallStatusLineBridge()).rejects.toThrow(STATUSLINE_EDITED_MESSAGE);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(raw);
  });

  it('does not claim a lookalike script as ours', async () => {
    const lookalike = `node "${path.join(tmpBase, 'evil.pixel-agents', 'hooks', 'claude-statusline.js')}"`;
    writeSettings({ statusLine: { type: 'command', command: lookalike } });

    expect(isStatusLineBridgeInstalled()).toBe(false);
    await installStatusLineBridge(packageRoot);
    // Treated as the user's command: wrapped, never replaced.
    expect(wrappedStatusLineCommand(statusLine()!.command as string)).toBe(lookalike);
  });

  it('takes no backup of a file holding only our own hooks and bare bridge', async () => {
    // A fresh home: our installs create settings.json, so a backup of it would
    // enshrine our own output as "the user's original".
    await installHooks();
    await installStatusLineBridge(packageRoot);
    await uninstallStatusLineBridge();

    expect(fs.existsSync(settingsPath() + SETTINGS_BACKUP_SUFFIX)).toBe(false);
  });

  it("backs up the user's file before wrapping their status line", async () => {
    const raw = writeSettings({ statusLine: { type: 'command', command: USER_COMMAND } });

    await installStatusLineBridge(packageRoot);

    expect(fs.readFileSync(settingsPath() + SETTINGS_BACKUP_SUFFIX, 'utf-8')).toBe(raw);
  });
});
