# CLAUDE_CONFIG_DIR Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pixel Agents honor Claude Code's `CLAUDE_CONFIG_DIR` environment variable (plus a settings-modal override for hosts that don't inherit it) everywhere it currently hardcodes `~/.claude`, so hook installation, session-file scanning, team-config reads, and self-launched agents all target the right directory.

**Architecture:** A new provider-internal module (`claudeConfigDir.ts`) resolves one directory per process at boot (persisted setting → `CLAUDE_CONFIG_DIR` env var → `~/.claude`) and exposes it through `providers/index.ts`; every existing hardcoded `path.join(os.homedir(), '.claude', ...)` call site switches to it. Hook cleanup on a changed directory happens once at next boot (not live), tracked per-surface so VS Code and standalone can never uninstall each other's hooks. A settings-modal text field lets VS Code hosts that don't inherit the env var set an explicit override.

**Tech Stack:** TypeScript (Node16 modules), Vitest, AsyncAPI 3.0 + Modelina codegen, React 19 webview, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-08-06-claude-config-dir-design.md` (read this first if anything below is ambiguous — it went through five rounds of adversarial review and documents the reasoning behind every design choice).

---

## Before you start

Run the full test suite once to confirm a clean baseline:

```bash
cd /Users/sergicastro/workspace/pixel-agents
npm run test:server
```

Expected: all tests pass. If anything is already broken, stop and report — don't start this plan on a red baseline.

---

### Task 1: `CLAUDE_CONFIG_DIR` constants

**Files:**
- Modify: `server/src/providers/hook/claude/constants.ts`

- [ ] **Step 1: Add the two new constants**

Append to the end of `server/src/providers/hook/claude/constants.ts`:

```ts

// ── Config directory override ───────────────────────────────
//
// Claude Code CLI itself honors CLAUDE_CONFIG_DIR to relocate its config
// directory away from ~/.claude (e.g. running multiple accounts/profiles).
// See claudeConfigDir.ts for the resolution logic that uses these.
/** Default Claude Code config directory name, joined onto os.homedir(). */
export const CLAUDE_CONFIG_DIR_NAME = '.claude';
/** Env var Claude Code CLI itself reads to relocate its config directory. */
export const CLAUDE_CONFIG_DIR_ENV_VAR = 'CLAUDE_CONFIG_DIR';
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/providers/hook/claude/constants.ts
git commit -m "feat(claude-config-dir): add CLAUDE_CONFIG_DIR constants

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Core resolution — `setClaudeConfigDirOverride`, `resolveClaudeConfigDir`, `getClaudeConfigDir`, `getClaudeConfigDirSource`

**Files:**
- Create: `server/src/providers/hook/claude/claudeConfigDir.ts`
- Test: `server/__tests__/claudeConfigDir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/claudeConfigDir.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/hook/claude/claudeConfigDir.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/providers/hook/claude/claudeConfigDir.ts`:

```ts
import * as os from 'os';
import * as path from 'path';

import { CLAUDE_CONFIG_DIR_ENV_VAR, CLAUDE_CONFIG_DIR_NAME } from './constants.js';

let override: string | undefined;

/** Set once at boot, before any provider function that touches ~/.claude runs. */
export function setClaudeConfigDirOverride(dir: string | undefined): void {
  override = dir?.trim() || undefined;
}

/** Shared precedence chain: candidate override -> CLAUDE_CONFIG_DIR env var ->
 *  ~/.claude. Exported (not just used by getClaudeConfigDir) so callers can
 *  resolve a CANDIDATE value -- e.g. "what would this resolve to if saved" --
 *  without mutating the live module override. Used internally by
 *  buildClaudeConfigDirFields()'s pendingDirExists computation. */
export function resolveClaudeConfigDir(candidate: string | undefined): string {
  return (
    candidate ||
    process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim() ||
    path.join(os.homedir(), CLAUDE_CONFIG_DIR_NAME)
  );
}

/** Resolves to: persisted override -> CLAUDE_CONFIG_DIR env var -> ~/.claude. */
export function getClaudeConfigDir(): string {
  return resolveClaudeConfigDir(override);
}

/** Which of the three sources is currently active, for display in the UI. */
export function getClaudeConfigDirSource(): 'setting' | 'env' | 'default' {
  if (override) return 'setting';
  if (process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim()) return 'env';
  return 'default';
}

/** Test-only: reset module state between test files. */
export function resetClaudeConfigDirOverrideForTests(): void {
  override = undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/hook/claude/claudeConfigDir.ts server/__tests__/claudeConfigDir.test.ts
git commit -m "feat(claude-config-dir): add CLAUDE_CONFIG_DIR resolution core

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `normalizeClaudeConfigDirInput`

**Files:**
- Modify: `server/src/providers/hook/claude/claudeConfigDir.ts`
- Test: `server/__tests__/claudeConfigDir.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/claudeConfigDir.test.ts` (add the import at the top alongside the existing destructured import, and add this new `describe` block at the end of the file, before the final closing — i.e. as a sibling of the existing top-level `describe('claudeConfigDir: resolution', ...)`):

First, update the import line to also pull in `normalizeClaudeConfigDirInput`:

```ts
const {
  getClaudeConfigDir,
  getClaudeConfigDirSource,
  resolveClaudeConfigDir,
  resetClaudeConfigDirOverrideForTests,
  setClaudeConfigDirOverride,
  normalizeClaudeConfigDirInput,
} = await import('../src/providers/hook/claude/claudeConfigDir.js');
```

Then append this new top-level `describe` block at the end of the file:

```ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: FAIL — `normalizeClaudeConfigDirInput is not a function` / import error.

- [ ] **Step 3: Write the implementation**

In `server/src/providers/hook/claude/claudeConfigDir.ts`, add `fs` to the imports and append the new function:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
```

(the existing `import * as os from 'os';` / `import * as path from 'path';` lines stay, just add `fs` above them, alphabetically first)

Then append at the end of the file:

```ts

/** Validates/normalizes settings-modal input: '' clears the override; a
 *  leading `~/` or `~\` expands to this process's home dir; the result is
 *  normalized (collapses `..` and trailing separators) and must be
 *  absolute; a path that already exists but isn't a directory is rejected.
 *  Returns null to signal "reject, don't persist". */
