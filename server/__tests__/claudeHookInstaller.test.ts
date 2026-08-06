import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks, uninstallHooksAt, copyHookScript } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { resetClaudeConfigDirOverrideForTests } =
  await import('../src/providers/hook/claude/claudeConfigDir.js');

function readSettings(base: string = tmpBase): Record<string, unknown> {
  const p = path.join(base, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('claudeHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-test-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
    // An inherited CLAUDE_CONFIG_DIR on a developer machine would otherwise
    // defeat the os.homedir() mock above -- this file's isolation depends
    // on both being neutralized.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    resetClaudeConfigDirOverrideForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClaudeConfigDirOverrideForTests();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. installHooks adds entries
  it('installHooks adds entries to settings.json', () => {
    installHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeTruthy();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 2. installHooks is idempotent
  it('installHooks is idempotent', () => {
    installHooks();
    installHooks();
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 3. areHooksInstalled returns true after install
  it('areHooksInstalled returns true after install', () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  // 4. areHooksInstalled returns false before install
  it('areHooksInstalled returns false before install', () => {
    expect(areHooksInstalled()).toBe(false);
  });

  // 5. uninstallHooks removes entries
  it('uninstallHooks removes entries', () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
    uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  // 6. uninstallHooks cleans empty hooks object
  it('uninstallHooks cleans empty hooks object', () => {
    installHooks();
    uninstallHooks();
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

  // ── uninstallHooksAt(explicitDir) ─────────────────────────────

  describe('uninstallHooksAt(explicitDir)', () => {
    it('removes hook entries from the explicit directory, not the ambient one', () => {
      const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-alt-'));
      fs.mkdirSync(altDir, { recursive: true });
      // Install at the ambient (mocked-homedir) location first.
      installHooks();
      expect(areHooksInstalled()).toBe(true);
      // Manually seed hook entries at the alt dir too, mimicking a previous install there.
      installHooks(); // still at tmpBase; now write the same shape into altDir directly
      fs.writeFileSync(path.join(altDir, 'settings.json'), JSON.stringify(readSettings()), 'utf-8');

      uninstallHooksAt(altDir);

      const altSettings = JSON.parse(fs.readFileSync(path.join(altDir, 'settings.json'), 'utf-8'));
      expect(altSettings.hooks).toBeUndefined();
      // The ambient location is untouched.
      expect(areHooksInstalled()).toBe(true);

      fs.rmSync(altDir, { recursive: true, force: true });
    });

    it('is a no-op, not an error, when nothing is installed at explicitDir', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-empty-'));
      expect(() => uninstallHooksAt(emptyDir)).not.toThrow();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  // ── install/uninstall targeting an overridden CLAUDE_CONFIG_DIR ──

  describe('with CLAUDE_CONFIG_DIR set', () => {
    it('installHooks writes to the env var directory, not the mocked homedir', () => {
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-env-'));
      vi.stubEnv('CLAUDE_CONFIG_DIR', envDir);

      installHooks();

      // CLAUDE_CONFIG_DIR resolves directly to the config dir (no nested
      // .claude, per claudeConfigDir.ts's own precedence-chain tests) --
      // unlike readSettings(base)'s tmpBase default, which stands in for a
      // homedir and expects the .claude nesting.
      const settings = JSON.parse(
        fs.readFileSync(path.join(envDir, 'settings.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(settings.hooks).toBeTruthy();
      // tmpBase (the mocked homedir) never got a settings.json written to it.
      expect(fs.existsSync(path.join(tmpBase, '.claude', 'settings.json'))).toBe(false);

      fs.rmSync(envDir, { recursive: true, force: true });
    });
  });
});
