import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks, copyHookScript } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');

function readSettings(): Record<string, unknown> {
  const p = path.join(tmpBase, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('claudeHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-test-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. installHooks adds entries
  it('installHooks adds entries to settings.json', async () => {
    await installHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeTruthy();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 2. installHooks is idempotent
  it('installHooks is idempotent', async () => {
    await installHooks();
    await installHooks();
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 3. areHooksInstalled returns true after install
  it('areHooksInstalled returns true after install', async () => {
    await installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  // 4. areHooksInstalled returns false before install
  it('areHooksInstalled returns false before install', () => {
    expect(areHooksInstalled()).toBe(false);
  });

  // 5. uninstallHooks removes entries
  it('uninstallHooks removes entries', async () => {
    await installHooks();
    expect(areHooksInstalled()).toBe(true);
    await uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  // 6. uninstallHooks cleans empty hooks object
  it('uninstallHooks cleans empty hooks object', async () => {
    await installHooks();
    await uninstallHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeUndefined();
  });

  // 7. Handles missing settings.json
  it('handles missing settings.json gracefully', () => {
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 8. Handles malformed settings.json
  it('handles malformed settings.json gracefully', () => {
    fs.writeFileSync(path.join(tmpBase, '.claude', 'settings.json'), 'not json!!!');
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 8a. THE regression the 1-star Marketplace review reported: an unparseable
  //     settings.json used to read as {} and the subsequent write replaced the
  //     user's whole file (permission rules included) with only our hooks.
  //     Install must reject and leave the file byte-for-byte untouched.
  it('leaves a malformed settings.json byte-for-byte unchanged on install', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const malformed = '{ "permissions": { "allow": ["Bash(ls:*)"] }, }'; // trailing comma
    fs.writeFileSync(settingsPath, malformed);

    await expect(installHooks()).rejects.toThrow(/Couldn't parse/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(malformed);
    expect(fs.existsSync(settingsPath + '.backup')).toBe(false);
    expect(fs.existsSync(settingsPath + '.pixel-agents-tmp')).toBe(false);
  });

  // 8a'. Same for a BOM'd file: JSON.parse rejects a UTF-8 BOM, and an
  //      editor-saved settings.json is exactly the kind of file that has one.
  it('leaves a BOM-prefixed settings.json unchanged on install', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const bommed = '﻿' + JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, bommed);

    await expect(installHooks()).rejects.toThrow(/Couldn't parse/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(bommed);
    expect(fs.existsSync(settingsPath + '.backup')).toBe(false);
  });

  // 8a-2. Uninstall gets the same protection AND must not claim success: the
  //       rejection is what stops callers from logging "uninstalled" while the
  //       entries are still live in the broken file.
  it('rejects uninstall on a malformed settings.json and leaves it unchanged', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const malformed = '{ "hooks": { "Stop": [] }, }';
    fs.writeFileSync(settingsPath, malformed);

    await expect(uninstallHooks()).rejects.toThrow(/hook entries left in place/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(malformed);
  });

  // 8a''. The merge contract on the happy path: unrelated keys and third-party
  //       hook entries survive an install.
  it('preserves unrelated keys and third-party hooks on install', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const thirdParty = {
      matcher: '',
      hooks: [{ type: 'command', command: 'node /elsewhere/other-tool.js' }],
    };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] },
        model: 'opus',
        hooks: { PreToolUse: [thirdParty] },
      }),
    );

    await installHooks();

    const settings = readSettings();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: ['Read(.env)'] });
    expect(settings.model).toBe('opus');
    const preToolUse = (settings.hooks as Record<string, unknown[]>)['PreToolUse'];
    expect(preToolUse).toHaveLength(2);
    expect(preToolUse[0]).toEqual(thirdParty);
  });

  // 8a-3. Identity requires OUR directory, not just the script name:
  //       `claude-hook.js` is a generic filename another Claude tool could use,
  //       and it must survive both install (dedup) and uninstall.
  it('never touches a third-party hook that happens to be named claude-hook.js', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const lookalike = {
      matcher: '',
      hooks: [{ type: 'command', command: 'node /opt/other-tool/claude-hook.js' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [lookalike] } }));

    await installHooks();
    let stop = (readSettings().hooks as Record<string, unknown[]>)['Stop'];
    expect(stop[0]).toEqual(lookalike);

    await uninstallHooks();
    stop = (readSettings().hooks as Record<string, unknown[]>)['Stop'];
    expect(stop).toEqual([lookalike]);
  });

  // 8a-4. Per-hook filtering: an entry holding a third-party hook AND ours must
  //       lose only ours, not the whole entry.
  it('removes only our command from an entry shared with a third-party hook', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const theirCommand = 'node /elsewhere/other-tool.js';
    const ourCommand = `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: theirCommand },
                { type: 'command', command: ourCommand, timeout: 5 },
              ],
            },
          ],
        },
      }),
    );

    await uninstallHooks();

    const stop = (
      readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    )['Stop'];
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks.map((h) => h.command)).toEqual([theirCommand]);
  });

  // 8b. One-time backup before first modification
  it('backs up settings.json once before the first modification', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const backupPath = settingsPath + '.backup';
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, original);

    await installHooks();
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);

    // A later modification must NOT refresh the backup: it preserves the
    // pre-Pixel-Agents state, not the previous write.
    await uninstallHooks();
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
  });

  // 8c. No backup when there was nothing to back up
  it('creates no backup when settings.json did not exist', async () => {
    await installHooks();
    const backupPath = path.join(tmpBase, '.claude', 'settings.json.backup');
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  // 9. copyHookScript copies file
  it('copyHookScript copies to ~/.pixel-agents/hooks/', () => {
    // Create a mock extension path with dist/hooks/claude-hook.js
    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'claude-hook.js'), '// mock hook script');

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf-8')).toBe('// mock hook script');
  });

  // 10. copyHookScript sets executable permissions (non-Windows)
  it('copyHookScript sets executable permissions', () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows

    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'claude-hook.js'), '// mock');

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');
    const stat = fs.statSync(dst);
    // Check owner execute bit
    expect(stat.mode & 0o100).toBeTruthy();
  });

  // 11. copyHookScript reports success when the source exists (issue #333)
  it('copyHookScript returns true when the source exists', () => {
    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'claude-hook.js'), '// mock');

    expect(copyHookScript(mockExtPath)).toBe(true);
  });

  // 12. copyHookScript reports failure when the source is missing (issue #333):
  //     without this, a path regression logs "Hooks installed" while installing
  //     nothing — the silent failure the reporter flagged.
  it('copyHookScript returns false when the source is missing', () => {
    const mockExtPath = path.join(tmpBase, 'mock-ext'); // no dist/hooks/claude-hook.js
    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');

    expect(copyHookScript(mockExtPath)).toBe(false);
    expect(fs.existsSync(dst)).toBe(false);
  });
});