export function normalizeClaudeConfigDirInput(raw: string): string | null {
  if (raw === '') return '';
  const homeExpanded =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  const normalized = path.normalize(homeExpanded);
  if (!path.isAbsolute(normalized)) return null;
  if (fs.existsSync(normalized) && !fs.statSync(normalized).isDirectory()) return null;
  return normalized;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: PASS (27 tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/hook/claude/claudeConfigDir.ts server/__tests__/claudeConfigDir.test.ts
git commit -m "feat(claude-config-dir): add normalizeClaudeConfigDirInput validation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `buildClaudeConfigDirFields`

**Files:**
- Modify: `server/src/providers/hook/claude/claudeConfigDir.ts`
- Test: `server/__tests__/claudeConfigDir.test.ts`

- [ ] **Step 1: Write the failing tests**

Update the destructured import at the top of `server/__tests__/claudeConfigDir.test.ts` once more to add `buildClaudeConfigDirFields`:

```ts
const {
  getClaudeConfigDir,
  getClaudeConfigDirSource,
  resolveClaudeConfigDir,
  resetClaudeConfigDirOverrideForTests,
  setClaudeConfigDirOverride,
  normalizeClaudeConfigDirInput,
  buildClaudeConfigDirFields,
} = await import('../src/providers/hook/claude/claudeConfigDir.js');
```

Append this `describe` block at the end of the file:

```ts

describe('buildClaudeConfigDirFields(rawPersistedValue)', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: FAIL — `buildClaudeConfigDirFields is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to the end of `server/src/providers/hook/claude/claudeConfigDir.ts`:

```ts

/** The five settingsLoaded/claudeConfigDirUpdated fields, computed together
 *  so both server-side emitters -- and both messages -- stay in sync by
 *  construction.
 *
 *  `rawPersistedValue` is the caller's `readConfig().claudeConfigDir` --
 *  passed in rather than read here so this provider-internal module doesn't
 *  reach up into server-level config persistence. `resolved*` reflects the
 *  LIVE module override (set once at boot), which can legitimately differ
 *  from `claudeConfigDir` right after a save -- that gap is what drives the
 *  "restart to apply" notice in the UI. `pendingDirExists` resolves
 *  `rawPersistedValue` through the SAME precedence chain (without touching
 *  the live override) so it describes the directory that WILL be active
 *  after a restart, not the one that's active now. */
export function buildClaudeConfigDirFields(rawPersistedValue: string): {
  claudeConfigDir: string;
  resolvedClaudeConfigDir: string;
  resolvedClaudeConfigDirSource: 'setting' | 'env' | 'default';
  resolvedClaudeConfigDirExists: boolean;
  pendingDirExists: boolean;
} {
  const resolvedClaudeConfigDir = getClaudeConfigDir();
  const pendingDir = resolveClaudeConfigDir(rawPersistedValue || undefined);
  return {
    claudeConfigDir: rawPersistedValue,
    resolvedClaudeConfigDir,
    resolvedClaudeConfigDirSource: getClaudeConfigDirSource(),
    resolvedClaudeConfigDirExists: fs.existsSync(resolvedClaudeConfigDir),
    pendingDirExists: fs.existsSync(pendingDir),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeConfigDir.test.ts`
Expected: PASS (33 tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/hook/claude/claudeConfigDir.ts server/__tests__/claudeConfigDir.test.ts
git commit -m "feat(claude-config-dir): add buildClaudeConfigDirFields

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire `claude.ts`'s `getSessionDirs`/`getAllSessionRoots` to `getClaudeConfigDir()`

**Files:**
- Modify: `server/src/providers/hook/claude/claude.ts`
- Test: `server/__tests__/claude.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `server/__tests__/claude.test.ts`, immediately after the top-level `import` statements and before `describe('claudeProvider', ...)`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

(replace the existing `import { describe, expect, it } from 'vitest';` line with the one above, adding `afterEach`, `beforeEach`, `vi`)

Then add, before the existing `describe('claudeProvider', () => {`:

```ts
let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { resetClaudeConfigDirOverrideForTests, setClaudeConfigDirOverride } = await import(
  '../src/providers/hook/claude/claudeConfigDir.js'
);
```

And add this new top-level `describe` at the end of the file:

```ts

describe('claudeProvider: config dir precedence', () => {
  beforeEach(() => {
    tmpHome = '/tmp/pxl-claude-test-home';
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    resetClaudeConfigDirOverrideForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClaudeConfigDirOverrideForTests();
  });

  describe('getSessionDirs', () => {
    it('resolves under ~/.claude/projects/ by default', () => {
      const dirs = claudeProvider.getSessionDirs?.('/workspace');
      expect(dirs?.[0]).toContain(`${tmpHome}/.claude/projects/`);
    });

    it('resolves under the env var when CLAUDE_CONFIG_DIR is set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      const dirs = claudeProvider.getSessionDirs?.('/workspace');
      expect(dirs?.[0]).toContain('/env/claude/projects/');
    });

    it('resolves under the override when set (even with env var also set)', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      setClaudeConfigDirOverride('/setting/claude');
      const dirs = claudeProvider.getSessionDirs?.('/workspace');
      expect(dirs?.[0]).toContain('/setting/claude/projects/');
    });
  });

  describe('getAllSessionRoots', () => {
    it('resolves under ~/.claude/projects by default', () => {
      const roots = claudeProvider.getAllSessionRoots?.();
      expect(roots?.[0]).toBe(`${tmpHome}/.claude/projects`);
    });

    it('resolves under the env var when set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      const roots = claudeProvider.getAllSessionRoots?.();
      expect(roots?.[0]).toBe('/env/claude/projects');
    });

    it('resolves under the override when set', () => {
      setClaudeConfigDirOverride('/setting/claude');
      const roots = claudeProvider.getAllSessionRoots?.();
      expect(roots?.[0]).toBe('/setting/claude/projects');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claude.test.ts`
Expected: FAIL — the "resolves under the env var" and "resolves under the override" cases fail because `getSessionDirs`/`getAllSessionRoots` still hardcode `os.homedir()` directly, ignoring the env var/override.

- [ ] **Step 3: Write the implementation**

In `server/src/providers/hook/claude/claude.ts`:

Replace the import block (lines 1-22) with:

```ts
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { getClaudeConfigDir } from './claudeConfigDir.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './claudeHookInstaller.js';
import { claudeTeamProvider } from './claudeTeamProvider.js';
import {
  CLAUDE_LARGE_CONTEXT_WINDOW,
  CLAUDE_SMALL_CONTEXT_MODEL_PATTERN,
  CLAUDE_SMALL_CONTEXT_WINDOW,
  CLAUDE_TERMINAL_NAME_PREFIX,
} from './constants.js';
```

(this drops `import * as os from 'os';` — it's no longer used in this file once the two functions below stop calling `os.homedir()` directly — and adds the new `getClaudeConfigDir` import)

Replace `getSessionDirs` (currently lines 76-99):

```ts
function getSessionDirs(workspacePath: string): string[] {
  // Claude stores sessions at <CLAUDE_CONFIG_DIR>/projects/<workspace-path-with-dashes>/,
  // defaulting to ~/.claude when CLAUDE_CONFIG_DIR isn't set.
  const dirName = normalizeProjectPath(workspacePath);
  const projectDir = path.join(getClaudeConfigDir(), 'projects', dirName);

  // Try exact match first.
  if (fs.existsSync(projectDir)) return [projectDir];

  // Case-insensitive fallback for Windows: drive letter casing can differ
  // between what VS Code gives us (e.g. "c:\...") and Claude's encoding ("C:\...").
  const projectsRoot = path.join(getClaudeConfigDir(), 'projects');
  try {
    if (fs.existsSync(projectsRoot)) {
      const lowerDirName = dirName.toLowerCase();
      const match = fs.readdirSync(projectsRoot).find((c) => c.toLowerCase() === lowerDirName);
      if (match) return [path.join(projectsRoot, match)];
    }
  } catch {
    /* ignore scan errors */
  }

  // Return the expected path even if it doesn't exist yet (caller tolerates missing dirs).
  return [projectDir];
}
```

Replace `getAllSessionRoots` (currently lines 111-115):

```ts
/** Root that holds every Claude session across all workspaces. Used by the
 *  global session scanner ("Watch All Sessions"). */
function getAllSessionRoots(): string[] {
  return [path.join(getClaudeConfigDir(), 'projects')];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claude.test.ts`
Expected: PASS (all tests, including the new `claudeProvider: config dir precedence` block)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors (confirms `os` import removal didn't leave a dangling reference).

- [ ] **Step 6: Lint**

Run: `cd server && npx eslint src/providers/hook/claude/claude.ts`
Expected: no errors (confirms no unused-import warning survives).

- [ ] **Step 7: Commit**

```bash
git add server/src/providers/hook/claude/claude.ts server/__tests__/claude.test.ts
git commit -m "feat(claude-config-dir): wire getSessionDirs/getAllSessionRoots to CLAUDE_CONFIG_DIR

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire `claudeHookInstaller.ts` — thread explicit-dir through, add `uninstallHooksAt`

**Files:**
- Modify: `server/src/providers/hook/claude/claudeHookInstaller.ts`
- Modify: `server/__tests__/claudeHookInstaller.test.ts`

- [ ] **Step 1: Write the failing tests**

Read the current `server/__tests__/claudeHookInstaller.test.ts` first — it mocks `os.homedir()` to a temp dir and tests `installHooks`/`uninstallHooks`/`areHooksInstalled`/`copyHookScript` against it. Add `vi.stubEnv`/`resetClaudeConfigDirOverrideForTests` isolation and new `uninstallHooksAt`/override-path cases.

Change the top of the file from:

```ts
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
```

to:

```ts
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
const { resetClaudeConfigDirOverrideForTests } = await import(
  '../src/providers/hook/claude/claudeConfigDir.js'
);

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
```

Then append this new `describe` block just before the final closing `});` of the outer `describe('claudeHookInstaller', ...)` block:

```ts

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
      fs.writeFileSync(
        path.join(altDir, 'settings.json'),
        JSON.stringify(readSettings()),
        'utf-8',
      );

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

      const settings = readSettings(envDir);
      expect(settings.hooks).toBeTruthy();
      // tmpBase (the mocked homedir) never got a settings.json written to it.
      expect(fs.existsSync(path.join(tmpBase, '.claude', 'settings.json'))).toBe(false);

      fs.rmSync(envDir, { recursive: true, force: true });
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeHookInstaller.test.ts`
Expected: FAIL — `uninstallHooksAt is not a function` / import error, plus the "with CLAUDE_CONFIG_DIR set" case fails because `installHooks()` still writes under the mocked `os.homedir()` regardless of the env var.

- [ ] **Step 3: Write the implementation**

Rewrite `server/src/providers/hook/claude/claudeHookInstaller.ts` in full. Note `os` stays imported here — unlike `claude.ts` (Task 5) and `claudeTeamProvider.ts` (Task 7), this file still calls `os.homedir()` directly in `getHookScriptPath()`, which is unrelated to Claude's config dir (it's Pixel Agents' own `~/.pixel-agents/hooks/` namespace, untouched by this feature):

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { getClaudeConfigDir } from './claudeConfigDir.js';
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_SCRIPT_NAME } from './constants.js';

/** Marker string used to identify Pixel Agents hook entries in Claude's settings. */
const HOOK_SCRIPT_MARKER = CLAUDE_HOOK_SCRIPT_NAME;

/** A single hook entry in Claude Code's <CLAUDE_CONFIG_DIR>/settings.json hooks config. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

/** Partial shape of <CLAUDE_CONFIG_DIR>/settings.json (only the hooks field is relevant). */
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

/** Returns the absolute path to <dir>/settings.json, defaulting to the
 *  currently-resolved Claude config directory. */
function getClaudeSettingsPath(dir: string = getClaudeConfigDir()): string {
  return path.join(dir, 'settings.json');
}

/** Returns the destination path for the hook script (~/.pixel-agents/hooks/claude-hook.js).
 *  Always under Pixel Agents' own namespace -- unrelated to Claude's config dir. */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CLAUDE_HOOK_SCRIPT_NAME);
}

/** Read and parse <dir>/settings.json. Returns empty object if missing or malformed. */
function readClaudeSettings(dir?: string): ClaudeSettings {
  const settingsPath = getClaudeSettingsPath(dir);
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Claude settings: ${e}`);
  }
  return {};
}

/** Write settings back to <dir>/settings.json via atomic tmp + rename. */
function writeClaudeSettings(settings: ClaudeSettings, dir?: string): void {
  const settingsPath = getClaudeSettingsPath(dir);
  const settingsDir = path.dirname(settingsPath);
  try {
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    // Atomic write via tmp file + rename
    const tmpPath = settingsPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Claude settings: ${e}`);
  }
}

/** Legacy script name (before rename to claude-hook.js). */
const LEGACY_HOOK_MARKER = 'pixel-agents-hook.js';

/** Check if a hook entry belongs to Pixel Agents (current or legacy script name). */
function isOurHookEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some(
    (h) => h.command.includes(HOOK_SCRIPT_MARKER) || h.command.includes(LEGACY_HOOK_MARKER),
  );
}

/** Build the shell command that Claude Code will execute for each hook event. */
function makeHookCommand(): string {
  const scriptPath = getHookScriptPath();
  return `node "${scriptPath}"`;
}

/** Create a hook entry object for Claude's settings.json. Matcher is empty (catch-all). */
function makeHookEntry(): ClaudeHookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: makeHookCommand(),
        timeout: 5,
      },
    ],
  };
}

