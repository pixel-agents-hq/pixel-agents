import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const {
  getClaudeConfigDir,
  getClaudeConfigDirSource,
  resolveClaudeConfigDir,
  resetClaudeConfigDirOverrideForTests,
  setClaudeConfigDirOverride,
} = await import('../src/providers/hook/claude/claudeConfigDir.js');

describe('claudeConfigDir: resolution', () => {
  beforeEach(() => {
    tmpHome = '/tmp/pxl-claude-config-dir-test-home';
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    resetClaudeConfigDirOverrideForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClaudeConfigDirOverrideForTests();
  });

  describe('resolveClaudeConfigDir(candidate)', () => {
    it('returns the candidate when given one', () => {
      expect(resolveClaudeConfigDir('/custom/claude')).toBe('/custom/claude');
    });

    it('falls through to CLAUDE_CONFIG_DIR when candidate is undefined', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      expect(resolveClaudeConfigDir(undefined)).toBe('/env/claude');
    });

    it('falls through to ~/.claude when neither candidate nor env var is set', () => {
      expect(resolveClaudeConfigDir(undefined)).toBe(path.join(tmpHome, '.claude'));
    });

    it('trims whitespace off the env var before using it', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '  /env/claude  ');
      expect(resolveClaudeConfigDir(undefined)).toBe('/env/claude');
    });

    it('treats an empty/whitespace-only env var as unset', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '   ');
      expect(resolveClaudeConfigDir(undefined)).toBe(path.join(tmpHome, '.claude'));
    });
  });

  describe('getClaudeConfigDir() precedence: setting > env var > default', () => {
    it('returns ~/.claude when nothing is set', () => {
      expect(getClaudeConfigDir()).toBe(path.join(tmpHome, '.claude'));
    });

    it('returns the env var when only that is set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      expect(getClaudeConfigDir()).toBe('/env/claude');
    });

    it('returns the override when only that is set', () => {
      setClaudeConfigDirOverride('/setting/claude');
      expect(getClaudeConfigDir()).toBe('/setting/claude');
    });

    it('prefers the override over the env var when both are set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      setClaudeConfigDirOverride('/setting/claude');
      expect(getClaudeConfigDir()).toBe('/setting/claude');
    });

    it('trims the override', () => {
      setClaudeConfigDirOverride('  /setting/claude  ');
      expect(getClaudeConfigDir()).toBe('/setting/claude');
    });

    it('treats an empty/whitespace-only override as unset', () => {
      setClaudeConfigDirOverride('   ');
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      expect(getClaudeConfigDir()).toBe('/env/claude');
    });

    it('treats undefined override as unset', () => {
      setClaudeConfigDirOverride(undefined);
      expect(getClaudeConfigDir()).toBe(path.join(tmpHome, '.claude'));
    });
  });

  describe('getClaudeConfigDirSource()', () => {
    it('returns "default" when nothing is set', () => {
      expect(getClaudeConfigDirSource()).toBe('default');
    });

    it('returns "env" when only the env var is set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      expect(getClaudeConfigDirSource()).toBe('env');
    });

    it('returns "setting" when the override is set (even with env var also set)', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      setClaudeConfigDirOverride('/setting/claude');
      expect(getClaudeConfigDirSource()).toBe('setting');
    });
  });

  describe('resetClaudeConfigDirOverrideForTests()', () => {
    it('clears a previously-set override', () => {
      setClaudeConfigDirOverride('/setting/claude');
      resetClaudeConfigDirOverrideForTests();
      expect(getClaudeConfigDir()).toBe(path.join(tmpHome, '.claude'));
    });
  });
});
