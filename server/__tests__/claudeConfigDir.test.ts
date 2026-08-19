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
  normalizeClaudeConfigDirInput,
  buildClaudeConfigDirFields,
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

describe('normalizeClaudeConfigDirInput', () => {
  let tmpDir: string;

  beforeEach(() => {
    const fs = require('fs') as typeof import('fs');
    const osReal = require('os') as typeof import('os');
    tmpDir = fs.mkdtempSync(path.join(osReal.tmpdir(), 'pxl-normalize-test-'));
  });

  afterEach(() => {
    const fs = require('fs') as typeof import('fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "" unchanged for blank input (clears the override)', () => {
    expect(normalizeClaudeConfigDirInput('')).toBe('');
  });

  it('expands a bare ~ to the home directory', () => {
    expect(normalizeClaudeConfigDirInput('~')).toBe(tmpHome);
  });

  it('expands ~/foo to <home>/foo', () => {
    expect(normalizeClaudeConfigDirInput('~/foo')).toBe(path.join(tmpHome, 'foo'));
  });

  it('expands ~\\foo (Windows tilde form) to <home>/foo', () => {
    expect(normalizeClaudeConfigDirInput('~\\foo')).toBe(path.join(tmpHome, 'foo'));
  });

  it('collapses .. segments via path.normalize', () => {
    expect(normalizeClaudeConfigDirInput('/a/b/../c')).toBe(path.normalize('/a/c'));
  });

  it('rejects a relative path', () => {
    expect(normalizeClaudeConfigDirInput('relative/path')).toBeNull();
  });

  // The filesystem root passes both of the other checks -- it is absolute and
  // it is a directory -- but accepting it would make getClaudeSettingsPath()
  // resolve to /settings.json and have the next boot write there.
  it('rejects the filesystem root', () => {
    expect(normalizeClaudeConfigDirInput('/')).toBeNull();
  });

  // path.normalize collapses a trailing separator, so '/a/..' lands on the
  // root the same way a bare '/' does. Guards the check against being written
  // as a literal '/' comparison on the RAW input.
  it('rejects a path that normalizes down to the filesystem root', () => {
    expect(normalizeClaudeConfigDirInput('/a/..')).toBeNull();
  });

  // normalizeClaudeConfigDirInput's root-rejection guard
  // (`path.parse(normalized).root === normalized`) runs through whatever
  // `path` module Node resolves the bare `path` import to on the host OS.
  // On this repo's CI, server unit tests only ever run on ubuntu-latest --
  // Windows-shaped inputs below get rejected earlier, by the isAbsolute
  // check, before the root check is even reached (see the "rejects a
  // relative path" test above). Calling normalizeClaudeConfigDirInput
  // itself would therefore never exercise the root guard's Windows
  // semantics on this CI. Test the underlying path.win32 invariant
  // directly instead -- it's what the guard becomes verbatim when Node
  // actually runs on win32, and it's platform-independent to call from any
  // host OS. If a future Node upgrade changes what path.win32 considers a
  // root, this fails loudly instead of shipping a silent regression that
  // only a Windows user would ever notice.
  describe('root-rejection guard: win32 path semantics (host-OS-independent)', () => {
    function win32RootCheck(raw: string): { normalized: string; isRoot: boolean } {
      const normalized = path.win32.normalize(raw);
      return { normalized, isRoot: path.win32.parse(normalized).root === normalized };
    }

    it.each(['C:\\', 'C:/', 'D:\\', '\\\\server\\share'])(
      '%s normalizes down to its own drive/UNC root',
      (winRoot) => {
        expect(win32RootCheck(winRoot).isRoot).toBe(true);
      },
    );

    it.each(['C:\\Users\\me', '\\\\server\\share\\folder'])(
      '%s is NOT its own root (a real subdirectory)',
      (winPath) => {
        expect(win32RootCheck(winPath).isRoot).toBe(false);
      },
    );
  });

  it('accepts an absolute path that does not exist yet', () => {
    const target = path.join(tmpDir, 'does-not-exist-yet');
    expect(normalizeClaudeConfigDirInput(target)).toBe(target);
  });

  it('accepts an absolute path that exists and is a directory', () => {
    expect(normalizeClaudeConfigDirInput(tmpDir)).toBe(tmpDir);
  });

  it('rejects a path that exists but is a file, not a directory', () => {
    const fs = require('fs') as typeof import('fs');
    const filePath = path.join(tmpDir, 'a-file');
    fs.writeFileSync(filePath, 'content');
    expect(normalizeClaudeConfigDirInput(filePath)).toBeNull();
  });
});

describe('buildClaudeConfigDirFields(rawPersistedValue)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpHome = '/tmp/pxl-claude-config-dir-test-home';
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    resetClaudeConfigDirOverrideForTests();
    const fs = require('fs') as typeof import('fs');
    const osReal = require('os') as typeof import('os');
    tmpDir = fs.mkdtempSync(path.join(osReal.tmpdir(), 'pxl-build-fields-test-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClaudeConfigDirOverrideForTests();
    const fs = require('fs') as typeof import('fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('echoes the raw value into claudeConfigDir unchanged', () => {
    const fields = buildClaudeConfigDirFields('/some/raw/value');
    expect(fields.claudeConfigDir).toBe('/some/raw/value');
  });

  it('resolvedClaudeConfigDir reflects the LIVE override, not the raw value', () => {
    setClaudeConfigDirOverride('/live/override');
    const fields = buildClaudeConfigDirFields('/different/raw/value');
    expect(fields.resolvedClaudeConfigDir).toBe('/live/override');
  });

  it('resolvedClaudeConfigDirSource matches getClaudeConfigDirSource()', () => {
    setClaudeConfigDirOverride('/live/override');
    const fields = buildClaudeConfigDirFields('/raw');
    expect(fields.resolvedClaudeConfigDirSource).toBe('setting');
  });

  it('resolvedClaudeConfigDirExists is true only if the LIVE resolved dir exists', () => {
    setClaudeConfigDirOverride(tmpHome); // tmpHome does not exist on disk (it's a fake path)
    const fields = buildClaudeConfigDirFields('/raw');
    expect(fields.resolvedClaudeConfigDirExists).toBe(false);
  });

  it('pendingDirExists resolves the RAW value through the precedence chain, independent of the live override', () => {
    setClaudeConfigDirOverride('/live/override'); // live override differs from raw
    const fields = buildClaudeConfigDirFields(''); // raw = '' -> falls through to env/default
    // pendingDir resolves '' -> undefined -> env var (unset here) -> default (tmpHome/.claude)
    expect(fields.pendingDirExists).toBe(false); // tmpHome/.claude doesn't exist on disk
  });

  it('resolvedClaudeConfigDirExists and pendingDirExists are backed by genuinely different sources', () => {
    // Asymmetric ground truth: the LIVE override points at a real directory,
    // while the RAW value points at a different, nonexistent one. If the two
    // existence checks were ever swapped or conflated, this would catch it --
    // unlike the other tests in this block, where both sides happen to be
    // nonexistent paths and a swap would go unnoticed.
    setClaudeConfigDirOverride(tmpDir); // real directory
    const fields = buildClaudeConfigDirFields('/definitely/does/not/exist/raw'); // fake path
    expect(fields.resolvedClaudeConfigDirExists).toBe(true);
    expect(fields.pendingDirExists).toBe(false);
  });

  it('returns exactly five fields', () => {
    const fields = buildClaudeConfigDirFields('/raw');
    expect(Object.keys(fields).sort()).toEqual(
      [
        'claudeConfigDir',
        'pendingDirExists',
        'resolvedClaudeConfigDir',
        'resolvedClaudeConfigDirExists',
        'resolvedClaudeConfigDirSource',
      ].sort(),
    );
  });
});