/** Check if Pixel Agents hooks are already installed in the resolved settings.json. */
export function areHooksInstalled(): boolean {
  const settings = readClaudeSettings();
  if (!settings.hooks) return false;
  const events = CLAUDE_HOOK_EVENTS;
  return events.every((event) => {
    const entries = settings.hooks?.[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

/**
 * Install Pixel Agents hook entries into the resolved settings.json.
 * Idempotent: removes any existing Pixel Agents entries before adding fresh ones.
 */
export function installHooks(): void {
  const settings = readClaudeSettings();
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const events = CLAUDE_HOOK_EVENTS;
  let changed = false;

  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }
    const entries = settings.hooks[event];
    // Remove any existing Pixel Agents entries (in case script path changed)
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    filtered.push(makeHookEntry());
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeClaudeSettings(settings);
    console.log(`[Pixel Agents] Hooks installed in ${getClaudeSettingsPath()}`);
  }
}

/** Remove all Pixel Agents hook entries from the resolved settings.json. */
export function uninstallHooks(): void {
  uninstallHooksAt(getClaudeConfigDir());
}

/** Remove all Pixel Agents hook entries from <dir>/settings.json. Cleans up
 *  empty objects. A no-op (not an error) if nothing is installed there. Used
 *  directly (rather than always going through the ambient uninstallHooks())
 *  by the boot-time stale-hook cleanup in claudeConfigDirBoot.ts, which needs
 *  to target a specific PREVIOUS directory, not wherever the live override
 *  currently resolves to. */
export function uninstallHooksAt(dir: string): void {
  const settings = readClaudeSettings(dir);
  if (!settings.hooks) return;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    if (filtered.length !== entries.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    writeClaudeSettings(settings, dir);
    console.log(`[Pixel Agents] Hooks removed from ${getClaudeSettingsPath(dir)}`);
  }
}

/** Copy the shipped hook script from the extension to ~/.pixel-agents/hooks/.
 *  Returns true if the script was copied, false if the source was missing or the
 *  copy failed, so callers can report the failure instead of logging a false
 *  success (issue #333: a path regression silently installed nothing). */
export function copyHookScript(extensionPath: string): boolean {
  const src = path.join(extensionPath, 'dist', 'hooks', CLAUDE_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hook script not found at ${src}`);
      return false;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Hook script installed at ${dst}`);
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy hook script: ${e}`);
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeHookInstaller.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/hook/claude/claudeHookInstaller.ts server/__tests__/claudeHookInstaller.test.ts
git commit -m "feat(claude-config-dir): thread explicit dir through hook installer, add uninstallHooksAt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire `claudeTeamProvider.ts`'s `getTeamMembers` to `getClaudeConfigDir()`

**Files:**
- Modify: `server/src/providers/hook/claude/claudeTeamProvider.ts`
- Modify: `server/__tests__/claudeTeamProvider.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/__tests__/claudeTeamProvider.test.ts`, change the top imports from:

```ts
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
```

to:

```ts
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetClaudeConfigDirOverrideForTests } from '../src/providers/hook/claude/claudeConfigDir.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
```

Then, in the existing `describe('getTeamMembers', ...)` block, add a `beforeEach`/`afterEach` pair for env isolation right before the existing `afterEach`:

```ts
  describe('getTeamMembers', () => {
    // Writes under ~/.claude/teams/<TEAM_NAME>/ and cleans up in afterEach.
    const fs = require('fs') as typeof import('fs');
    const TEAM_NAME = 'test-team-' + Date.now();

    beforeEach(() => {
      // This file uses the REAL os.homedir() (no mock), so an inherited
      // CLAUDE_CONFIG_DIR on a developer machine would silently redirect
      // every test below away from ~/.claude/teams/ -- neutralize it.
      vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      resetClaudeConfigDirOverrideForTests();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      resetClaudeConfigDirOverrideForTests();
      // Cleanup any test artifacts
      try {
        fs.rmSync(path.join(os.homedir(), '.claude', 'teams', TEAM_NAME), {
          recursive: true,
          force: true,
        });
      } catch {
        /* ignore */
      }
    });
```

And append this new test at the end of the `describe('getTeamMembers', ...)` block, right before its closing `});`:

```ts

    it('reads the team config from CLAUDE_CONFIG_DIR when set, not ~/.claude', () => {
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-team-env-'));
      vi.stubEnv('CLAUDE_CONFIG_DIR', envDir);
      const teamDir = path.join(envDir, 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ members: [{ name: 'env-teammate' }] }),
      );

      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect(result).not.toBeNull();
      expect([...result!]).toEqual(['env-teammate']);

      fs.rmSync(envDir, { recursive: true, force: true });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeTeamProvider.test.ts`
Expected: FAIL on the new "reads the team config from CLAUDE_CONFIG_DIR" case — `getTeamMembers` still hardcodes `os.homedir()` directly, so it looks in `~/.claude/teams/...` instead of `envDir/teams/...`.

- [ ] **Step 3: Write the implementation**

In `server/src/providers/hook/claude/claudeTeamProvider.ts`:

Change the top import block from:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';
```

to:

```ts
import * as fs from 'fs';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';
import { getClaudeConfigDir } from './claudeConfigDir.js';
```

Change the `getTeamMembers` implementation (currently at line 249-250) from:

```ts
  getTeamMembers(teamName) {
    const configPath = path.join(os.homedir(), '.claude', 'teams', teamName, 'config.json');
```

to:

```ts
  getTeamMembers(teamName) {
    const configPath = path.join(getClaudeConfigDir(), 'teams', teamName, 'config.json');
```

Confirm this is the only `os.homedir()` usage left in the file by searching for other occurrences (there should be none — `os` becomes entirely unused).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeTeamProvider.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `cd server && npx eslint src/providers/hook/claude/claudeTeamProvider.ts`
Expected: no errors (confirms the `os` import was fully removed, not left dangling).

- [ ] **Step 7: Commit**

```bash
git add server/src/providers/hook/claude/claudeTeamProvider.ts server/__tests__/claudeTeamProvider.test.ts
git commit -m "feat(claude-config-dir): wire getTeamMembers to CLAUDE_CONFIG_DIR

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Re-export the new functions from `providers/index.ts`

**Files:**
- Modify: `server/src/providers/index.ts`

- [ ] **Step 1: Update the re-exports**

Replace the full contents of `server/src/providers/index.ts` with:

```ts
/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

export { claudeProvider } from './hook/claude/claude.js';
export {
  buildClaudeConfigDirFields,
  getClaudeConfigDir,
  getClaudeConfigDirSource,
  normalizeClaudeConfigDirInput,
  setClaudeConfigDirOverride,
} from './hook/claude/claudeConfigDir.js';
export { copyHookScript, uninstallHooksAt } from './hook/claude/claudeHookInstaller.js';
```

(`resolveClaudeConfigDir` and `resetClaudeConfigDirOverrideForTests` are deliberately NOT re-exported here — the former is only used internally within `claudeConfigDir.ts`, the latter is a test-only escape hatch that test files import directly from `claudeConfigDir.js`, same as `claudeHookInstaller.test.ts` already imports installer internals directly.)

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full server test suite so far**

Run: `cd server && npx vitest run`
Expected: PASS — this confirms the re-export doesn't break any existing consumer of `providers/index.ts`.

- [ ] **Step 4: Commit**

```bash
git add server/src/providers/index.ts
git commit -m "feat(claude-config-dir): re-export config-dir functions from providers/index.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `buildLaunchCommand` includes `CLAUDE_CONFIG_DIR` in its `env`

**Files:**
- Modify: `server/src/providers/hook/claude/claude.ts`
- Modify: `server/__tests__/claude.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('claudeProvider: config dir precedence', ...)` block added in Task 5 (inside it, as a sibling of `getSessionDirs`/`getAllSessionRoots`):

```ts

  describe('buildLaunchCommand', () => {
    it('does not include CLAUDE_CONFIG_DIR in env when using the default', () => {
      const launch = claudeProvider.buildLaunchCommand?.('sess-1', '/cwd');
      expect(launch?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('includes CLAUDE_CONFIG_DIR in env when the env var itself is set', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
      const launch = claudeProvider.buildLaunchCommand?.('sess-1', '/cwd');
      expect(launch?.env?.CLAUDE_CONFIG_DIR).toBe('/env/claude');
    });

    it('includes CLAUDE_CONFIG_DIR in env when the override is set', () => {
      setClaudeConfigDirOverride('/setting/claude');
      const launch = claudeProvider.buildLaunchCommand?.('sess-1', '/cwd');
      expect(launch?.env?.CLAUDE_CONFIG_DIR).toBe('/setting/claude');
    });

    it('always includes PWD in env', () => {
      const launch = claudeProvider.buildLaunchCommand?.('sess-1', '/cwd');
      expect(launch?.env?.PWD).toBe('/cwd');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claude.test.ts`
Expected: FAIL — `buildLaunchCommand`'s `env` is still hardcoded to `{ PWD: cwd }` only, so `env.CLAUDE_CONFIG_DIR` is always `undefined`.

- [ ] **Step 3: Write the implementation**

In `server/src/providers/hook/claude/claude.ts`, add `getClaudeConfigDirSource` to the existing `claudeConfigDir.js` import (from Task 5):

```ts
import { getClaudeConfigDir, getClaudeConfigDirSource } from './claudeConfigDir.js';
```

Add `CLAUDE_CONFIG_DIR_ENV_VAR` to the existing `constants.js` import:

```ts
import {
  CLAUDE_CONFIG_DIR_ENV_VAR,
  CLAUDE_LARGE_CONTEXT_WINDOW,
  CLAUDE_SMALL_CONTEXT_MODEL_PATTERN,
  CLAUDE_SMALL_CONTEXT_WINDOW,
  CLAUDE_TERMINAL_NAME_PREFIX,
} from './constants.js';
```

Replace `buildLaunchCommand` (currently lines 101-109):

```ts
function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args = ['--session-id', sessionId];
  if (opts?.bypassPermissions) args.push('--dangerously-skip-permissions');
  const env: Record<string, string> = { PWD: cwd };
  if (getClaudeConfigDirSource() !== 'default') {
    env[CLAUDE_CONFIG_DIR_ENV_VAR] = getClaudeConfigDir();
  }
  return { command: 'claude', args, env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claude.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/hook/claude/claude.ts server/__tests__/claude.test.ts
git commit -m "feat(claude-config-dir): buildLaunchCommand propagates CLAUDE_CONFIG_DIR

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `agentManager.ts` passes `launch.env` into the spawned terminal

**Files:**
- Modify: `adapters/vscode/agentManager.ts`

No dedicated unit test for this file — it has no existing Vitest coverage (it depends on the `vscode` module, like the rest of `adapters/vscode/`, which this repo doesn't unit-test). This is a documented, accepted gap (see the spec's Testing section). The existing VS Code e2e specs that launch agents via the panel button serve as a regression check.

- [ ] **Step 1: Reorder `sessionId` generation and `buildLaunchCommand` above `createTerminal`, and pass `launch.env`**

In `adapters/vscode/agentManager.ts`, replace this block (currently lines 58-77):

```ts
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  const sessionId = crypto.randomUUID();
  const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
  if (!launch) {
    throw new Error('claudeProvider.buildLaunchCommand is not implemented');
  }
  terminal.sendText([launch.command, ...launch.args].join(' '));
```

with:

```ts
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  // sessionId + buildLaunchCommand must run BEFORE createTerminal now: the
  // terminal needs launch.env (carries CLAUDE_CONFIG_DIR when an override is
  // active) at creation time, not after.
  const sessionId = crypto.randomUUID();
  const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
  if (!launch) {
    throw new Error('claudeProvider.buildLaunchCommand is not implemented');
  }
  const terminal = vscode.window.createTerminal({
    name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
    env: launch.env,
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }
  terminal.sendText([launch.command, ...launch.args].join(' '));
```

(`vscode.TerminalOptions.env` merges with the terminal's inherited environment by default — it only replaces it if `strictEnv: true` is also passed, which this doesn't — so passing `launch.env` here is additive, not a full environment replacement.)

- [ ] **Step 2: Type-check**

Run: `cd /Users/sergicastro/workspace/pixel-agents && npx tsc --noEmit -p .`

(This project's root `tsconfig.json` covers the VS Code adapter; `server`'s own `tsc --noEmit` doesn't include `adapters/`. If there's a dedicated extension type-check script, prefer it — check `package.json`'s `check-types` script first: `npm run check-types`.)

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add adapters/vscode/agentManager.ts
git commit -m "feat(claude-config-dir): pass launch.env into self-launched terminals

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `configPersistence.ts` — `claudeConfigDir` (shared) + `claudeConfigDirHooksInstalledAt` (per-namespace)

**Files:**
- Modify: `server/src/configPersistence.ts`
- Modify: `server/__tests__/configPersistence.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new top-level `describe` block to `server/__tests__/configPersistence.test.ts`, after the existing `describe('configPersistence: areas', ...)` closing `});`:

```ts

describe('configPersistence: claude config dir', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-config-claudedir-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('claudeConfigDir (shared, top-level)', () => {
    it('defaults to "" when no config file exists', () => {
      const cfg = readConfig();
      expect(cfg.claudeConfigDir).toBe('');
    });

    it('round-trips a set value', () => {
      const cfg = readConfig();
      cfg.claudeConfigDir = '/custom/claude';
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.claudeConfigDir).toBe('/custom/claude');
    });

    it('defaults to "" on a non-string value in a hand-edited config.json', () => {
      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ claudeConfigDir: 42 }),
        'utf-8',
      );
      expect(readConfig().claudeConfigDir).toBe('');
    });
  });

  describe('claudeConfigDirHooksInstalledAt (per-namespace)', () => {
    it('defaults to "" for both namespaces when no config file exists', () => {
      const cfg = readConfig();
      expect(cfg.vscode.claudeConfigDirHooksInstalledAt).toBe('');
      expect(cfg.standalone.claudeConfigDirHooksInstalledAt).toBe('');
    });

    it('round-trips independently per namespace', () => {
      const cfg = readConfig();
      cfg.vscode.claudeConfigDirHooksInstalledAt = '/vscode/claude';
      cfg.standalone.claudeConfigDirHooksInstalledAt = '/standalone/claude';
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.claudeConfigDirHooksInstalledAt).toBe('/vscode/claude');
      expect(reloaded.standalone.claudeConfigDirHooksInstalledAt).toBe('/standalone/claude');
    });

    it('setting one namespace does not touch the other', () => {
      const cfg = readConfig();
      cfg.vscode.claudeConfigDirHooksInstalledAt = '/vscode/claude';
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.claudeConfigDirHooksInstalledAt).toBe('/vscode/claude');
      expect(reloaded.standalone.claudeConfigDirHooksInstalledAt).toBe('');
    });

    it('defaults to "" on a non-string value in a hand-edited config.json', () => {
      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ vscode: { claudeConfigDirHooksInstalledAt: 42 } }),
        'utf-8',
      );
      expect(readConfig().vscode.claudeConfigDirHooksInstalledAt).toBe('');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/configPersistence.test.ts`
Expected: FAIL — `cfg.claudeConfigDir` and `cfg.vscode.claudeConfigDirHooksInstalledAt` are both `undefined`, not `''`.

- [ ] **Step 3: Write the implementation**

In `server/src/configPersistence.ts`:

Add `claudeConfigDirHooksInstalledAt` to `AdapterSettings`:

```ts
export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
  claudeConfigDirHooksInstalledAt: string;
}
```

Add it to `ADAPTER_SETTING_KEYS`:

```ts
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'watchAllSessions',
  'hooksEnabled',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
  'claudeConfigDirHooksInstalledAt',
] as const;
```

Add `claudeConfigDir` to `PixelAgentsConfig`:

```ts
export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  claudeConfigDir: string;
}
```

Add the default to `DEFAULT_ADAPTER_SETTINGS`:

```ts
const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
  claudeConfigDirHooksInstalledAt: '',
};
```

Add the parse case to `parseAdapterSettings`:

```ts
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksEnabled:
      typeof obj.hooksEnabled === 'boolean'
        ? obj.hooksEnabled
        : DEFAULT_ADAPTER_SETTINGS.hooksEnabled,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
    claudeConfigDirHooksInstalledAt:
      typeof obj.claudeConfigDirHooksInstalledAt === 'string'
        ? obj.claudeConfigDirHooksInstalledAt
        : DEFAULT_ADAPTER_SETTINGS.claudeConfigDirHooksInstalledAt,
  };
}
```

Update `readConfig()`'s three return sites (no-file case, success case, error case) to include `claudeConfigDir`:

```ts
export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
        claudeConfigDir: '',
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      claudeConfigDir: typeof parsed.claudeConfigDir === 'string' ? parsed.claudeConfigDir : '',
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
      claudeConfigDir: '',
    };
  }
}
```

(`writeConfig()` needs no change — it already serializes the whole `PixelAgentsConfig` object verbatim via `JSON.stringify(config, null, 2)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/configPersistence.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors — this will surface any other call site constructing a `PixelAgentsConfig`/`AdapterSettings` object literal that needs the new fields added. If any turn up, add the field with an empty-string default there too.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS — confirms nothing else broke from the interface changes.

- [ ] **Step 7: Commit**

```bash
git add server/src/configPersistence.ts server/__tests__/configPersistence.test.ts
git commit -m "feat(claude-config-dir): add claudeConfigDir + per-namespace claudeConfigDirHooksInstalledAt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Boot module — `prepareClaudeConfigDirForBoot`, `recordClaudeConfigDirHooksInstalled`

**Files:**
- Create: `server/src/claudeConfigDirBoot.ts`
- Test: `server/__tests__/claudeConfigDirBoot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/claudeConfigDirBoot.test.ts`:

```ts
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
const { resetClaudeConfigDirOverrideForTests, getClaudeConfigDir } = await import(
  '../src/providers/hook/claude/claudeConfigDir.js'
);
const { areHooksInstalled, installHooks } = await import(
  '../src/providers/hook/claude/claudeHookInstaller.js'
);
const { prepareClaudeConfigDirForBoot, recordClaudeConfigDirHooksInstalled } = await import(
  '../src/claudeConfigDirBoot.js'
);

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
      installHooks(); // installs at the default ~/.claude for this mocked home
      prepareClaudeConfigDirForBoot('standalone'); // record is still '' -- nothing to clean up
      expect(areHooksInstalled()).toBe(true); // untouched
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
      installHooks(); // installs at oldDir (the currently-resolved dir)
      expect(fs.existsSync(path.join(oldDir, 'settings.json'))).toBe(true);

      // ...then the setting changes to a new location, and this is the next boot.
      const cfg2 = readConfig();
      cfg2.claudeConfigDir = '/new/claude/dir';
      cfg2.standalone.claudeConfigDirHooksInstalledAt = oldDir;
      writeConfig(cfg2);
      resetClaudeConfigDirOverrideForTests(); // simulate a fresh process boot

      prepareClaudeConfigDirForBoot('standalone');

      const oldSettings = JSON.parse(
        fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf-8'),
      );
      expect(oldSettings.hooks).toBeUndefined(); // cleaned up
      expect(getClaudeConfigDir()).toBe('/new/claude/dir'); // override is now live
    });

    it('does NOT act on a different namespace\'s record (cross-surface fix)', () => {
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
        JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "claude-hook.js"' }] }] } }),
      );

      prepareClaudeConfigDirForBoot('standalone'); // booting the OTHER surface

      const oldSettings = JSON.parse(
        fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf-8'),
      );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/claudeConfigDirBoot.test.ts`
Expected: FAIL — `Cannot find module '../src/claudeConfigDirBoot.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/claudeConfigDirBoot.ts`:

```ts
import type { ConfigNamespace } from './configPersistence.js';
import { readConfig, writeConfig } from './configPersistence.js';
import {
  getClaudeConfigDir,
  setClaudeConfigDirOverride,
} from './providers/hook/claude/claudeConfigDir.js';
import { uninstallHooksAt } from './providers/hook/claude/claudeHookInstaller.js';

/**
 * 1: set the live override from the persisted setting. 2: if THIS SURFACE's
 * hooks might still be sitting in a DIFFERENT directory than the one that's
 * now resolved, remove them from there -- cheap no-op if there's nothing to
 * clean up.
 *
 * Call once, as early as possible in boot, before any code path can reach
 * installHooks(). `namespace` scopes the installed-at record to this
 * surface only (vscode vs standalone) so VS Code and standalone can never
 * uninstall hooks the other surface is relying on -- each only ever
 * compares against, and cleans up, its own record.
 */
export function prepareClaudeConfigDirForBoot(namespace: ConfigNamespace): void {
  const cfg = readConfig();
  setClaudeConfigDirOverride(cfg.claudeConfigDir || undefined);
  const resolvedDir = getClaudeConfigDir();
  const installedAt = cfg[namespace].claudeConfigDirHooksInstalledAt;
  if (installedAt && installedAt !== resolvedDir) {
    uninstallHooksAt(installedAt);
  }
}

/**
 * 3: record where THIS SURFACE's hooks now live, once installHooks() has
 * actually succeeded. Call from EVERY installHooks() call site on this
 * surface (both the boot-time install and the settings-modal hooks-enabled
 * toggle), not just boot -- missing either one reopens the orphaned-hooks
 * bug this module exists to fix.
 */
export function recordClaudeConfigDirHooksInstalled(namespace: ConfigNamespace): void {
  const cfg = readConfig(); // re-read rather than reuse prepareClaudeConfigDirForBoot()'s cfg
  cfg[namespace].claudeConfigDirHooksInstalledAt = getClaudeConfigDir();
  writeConfig(cfg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/claudeConfigDirBoot.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/claudeConfigDirBoot.ts server/__tests__/claudeConfigDirBoot.test.ts
git commit -m "feat(claude-config-dir): add boot-time stale-hook cleanup module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: AsyncAPI protocol — `SetClaudeConfigDir`, `settingsLoaded` +5 fields, `ClaudeConfigDirUpdated`

**Files:**
- Modify: `core/asyncapi.yaml`
- Modify: `core/src/messages.ts` (generated — do not hand-edit, regenerate)

- [ ] **Step 1: Add `SetClaudeConfigDir` to the `ClientMessage` `oneOf` list**

In `core/asyncapi.yaml`, find the `ClientMessage` `oneOf` list (currently ends with `RequestDiagnostics`) and add a new entry right after `SetShowAreas`:

```yaml
    ClientMessage:
      oneOf:
        - $ref: '#/components/schemas/WebviewReady'
        - $ref: '#/components/schemas/LaunchAgent'
        - $ref: '#/components/schemas/FocusAgent'
        - $ref: '#/components/schemas/CloseAgent'
        - $ref: '#/components/schemas/SaveAgentSeats'
        - $ref: '#/components/schemas/SaveLayout'
        - $ref: '#/components/schemas/SetSoundEnabled'
        - $ref: '#/components/schemas/SetLastSeenVersion'
        - $ref: '#/components/schemas/SetAlwaysShowLabels'
        - $ref: '#/components/schemas/SetGhostHeadlessAgents'
        - $ref: '#/components/schemas/SetHooksEnabled'
        - $ref: '#/components/schemas/SetHooksInfoShown'
        - $ref: '#/components/schemas/SetWatchAllSessions'
        - $ref: '#/components/schemas/ExportLayout'
        - $ref: '#/components/schemas/ImportLayout'
        - $ref: '#/components/schemas/OpenSessionsFolder'
        - $ref: '#/components/schemas/AddExternalAssetDirectory'
        - $ref: '#/components/schemas/RemoveExternalAssetDirectory'
        - $ref: '#/components/schemas/SaveAreaMappings'
        - $ref: '#/components/schemas/SetShowAreas'
        - $ref: '#/components/schemas/SetClaudeConfigDir'
        - $ref: '#/components/schemas/RequestDiagnostics'
      discriminator: type
```

(only the new `SetClaudeConfigDir` line is added, right before `RequestDiagnostics`)

- [ ] **Step 2: Add `ClaudeConfigDirUpdated` to the `ServerMessage` `oneOf` list**

In the same file, find the `ServerMessage` `oneOf` list's "Settings & config" group and add a new entry after `ExternalAssetDirectoriesUpdated`:

```yaml
        # Settings & config
        - $ref: '#/components/schemas/SettingsLoaded'
        - $ref: '#/components/schemas/ExternalAssetDirectoriesUpdated'
        - $ref: '#/components/schemas/ClaudeConfigDirUpdated'
        - $ref: '#/components/schemas/AreaMappingsLoaded'
        - $ref: '#/components/schemas/WorkspaceFolders'
```

- [ ] **Step 3: Add the five new fields to `SettingsLoaded`**

Replace the `SettingsLoaded` schema (find it by its `description: All persisted user-level settings, sent once on connect.` line) with:

```yaml
    SettingsLoaded:
      description: All persisted user-level settings, sent once on connect.
      type: object
      additionalProperties: false
      required:
        - type
        - soundEnabled
        - lastSeenVersion
        - extensionVersion
        - watchAllSessions
        - alwaysShowLabels
        - ghostHeadlessAgents
        - hooksEnabled
        - hooksInfoShown
        - externalAssetDirectories
        - showAreas
        - claudeConfigDir
        - resolvedClaudeConfigDir
        - resolvedClaudeConfigDirSource
        - resolvedClaudeConfigDirExists
        - pendingDirExists
      properties:
        type:
          const: settingsLoaded
        soundEnabled:
          type: boolean
        lastSeenVersion:
          type: string
        extensionVersion:
          type: string
        watchAllSessions:
          type: boolean
        alwaysShowLabels:
          type: boolean
        ghostHeadlessAgents:
          type: boolean
        hooksEnabled:
          type: boolean
        hooksInfoShown:
          type: boolean
        externalAssetDirectories:
          type: array
          items:
            type: string
        showAreas:
          type: boolean
        claudeConfigDir:
          type: string
          description: Raw persisted CLAUDE_CONFIG_DIR override; '' means unset.
        resolvedClaudeConfigDir:
          type: string
          description: What the server actually resolves to right now (setting, env var, or default).
        resolvedClaudeConfigDirSource:
          type: string
          description: Which source produced resolvedClaudeConfigDir -- 'setting', 'env', or 'default'.
        resolvedClaudeConfigDirExists:
          type: boolean
          description: Whether resolvedClaudeConfigDir exists on disk right now.
        pendingDirExists:
          type: boolean
          description: Whether claudeConfigDir would resolve to an existing directory after a restart.
```

- [ ] **Step 4: Add the `SetClaudeConfigDir` and `ClaudeConfigDirUpdated` schemas**

In the same file, find `AddExternalAssetDirectory` (a `ClientMessage` variant) and add `SetClaudeConfigDir` right after it (order doesn't matter functionally, but keeping related schemas near each other matches this file's existing style):

```yaml
    SetClaudeConfigDir:
      description: Set or clear the CLAUDE_CONFIG_DIR settings-modal override. Empty string clears it.
      type: object
      additionalProperties: false
      required: [type, claudeConfigDir]
      properties:
        type:
          const: setClaudeConfigDir
        claudeConfigDir:
          type: string
```

Find `ExternalAssetDirectoriesUpdated` (a `ServerMessage` variant) and add `ClaudeConfigDirUpdated` right after it:

```yaml
    ClaudeConfigDirUpdated:
      description: >-
        Sent in reply to setClaudeConfigDir so the webview refreshes
        immediately without waiting for the next webviewReady.
      type: object
      additionalProperties: false
      required:
        - type
        - claudeConfigDir
        - resolvedClaudeConfigDir
        - resolvedClaudeConfigDirSource
        - resolvedClaudeConfigDirExists
        - pendingDirExists
      properties:
        type:
          const: claudeConfigDirUpdated
        claudeConfigDir:
          type: string
        resolvedClaudeConfigDir:
          type: string
        resolvedClaudeConfigDirSource:
          type: string
        resolvedClaudeConfigDirExists:
          type: boolean
        pendingDirExists:
          type: boolean
```

- [ ] **Step 5: Validate the AsyncAPI document**

Run: `npm run asyncapi:validate`
Expected: no errors.

- [ ] **Step 6: Regenerate `core/src/messages.ts`**

Run: `npm run asyncapi:generate`
Expected: `core/src/messages.ts` is rewritten (git diff shows new `SetClaudeConfigDir`, `SettingsLoaded` (with 5 new fields), `ClaudeConfigDirUpdated` types added to the discriminated unions).

- [ ] **Step 7: Type-check**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts
git commit -m "feat(claude-config-dir): add SetClaudeConfigDir/ClaudeConfigDirUpdated to protocol

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: `clientMessageHandler.ts` — `applySetClaudeConfigDir` + wiring

**Files:**
- Modify: `server/src/clientMessageHandler.ts`
- Modify: `server/__tests__/clientMessageHandler.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new top-level `describe` block to `server/__tests__/clientMessageHandler.test.ts`, after the existing outer `describe`'s closing `});`. First check the existing file's imports (`handleClientMessage`, `readConfig`, `AgentStateStore`, `FileStateAdapter` are already imported per the pattern read earlier) and add `applySetClaudeConfigDir`:

Change the import block at the top from:

```ts
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
```

to:

```ts
import {
  applySetClaudeConfigDir,
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
```

Then append this new top-level `describe` block at the end of the file:

```ts

describe('clientMessageHandler: setClaudeConfigDir', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-ccd-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('applySetClaudeConfigDir', () => {
    it('persists a valid absolute path and returns the five fields', () => {
      const fields = applySetClaudeConfigDir('/custom/claude');
      expect(fields).not.toBeNull();
      expect(fields?.claudeConfigDir).toBe('/custom/claude');
      expect(readConfig().claudeConfigDir).toBe('/custom/claude');
    });

    it('persists blank and clears the setting', () => {
      applySetClaudeConfigDir('/custom/claude');
      const fields = applySetClaudeConfigDir('');
      expect(fields?.claudeConfigDir).toBe('');
      expect(readConfig().claudeConfigDir).toBe('');
    });

    it('returns null and does not write for a non-absolute path', () => {
      const before = readConfig().claudeConfigDir;
      const fields = applySetClaudeConfigDir('relative/path');
      expect(fields).toBeNull();
      expect(readConfig().claudeConfigDir).toBe(before);
    });

    it('returns null and does not write for a non-string payload', () => {
      const before = readConfig().claudeConfigDir;
      const fields = applySetClaudeConfigDir(42);
      expect(fields).toBeNull();
      expect(readConfig().claudeConfigDir).toBe(before);
    });

    it('trims whitespace before persisting', () => {
      const fields = applySetClaudeConfigDir('  /custom/claude  ');
      expect(fields?.claudeConfigDir).toBe('/custom/claude');
    });
  });

  describe('via handleClientMessage', () => {
    let store: AgentStateStore;
    let sent: Array<Record<string, unknown>>;
    let ctx: ClientMessageContext;

    beforeEach(() => {
      store = new AgentStateStore();
      store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      sent = [];
      ctx = { store, cache: null };
    });

    afterEach(() => {
      store.dispose();
    });

    it('sends claudeConfigDirUpdated on a valid save', () => {
      handleClientMessage(
        { type: 'setClaudeConfigDir', claudeConfigDir: '/custom/claude' },
        (msg) => sent.push(msg),
        ctx,
      );
      const reply = sent.find((m) => m.type === 'claudeConfigDirUpdated');
      expect(reply).toBeTruthy();
      expect(reply?.claudeConfigDir).toBe('/custom/claude');
    });

    it('sends nothing on an invalid save', () => {
      handleClientMessage(
        { type: 'setClaudeConfigDir', claudeConfigDir: 'relative/path' },
        (msg) => sent.push(msg),
        ctx,
      );
      expect(sent.find((m) => m.type === 'claudeConfigDirUpdated')).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.test.ts`
Expected: FAIL — `applySetClaudeConfigDir` is not exported / `setClaudeConfigDir` isn't a recognized case, so `handleClientMessage` falls through to the `default:` branch and sends nothing either way (making the "invalid save" test pass by accident, but the "valid save" test fails).

- [ ] **Step 3: Write the implementation**

In `server/src/clientMessageHandler.ts`, add the new import (alongside the existing `providers/index.js` import):

```ts
import {
  buildClaudeConfigDirFields,
  claudeProvider,
  normalizeClaudeConfigDirInput,
} from './providers/index.js';
```

(this replaces the existing `import { claudeProvider } from './providers/index.js';` line)

Add `applySetClaudeConfigDir`, right after the `KEY_SHOW_AREAS` constant and before `handleClientMessage`:

```ts
const KEY_SHOW_AREAS = 'pixel-agents.showAreas';

/**
 * Validate + persist a setClaudeConfigDir payload, returning the five
 * settingsLoaded/claudeConfigDirUpdated fields on success or null on
 * rejection (non-string payload, or a path normalizeClaudeConfigDirInput
 * rejects as non-absolute/not-a-directory). Rejection is silent by design
 * -- no write, no reply -- matching how addExternalAssetDirectory already
 * handles a missing path. Shared between the WebSocket handler below and
 * the VS Code adapter, so the two surfaces can't drift apart the way the
 * settingsLoaded emitters once did.
 */
export function applySetClaudeConfigDir(
  raw: unknown,
): ReturnType<typeof buildClaudeConfigDirFields> | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : undefined;
  if (trimmed === undefined) return null;
  const newDir = normalizeClaudeConfigDirInput(trimmed);
  if (newDir === null) return null;
  const cfg = readConfig();
  cfg.claudeConfigDir = newDir;
  writeConfig(cfg);
  return buildClaudeConfigDirFields(newDir);
}
```

Add the new `case` to the `switch (msg.type)` block in `handleClientMessage`, right after `setShowAreas`:

```ts
    case 'setShowAreas': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_SHOW_AREAS, enabled);
      break;
    }

    case 'setClaudeConfigDir': {
      const fields = applySetClaudeConfigDir(msg.claudeConfigDir);
      if (fields) send({ type: 'claudeConfigDirUpdated', ...fields });
      break;
    }

    default:
```

Update `handleWebviewReady`'s `settingsLoaded` payload to include the five new fields. Replace:

```ts
  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
  const showAreas = adapter?.getSetting(KEY_SHOW_AREAS, false) ?? false;
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    ghostHeadlessAgents: adapter?.getSetting(KEY_GHOST_HEADLESS_AGENTS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
    showAreas,
  });
```

with:

```ts
  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
  const showAreas = adapter?.getSetting(KEY_SHOW_AREAS, false) ?? false;
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    ghostHeadlessAgents: adapter?.getSetting(KEY_GHOST_HEADLESS_AGENTS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
    showAreas,
    ...buildClaudeConfigDirFields(cfg.claudeConfigDir),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/clientMessageHandler.ts server/__tests__/clientMessageHandler.test.ts
git commit -m "feat(claude-config-dir): wire setClaudeConfigDir + settingsLoaded fields into clientMessageHandler

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: `cli.ts` — boot sequence + toggle-path recording

**Files:**
- Modify: `server/src/cli.ts`

No new dedicated test file — `cli.ts`'s `main()` isn't unit-tested today (it's an integration entrypoint exercised by e2e), and the functions it now calls (`prepareClaudeConfigDirForBoot`, `recordClaudeConfigDirHooksInstalled`) already have full unit coverage from Task 12. This task is pure wiring, verified by a manual smoke test in Step 4.

- [ ] **Step 1: Import the boot module**

In `server/src/cli.ts`, add the import alongside the existing `configPersistence.js` import:

```ts
import { readConfig } from './configPersistence.js';
```

becomes:

```ts
import { prepareClaudeConfigDirForBoot, recordClaudeConfigDirHooksInstalled } from './claudeConfigDirBoot.js';
import { readConfig } from './configPersistence.js';
```

- [ ] **Step 2: Call `prepareClaudeConfigDirForBoot('standalone')` at the earliest point in `main()`**

Replace:

```ts
  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
```

with:

```ts
  // Must run before anything that could call claudeProvider.installHooks() --
  // sets the live CLAUDE_CONFIG_DIR override and cleans up any stale hook
  // install from a previous directory, both before hooks get (re)installed
  // below.
  prepareClaudeConfigDirForBoot('standalone');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
```

- [ ] **Step 3: Record after both `installHooks()` call sites**

Replace the toggle-path install branch:

```ts
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Pixel Agents] Hooks installed (user toggle)'
            : '[Pixel Agents] Hooks NOT installed (user toggle), hook script missing',
        );
      } else {
        await claudeProvider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };
```

with:

```ts
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        recordClaudeConfigDirHooksInstalled('standalone');
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Pixel Agents] Hooks installed (user toggle)'
            : '[Pixel Agents] Hooks NOT installed (user toggle), hook script missing',
        );
      } else {
        await claudeProvider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };
