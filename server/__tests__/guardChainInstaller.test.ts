/** P4：hook 鏈的唯讀檢查（PreToolUse 項目、腳本檔案），F14 的鏈上原因來源。 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, isHookScriptPresent, isPreToolUseHookInstalled } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');

function settingsPath(): string {
  return path.join(tmpBase, '.claude', 'settings.json');
}

function readSettings(): { hooks: Record<string, unknown[]> } {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
}

function writeSettings(settings: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings));
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-chain-'));
  fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('isPreToolUseHookInstalled', () => {
  it('is false without a settings file and when hooks are absent', () => {
    expect(isPreToolUseHookInstalled()).toBe(false);
    writeSettings({ permissions: {} });
    expect(isPreToolUseHookInstalled()).toBe(false);
  });

  it('is true after install', async () => {
    await installHooks();
    expect(isPreToolUseHookInstalled()).toBe(true);
  });

  it('is false when only the PreToolUse entry was deleted, while areHooksInstalled stays true', async () => {
    await installHooks();
    const settings = readSettings();
    delete settings.hooks['PreToolUse'];
    writeSettings(settings);
    expect(areHooksInstalled()).toBe(true);
    expect(isPreToolUseHookInstalled()).toBe(false);
  });

  it('does not count a foreign PreToolUse hook or a lookalike path', () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'node /opt/evil.pixel-agents/hooks/claude-hook.js' },
            ],
          },
          { hooks: [{ type: 'command', command: 'echo hi' }] },
          null,
        ],
      },
    });
    expect(isPreToolUseHookInstalled()).toBe(false);
  });

  it('is false for an unparseable file and a non-array event, never throws', () => {
    fs.writeFileSync(settingsPath(), '{ not json');
    expect(isPreToolUseHookInstalled()).toBe(false);
    writeSettings({ hooks: { PreToolUse: 'nope' } });
    expect(isPreToolUseHookInstalled()).toBe(false);
  });

  it('does not modify the settings file', async () => {
    await installHooks();
    const before = fs.readFileSync(settingsPath(), 'utf-8');
    isPreToolUseHookInstalled();
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });
});

describe('isHookScriptPresent', () => {
  it('follows the script file at the installed path', () => {
    expect(isHookScriptPresent()).toBe(false);
    const script = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '// hook');
    expect(isHookScriptPresent()).toBe(true);
    fs.rmSync(script);
    expect(isHookScriptPresent()).toBe(false);
  });
});
