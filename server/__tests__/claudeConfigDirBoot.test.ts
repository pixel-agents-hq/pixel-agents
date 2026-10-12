import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { readConfig, writeConfig } = await import('../src/configPersistence.js');
const { resetClaudeConfigDirOverrideForTests, getClaudeConfigDir, setClaudeConfigDirOverride } =
  await import('../src/providers/hook/claude/claudeConfigDir.js');
const { areHooksInstalled, installHooks } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const claudeHookInstallerModule =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { prepareClaudeConfigDirForBoot, recordClaudeConfigDirHooksInstalled } =
  await import('../src/claudeConfigDirBoot.js');

function readHomeSettings(): Record<string, unknown> | null {
  const p = path.join(tmpHome, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('claudeConfigDirBoot', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-boot-test-'));
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.pixel-agents'), { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    resetClaudeConfigDirOverrideForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClaudeConfigDirOverrideForTests();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('prepareClaudeConfigDirForBoot(namespace)', () => {
    it('sets the live override from the persisted claudeConfigDir setting', () => {
      const cfg = readConfig();
      cfg.claudeConfigDir = '/custom/claude';
      writeConfig(cfg);

      prepareClaudeConfigDirForBoot('standalone');

      expect(getClaudeConfigDir()).toBe('/custom/claude');
    });

    it('is a no-op (no uninstall) when claudeConfigDirHooksInstalledAt is unset', () => {
      const uninstallSpy = vi.spyOn(claudeHookInstallerModule, 'uninstallHooksAt');
      installHooks(); // installs at the default ~/.claude for this mocked home
      prepareClaudeConfigDirForBoot('standalone'); // record is still '' -- nothing to clean up
      expect(areHooksInstalled()).toBe(true); // untouched
      // resolvedDir is definitely non-empty here, so a buggy `installedAt !==
      // resolvedDir` check alone (without the `installedAt &&` truthy guard)
      // would be true and would call uninstallHooksAt(''). This is the only
      // assertion that can catch that -- areHooksInstalled() above can't,
      // because uninstallHooksAt('') resolves to a bogus relative path that
      // silently no-ops regardless of whether it was called.
      expect(uninstallSpy).not.toHaveBeenCalled();
      uninstallSpy.mockRestore();
    });

    it('is a no-op when the recorded dir already matches the resolved dir', () => {
      installHooks();
      const cfg = readConfig();
      cfg.standalone.claudeConfigDirHooksInstalledAt = path.join(tmpHome, '.claude');
      writeConfig(cfg);

      prepareClaudeConfigDirForBoot('standalone');

      expect(areHooksInstalled()).toBe(true); // untouched -- same dir, no cleanup needed
    });

    it('uninstalls from the recorded (stale) directory when it differs from the resolved one', () => {
      // Simulate: hooks were previously installed at an old location...
      const oldDir = path.join(tmpHome, 'old-claude-dir');
      fs.mkdirSync(oldDir, { recursive: true });
      const cfg1 = readConfig();
      cfg1.claudeConfigDir = oldDir;
      writeConfig(cfg1);
      // installHooks() targets the LIVE override, not config.json directly --
      // set it explicitly to simulate the boot that originally installed here.
      setClaudeConfigDirOverride(oldDir);
      installHooks(); // installs at oldDir (the currently-resolved dir)
      expect(fs.existsSync(path.join(oldDir, 'settings.json'))).toBe(true);

      // ...then the setting changes to a new location, and this is the next boot.
      const cfg2 = readConfig();
      cfg2.claudeConfigDir = '/new/claude/dir';
      cfg2.standalone.claudeConfigDirHooksInstalledAt = oldDir;
      writeConfig(cfg2);
      resetClaudeConfigDirOverrideForTests(); // simulate a fresh process boot

      prepareClaudeConfigDirForBoot('standalone');

      const oldSettings = JSON.parse(fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf-8'));
      expect(oldSettings.hooks).toBeUndefined(); // cleaned up
      expect(getClaudeConfigDir()).toBe('/new/claude/dir'); // override is now live
    });

    it("does NOT act on a different namespace's record (cross-surface fix)", () => {
      const oldDir = path.join(tmpHome, 'old-claude-dir');
      fs.mkdirSync(oldDir, { recursive: true });
      const cfg = readConfig();
      cfg.claudeConfigDir = '/new/claude/dir';
      // Only vscode's record is stale -- standalone's own record is unset.
      cfg.vscode.claudeConfigDirHooksInstalledAt = oldDir;
      writeConfig(cfg);
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(
        path.join(oldDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "claude-hook.js"' }] }],
          },
        }),
      );

      prepareClaudeConfigDirForBoot('standalone'); // booting the OTHER surface

      const oldSettings = JSON.parse(fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf-8'));
      expect(oldSettings.hooks).toBeTruthy(); // untouched -- standalone never read vscode's record
    });
  });

  describe('recordClaudeConfigDirHooksInstalled(namespace)', () => {
    it('writes the currently-resolved dir into only that namespace', () => {
      const cfg = readConfig();
      cfg.claudeConfigDir = '/resolved/claude';
      writeConfig(cfg);
      resetClaudeConfigDirOverrideForTests();
      prepareClaudeConfigDirForBoot('vscode'); // sets the live override

      recordClaudeConfigDirHooksInstalled('vscode');

      const reloaded = readConfig();
      expect(reloaded.vscode.claudeConfigDirHooksInstalledAt).toBe('/resolved/claude');
      expect(reloaded.standalone.claudeConfigDirHooksInstalledAt).toBe('');
    });
  });

  describe('same-path resave never triggers cleanup', () => {
    it('re-saving the same directory does not call uninstallHooksAt', () => {
      installHooks(); // installs at default ~/.claude
      const cfg = readConfig();
      cfg.standalone.claudeConfigDirHooksInstalledAt = path.join(tmpHome, '.claude');
      writeConfig(cfg);

      prepareClaudeConfigDirForBoot('standalone'); // resolved dir == recorded dir

      expect(readHomeSettings()?.hooks).toBeTruthy(); // still installed, never touched
    });
  });
});