```

Replace the boot-time install branch:

```ts
    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Pixel Agents] Hooks installed'
            : '[Pixel Agents] Hooks NOT installed, hook script missing',
        );
      } catch (err) {
        console.error('[Pixel Agents] Failed to install hooks:', err);
      }
    }
```

with:

```ts
    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        recordClaudeConfigDirHooksInstalled('standalone');
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Pixel Agents] Hooks installed'
            : '[Pixel Agents] Hooks NOT installed, hook script missing',
        );
      } catch (err) {
        console.error('[Pixel Agents] Failed to install hooks:', err);
      }
    }
```

- [ ] **Step 4: Type-check and smoke-test**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

Run: `npm run compile` (from repo root) — builds the CLI bundle.
Expected: build succeeds.

Run: `CLAUDE_CONFIG_DIR=/tmp/pxl-smoke-claude node dist/cli.js --port 3199`
Expected: server starts (`Pixel Agents server running at http://127.0.0.1:3199`); check `/tmp/pxl-smoke-claude/settings.json` was created with Pixel Agents hook entries (confirms `installHooks()` targeted the env var directory, not `~/.claude`). Stop with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add server/src/cli.ts
git commit -m "feat(claude-config-dir): wire boot sequence + toggle-path recording into cli.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 16: `PixelAgentsViewProvider.ts` — constructor boot call, toggle-path recording, `settingsLoaded` emitter, `setClaudeConfigDir` case

**Files:**
- Modify: `adapters/vscode/PixelAgentsViewProvider.ts`

No new dedicated unit test — this class isn't unit-tested (depends on `vscode`). Verified by type-checking, the existing VS Code e2e suite (regression), and the manual note in Step 5.

- [ ] **Step 1: Import the boot module and the new provider exports**

Replace the existing import:

```ts
import { claudeProvider, copyHookScript } from '../../server/src/providers/index.js';
```

with (this pulls in everything Steps 2-4 below need, including `buildClaudeConfigDirFields` for the `settingsLoaded` emitter update in Step 4):

```ts
import { prepareClaudeConfigDirForBoot, recordClaudeConfigDirHooksInstalled } from '../../server/src/claudeConfigDirBoot.js';
import { applySetClaudeConfigDir } from '../../server/src/clientMessageHandler.js';
import { buildClaudeConfigDirFields, claudeProvider, copyHookScript } from '../../server/src/providers/index.js';
```

- [ ] **Step 2: Call `prepareClaudeConfigDirForBoot('vscode')` as the first statement of the constructor**

Replace:

```ts
  constructor(
    private readonly context: vscode.ExtensionContext,
    adapter: StateAdapter,
  ) {
    this.adapter = adapter;
    this.store.setAdapter(this.adapter);
```

with:

```ts
  constructor(
    private readonly context: vscode.ExtensionContext,
    adapter: StateAdapter,
  ) {
    // Must run before anything in this constructor (or initServer(), called
    // at the end of it) can reach installHooks() -- sets the live
    // CLAUDE_CONFIG_DIR override and cleans up any stale hook install from a
    // previous directory.
    prepareClaudeConfigDirForBoot('vscode');
    this.adapter = adapter;
    this.store.setAdapter(this.adapter);
```

- [ ] **Step 3: Record after both `installHooks()` call sites**

Replace the boot-time install branch inside `initServer()`:

```ts
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        this.runtime.hooksEnabled.current = hooksEnabled;
        if (hooksEnabled) {
          void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          if (!copyHookScript(this.context.extensionPath)) {
            console.warn('[Pixel Agents] Hook script not copied, hooks may not fire');
          }
        }
```

with:

```ts
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        this.runtime.hooksEnabled.current = hooksEnabled;
        if (hooksEnabled) {
          void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          // installHooks() above is a Promise.resolve() wrapper around a
          // synchronous write (see claude.ts) -- recording immediately after
          // the void call, not chained onto its promise, is correct today
          // and harmless even if that ever changed (worst case: one no-op
          // uninstallHooksAt on a future boot).
          recordClaudeConfigDirHooksInstalled('vscode');
          if (!copyHookScript(this.context.extensionPath)) {
            console.warn('[Pixel Agents] Hook script not copied, hooks may not fire');
          }
        }
```

Replace the toggle-path install branch inside the `webviewView.webview.onDidReceiveMessage` handler:

```ts
      } else if (message.type === 'setHooksEnabled') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_ENABLED, enabled);
        this.runtime.hooksEnabled.current = enabled;
        if (enabled) {
          const serverConfig = this.pixelAgentsServer?.getConfig();
          void claudeProvider.installHooks(
            serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '',
            serverConfig?.token ?? '',
          );
          const copied = copyHookScript(this.context.extensionPath);
          console.log(
            copied
              ? '[Pixel Agents] Hooks enabled by user'
              : '[Pixel Agents] Hooks NOT fully enabled, hook script missing',
          );
        } else {
          void claudeProvider.uninstallHooks();
          console.log('[Pixel Agents] Hooks disabled by user');
        }
```

with:

```ts
      } else if (message.type === 'setHooksEnabled') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_ENABLED, enabled);
        this.runtime.hooksEnabled.current = enabled;
        if (enabled) {
          const serverConfig = this.pixelAgentsServer?.getConfig();
          void claudeProvider.installHooks(
            serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '',
            serverConfig?.token ?? '',
          );
          recordClaudeConfigDirHooksInstalled('vscode');
          const copied = copyHookScript(this.context.extensionPath);
          console.log(
            copied
              ? '[Pixel Agents] Hooks enabled by user'
              : '[Pixel Agents] Hooks NOT fully enabled, hook script missing',
          );
        } else {
          void claudeProvider.uninstallHooks();
          console.log('[Pixel Agents] Hooks disabled by user');
        }
```

- [ ] **Step 4: Add the `setClaudeConfigDir` case, and update the `settingsLoaded` emitter**

Add the new `else if` branch right after the existing `setShowAreas` branch and before `saveAreaMappings` (line 323-326 in the current file):

```ts
      } else if (message.type === 'setShowAreas') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_SHOW_AREAS, enabled);
      } else if (message.type === 'setClaudeConfigDir') {
        const fields = applySetClaudeConfigDir(message.claudeConfigDir);
        if (fields) this.sendOrBuffer({ type: 'claudeConfigDirUpdated', ...fields });
      } else if (message.type === 'saveAreaMappings') {
```

(the last line above is the existing branch that already follows `setShowAreas` — only the `setClaudeConfigDir` branch in between is new; `saveAreaMappings`'s existing body is unchanged)

Update the `settingsLoaded` `postMessage` call. Replace:

```ts
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          ghostHeadlessAgents,
          hooksEnabled,
          hooksInfoShown,
          externalAssetDirectories: config.externalAssetDirectories,
          showAreas,
        });
```

with:

```ts
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          ghostHeadlessAgents,
          hooksEnabled,
          hooksInfoShown,
          externalAssetDirectories: config.externalAssetDirectories,
          showAreas,
          ...buildClaudeConfigDirFields(config.claudeConfigDir),
        });
```

(`buildClaudeConfigDirFields` is already available from the import updated in Step 1.)

- [ ] **Step 5: Type-check and smoke-test**

Run: `npm run check-types` (from repo root)
Expected: no errors.

Run: `npm run compile`
Expected: build succeeds.

Manually launch the Extension Development Host (F5 in VS Code, per this repo's `CLAUDE.md`) with `CLAUDE_CONFIG_DIR` set in the launching shell's environment, open the Pixel Agents panel, open Settings, and confirm the new text field shows the resolved directory matching the env var. This is a manual check — there's no automated e2e coverage for this path (documented gap, see spec).

- [ ] **Step 6: Commit**

```bash
git add adapters/vscode/PixelAgentsViewProvider.ts
git commit -m "feat(claude-config-dir): wire boot sequence, toggle-path recording, and setClaudeConfigDir into VS Code adapter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 17: `useExtensionMessages.ts` — pick up the five new fields

**Files:**
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`

- [ ] **Step 1: Add state**

Add five new `useState` declarations alongside the existing ones (right after `const [showAreas, setShowAreas] = useState(false);`):

```ts
  const [showAreas, setShowAreas] = useState(false);
  const [claudeConfigDir, setClaudeConfigDir] = useState('');
  const [resolvedClaudeConfigDir, setResolvedClaudeConfigDir] = useState('');
  const [resolvedClaudeConfigDirSource, setResolvedClaudeConfigDirSource] = useState('default');
  const [resolvedClaudeConfigDirExists, setResolvedClaudeConfigDirExists] = useState(true);
  const [pendingDirExists, setPendingDirExists] = useState(true);
```

- [ ] **Step 2: Handle `settingsLoaded`'s new fields**

Add to the `settingsLoaded` branch, right after the existing `if (Array.isArray(msg.externalAssetDirectories))` block:

```ts
        if (Array.isArray(msg.externalAssetDirectories)) {
          setExternalAssetDirectories(msg.externalAssetDirectories as string[]);
        }
        if (typeof msg.claudeConfigDir === 'string') {
          setClaudeConfigDir(msg.claudeConfigDir);
        }
        if (typeof msg.resolvedClaudeConfigDir === 'string') {
          setResolvedClaudeConfigDir(msg.resolvedClaudeConfigDir);
        }
        if (typeof msg.resolvedClaudeConfigDirSource === 'string') {
          setResolvedClaudeConfigDirSource(msg.resolvedClaudeConfigDirSource);
        }
        if (typeof msg.resolvedClaudeConfigDirExists === 'boolean') {
          setResolvedClaudeConfigDirExists(msg.resolvedClaudeConfigDirExists);
        }
        if (typeof msg.pendingDirExists === 'boolean') {
          setPendingDirExists(msg.pendingDirExists);
        }
```

- [ ] **Step 3: Handle `claudeConfigDirUpdated`**

Add a new `else if` branch right after the existing `externalAssetDirectoriesUpdated` branch:

```ts
      } else if (msg.type === 'externalAssetDirectoriesUpdated') {
        if (Array.isArray(msg.dirs)) {
          setExternalAssetDirectories(msg.dirs as string[]);
        }
      } else if (msg.type === 'claudeConfigDirUpdated') {
        if (typeof msg.claudeConfigDir === 'string') {
          setClaudeConfigDir(msg.claudeConfigDir);
        }
        if (typeof msg.resolvedClaudeConfigDir === 'string') {
          setResolvedClaudeConfigDir(msg.resolvedClaudeConfigDir);
        }
        if (typeof msg.resolvedClaudeConfigDirSource === 'string') {
          setResolvedClaudeConfigDirSource(msg.resolvedClaudeConfigDirSource);
        }
        if (typeof msg.resolvedClaudeConfigDirExists === 'boolean') {
          setResolvedClaudeConfigDirExists(msg.resolvedClaudeConfigDirExists);
        }
        if (typeof msg.pendingDirExists === 'boolean') {
          setPendingDirExists(msg.pendingDirExists);
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
```

- [ ] **Step 4: Export the five new fields**

No local setter is needed for sending — `SettingsModal` (Task 19) calls `transport.send({ type: 'setClaudeConfigDir', ... })` directly and relies on the `claudeConfigDirUpdated` reply handled in Step 3 above to update state, the same pattern `externalAssetDirectories`/`addExternalAssetDirectory` already uses. `claudeConfigDir` only ever changes via the `settingsLoaded`/`claudeConfigDirUpdated` messages.

Add the five new fields to the `ExtensionMessageState` interface, right after `externalAssetDirectories: string[];`:

```ts
  externalAssetDirectories: string[];
  claudeConfigDir: string;
  resolvedClaudeConfigDir: string;
  resolvedClaudeConfigDirSource: string;
  resolvedClaudeConfigDirExists: boolean;
  pendingDirExists: boolean;
```

Add them to the final `return` object, right after `externalAssetDirectories,`:

```ts
    externalAssetDirectories,
    claudeConfigDir,
    resolvedClaudeConfigDir,
    resolvedClaudeConfigDirSource,
    resolvedClaudeConfigDirExists,
    pendingDirExists,
```

- [ ] **Step 5: Type-check**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run webview tests**

Run: `npm run test:webview` (from repo root)
Expected: PASS (this file has no dedicated unit tests today, per this repo's "E2E over webview unit tests" policy — this step confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/hooks/useExtensionMessages.ts
git commit -m "feat(claude-config-dir): pick up claudeConfigDir fields in useExtensionMessages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 18: `App.tsx` — thread state to `SettingsModal`

**Files:**
- Modify: `webview-ui/src/App.tsx`

- [ ] **Step 1: Destructure the new fields from `useExtensionMessages`**

Add the five new fields to the destructuring assignment, right after `externalAssetDirectories,`:

```ts
  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    claudeConfigDir,
    resolvedClaudeConfigDir,
    resolvedClaudeConfigDirSource,
    resolvedClaudeConfigDirExists,
    pendingDirExists,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    setHooksEnabled,
    hooksInfoShown,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);
```

- [ ] **Step 2: Pass them into `<SettingsModal>`**

Add the five new props to the `<SettingsModal>` element, right after `externalAssetDirectories={externalAssetDirectories}`:

```ts
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        externalAssetDirectories={externalAssetDirectories}
        claudeConfigDir={claudeConfigDir}
        resolvedClaudeConfigDir={resolvedClaudeConfigDir}
        resolvedClaudeConfigDirSource={resolvedClaudeConfigDirSource}
        resolvedClaudeConfigDirExists={resolvedClaudeConfigDirExists}
        pendingDirExists={pendingDirExists}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksEnabled={hooksEnabled}
        onToggleHooksEnabled={() => {
          const newVal = !hooksEnabled;
          setHooksEnabled(newVal);
          transport.send({ type: 'setHooksEnabled', enabled: newVal });
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
      />
```

- [ ] **Step 2: Type-check**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: FAIL at this point — `SettingsModalProps` doesn't have these fields yet (fixed in Task 19). This is expected; proceed to Task 19 before verifying green.

- [ ] **Step 3: Commit** (after Task 19 makes this compile — see that task's Step 4 for the actual verification+commit point)

This task's changes are committed together with Task 19's, since `App.tsx` alone doesn't type-check without `SettingsModal.tsx`'s prop additions. Skip committing here; proceed directly to Task 19.

---

### Task 19: `SettingsModal.tsx` — the new text input

**Files:**
- Modify: `webview-ui/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add the new props to `SettingsModalProps` and the destructured parameter list**

Replace the interface:

```ts
interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  hooksEnabled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}
```

with:

```ts
interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  /** Raw persisted CLAUDE_CONFIG_DIR override; '' means unset. */
  claudeConfigDir: string;
  /** What the server actually resolves to right now (setting, env var, or default). */
  resolvedClaudeConfigDir: string;
  /** Which source produced resolvedClaudeConfigDir: 'setting' | 'env' | 'default'. */
  resolvedClaudeConfigDirSource: string;
  /** Whether resolvedClaudeConfigDir exists on disk right now. */
  resolvedClaudeConfigDirExists: boolean;
  /** Whether claudeConfigDir would resolve to an existing directory after a restart. */
  pendingDirExists: boolean;
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  hooksEnabled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}
```

Replace the destructured parameter list:

```ts
export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksEnabled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
```

with:

```ts
export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  claudeConfigDir,
  resolvedClaudeConfigDir,
  resolvedClaudeConfigDirSource,
  resolvedClaudeConfigDirExists,
  pendingDirExists,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksEnabled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  const [claudeConfigDirDraft, setClaudeConfigDirDraft] = useState(claudeConfigDir);
```

- [ ] **Step 2: Render the new field**

Add the new field's JSX right after the closing `))}` of the `externalAssetDirectories.map(...)` block and before the `Sound Notifications` checkbox — i.e. right after:

```ts
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
```

insert:

```ts
      <div className="flex flex-col gap-4 py-4 px-10">
        <div className="flex items-center gap-4">
          <input
            type="text"
            value={claudeConfigDirDraft}
            placeholder="Claude config directory (blank = default)"
            onChange={(e) => setClaudeConfigDirDraft(e.target.value)}
            onBlur={() => {
              const trimmed = claudeConfigDirDraft.trim();
              // Light pre-check only -- authoritative validation is server-side
              // (see clientMessageHandler.ts's applySetClaudeConfigDir), since
              // expanding a leading ~ requires knowing the SERVER's home
              // directory, which the browser tab this modal renders in
              // doesn't have access to.
              if (trimmed !== '' && !trimmed.startsWith('/') && !trimmed.startsWith('~')) {
                return;
              }
              transport.send({ type: 'setClaudeConfigDir', claudeConfigDir: trimmed });
            }}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </div>
        <span className="text-xs text-text-muted">
          {resolvedClaudeConfigDirSource === 'setting' && `Using configured path: ${resolvedClaudeConfigDir}`}
          {resolvedClaudeConfigDirSource === 'env' && `Using $CLAUDE_CONFIG_DIR: ${resolvedClaudeConfigDir}`}
          {resolvedClaudeConfigDirSource === 'default' && `Using ${resolvedClaudeConfigDir} (default)`}
          {!resolvedClaudeConfigDirExists && ' — does not exist on disk'}
        </span>
        {claudeConfigDirDraft.trim() !== resolvedClaudeConfigDir && (
          <span className="text-xs text-text-muted">
            Restart Pixel Agents to apply
            {!pendingDirExists && ' — this directory does not exist yet'}
          </span>
        )}
      </div>
```

- [ ] **Step 3: Keep the local draft in sync when the server confirms a change**

Add a `useEffect` right after the existing hooks (`useState` declarations), so a `claudeConfigDirUpdated`/`settingsLoaded` reply (which updates the `claudeConfigDir` prop) refreshes the draft too:

```ts
import { useEffect, useRef, useState } from 'react';
```

(replaces the existing `import { useRef, useState } from 'react';` line)

Add, right after the `const [claudeConfigDirDraft, setClaudeConfigDirDraft] = useState(claudeConfigDir);` line:

```ts
  useEffect(() => {
    setClaudeConfigDirDraft(claudeConfigDir);
  }, [claudeConfigDir]);
```

- [ ] **Step 4: Type-check (both this file and `App.tsx` from Task 18)**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run webview tests**

Run: `npm run test:webview` (from repo root)
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `cd webview-ui && npx eslint src/components/SettingsModal.tsx src/App.tsx`
Expected: no errors — in particular, no `no-inline-colors` violations (this project's custom ESLint rule) since the new JSX only uses existing Tailwind utility classes already used elsewhere in this file, and no `pixel-font`/`pixel-shadow` violations since no new fonts or shadows were introduced.

- [ ] **Step 7: Commit both `App.tsx` and `SettingsModal.tsx` together**

```bash
git add webview-ui/src/App.tsx webview-ui/src/components/SettingsModal.tsx
git commit -m "feat(claude-config-dir): add Claude config directory field to Settings modal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 20: E2E protective fix — `mock-claude.ts` strips `CLAUDE_CONFIG_DIR`

**Files:**
- Modify: `e2e/helpers/mock-claude.ts`

- [ ] **Step 1: Update `applyMockHomeEnv`**

Replace:

```ts
export function applyMockHomeEnv(base: NodeJS.ProcessEnv, tmpHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: tmpHome };
  if (process.platform === 'win32') {
    env.USERPROFILE = tmpHome;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
  }
  return env;
}
```

with:

```ts
export function applyMockHomeEnv(base: NodeJS.ProcessEnv, tmpHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: tmpHome };
  if (process.platform === 'win32') {
    env.USERPROFILE = tmpHome;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
  }
  // An inherited CLAUDE_CONFIG_DIR would redirect Pixel Agents' own hook
  // install / session scanning away from tmpHome, the isolation this
  // function exists to establish -- same category of problem HOMEDRIVE/
  // HOMEPATH solve above for Windows.
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}
```

- [ ] **Step 2: Type-check**

Run: `cd e2e && npx tsc --noEmit` (check `e2e/`'s own `tsconfig.json` first if this command errors on config resolution — this repo's e2e suite is its own workspace-adjacent TS project)
Expected: no errors.

- [ ] **Step 3: Run a quick e2e smoke check**

Run: `CLAUDE_CONFIG_DIR=/tmp/should-be-ignored npm run e2e -- --grep "lifecycle" --workers=1` (pick any fast-running existing spec by name from `e2e/README.md`'s inventory if "lifecycle" doesn't match)
Expected: PASS — confirms the suite behaves identically whether or not the running shell has `CLAUDE_CONFIG_DIR` set.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers/mock-claude.ts
git commit -m "fix(e2e): strip CLAUDE_CONFIG_DIR from mock-claude launch env

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 21: E2E protective fix — `standalone.ts` routes through `applyMockHomeEnv`

**Files:**
- Modify: `e2e/helpers/standalone.ts`

- [ ] **Step 1: Import `applyMockHomeEnv` and use it**

Add the import:

```ts
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { applyMockHomeEnv } from './mock-claude';
import { type HookServerConfig, waitForHookServer } from './hooks';
```

Replace `spawnStandaloneHost`'s inline env object:

```ts
function spawnStandaloneHost(args: {
  homeDir: string;
  hostPort: number;
  workspaceDir: string;
}): ChildProcessWithoutNullStreams {
  if (!fs.existsSync(STANDALONE_CLI)) {
    throw new Error(
      `Standalone CLI not built at ${STANDALONE_CLI}. Run 'npm run compile' before standalone e2e tests.`,
    );
  }
  return spawn(
    process.execPath,
    [STANDALONE_CLI, '--port', args.hostPort.toString(), '--host', '127.0.0.1'],
    {
      cwd: args.workspaceDir,
      env: {
        ...process.env,
        HOME: args.homeDir,
        USERPROFILE: args.homeDir,
      },
      stdio: 'pipe',
    },
  );
}
```

with:

```ts
function spawnStandaloneHost(args: {
  homeDir: string;
  hostPort: number;
  workspaceDir: string;
}): ChildProcessWithoutNullStreams {
  if (!fs.existsSync(STANDALONE_CLI)) {
    throw new Error(
      `Standalone CLI not built at ${STANDALONE_CLI}. Run 'npm run compile' before standalone e2e tests.`,
    );
  }
  return spawn(
    process.execPath,
    [STANDALONE_CLI, '--port', args.hostPort.toString(), '--host', '127.0.0.1'],
    {
      cwd: args.workspaceDir,
      // Routed through the shared helper (rather than duplicating the env
      // object inline) so this entrypoint gets the same CLAUDE_CONFIG_DIR
      // stripping the VS Code launch path already gets -- this file used to
      // build its own env inline and bypass that protection entirely.
      env: applyMockHomeEnv(process.env, args.homeDir),
      stdio: 'pipe',
    },
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd e2e && npx tsc --noEmit` (same caveat as Task 20 Step 2)
Expected: no errors.

- [ ] **Step 3: Run the standalone e2e suite**

Run: `CLAUDE_CONFIG_DIR=/tmp/should-be-ignored npm run e2e -- --grep "standalone" --workers=1`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers/standalone.ts
git commit -m "fix(e2e): route standalone spawn env through applyMockHomeEnv

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the complete test suite**

```bash
cd /Users/sergicastro/workspace/pixel-agents
npm run compile
npm test
```

Expected: `compile` succeeds (asyncapi generate/validate, type-check, lint, esbuild, vite build all green); `test` (webview + server + package-contract) all pass.

- [ ] **Run the full e2e suite**

```bash
npm run e2e -- --workers=1
```

Expected: all specs pass, including with `CLAUDE_CONFIG_DIR` unset in the environment (the normal case) and, per Task 20/21's smoke checks, with it set to a bogus path (proving the isolation fix works).

- [ ] **Manual end-to-end check** (no automated coverage exists for this path — see Task 16, Step 5, and the spec's Testing section)

1. Set `CLAUDE_CONFIG_DIR=/tmp/pxl-manual-check/.claude` in a terminal, `mkdir -p` that path.
2. Launch the VS Code Extension Development Host from that terminal (F5).
3. Open the Pixel Agents panel, launch a new agent via the panel button.
4. Confirm: the agent's character appears in the office (proves `getSessionDirs`/hook detection targeted the right directory), and `/tmp/pxl-manual-check/.claude/settings.json` has Pixel Agents hook entries (proves `installHooks()` did too).
5. Open Settings, confirm the Claude config directory field shows the resolved env var path with "Using $CLAUDE_CONFIG_DIR: ..." helper text.
6. Type an explicit override path into the field, blur it, confirm a "Restart Pixel Agents to apply" notice appears and the raw field value persists across closing/reopening the Settings modal.

If all six steps pass, this feature is complete.
