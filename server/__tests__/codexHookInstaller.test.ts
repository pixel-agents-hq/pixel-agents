import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  areHooksInstalled,
  getCodexHooksPath,
  installHooks,
  isOurHookCommand,
  uninstallHooks,
} from '../src/providers/hook/codex/codexHookInstaller.js';
import { CODEX_HOOK_EVENTS } from '../src/providers/hook/codex/constants.js';

// Every test runs against a throwaway HOME so a failing test can never touch
// the developer's real ~/.codex/hooks.json. `vi.spyOn` cannot redefine an ESM
// namespace export, so the redirection goes through a module mock — the same
// seam claudeHookInstaller.test.ts uses.
let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: actual, homedir: () => tmpHome };
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-codex-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getCodexHooksPath(), 'utf-8')) as Record<string, unknown>;
}

function writeFile(content: unknown): void {
  const p = getCodexHooksPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
}

/** A hook entry that is not ours, used to prove we never delete a stranger's. */
const FOREIGN = {
  hooks: [{ type: 'command', command: 'python3 /opt/someone-else/audit.py' }],
};

describe('codexHookInstaller', () => {
  describe('install', () => {
    it('creates hooks.json with an entry for every declared event', async () => {
      await installHooks('http://127.0.0.1:1', 'tok');
      const file = readFile();
      const hooks = file['hooks'] as Record<string, unknown[]>;
      for (const event of CODEX_HOOK_EVENTS) {
        expect(hooks[event]).toHaveLength(1);
      }
      expect(Object.keys(hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    });

    it('installs handlers as async so the agent loop never waits on us', async () => {
      await installHooks('u', 't');
      const hooks = readFile()['hooks'] as Record<
        string,
        Array<{ hooks: Array<Record<string, unknown>> }>
      >;
      const handler = hooks['PreToolUse'][0].hooks[0];
      expect(handler['async']).toBe(true);
      expect(handler['type']).toBe('command');
      expect(handler['timeout']).toBe(5);
      expect(String(handler['command'])).toContain('codex-hook.js');
    });

    it('omits matcher so every tool is observed', async () => {
      await installHooks('u', 't');
      const hooks = readFile()['hooks'] as Record<string, Array<Record<string, unknown>>>;
      expect(hooks['PreToolUse'][0]['matcher']).toBeUndefined();
    });

    it('is idempotent — installing twice leaves one entry per event', async () => {
      await installHooks('u', 't');
      await installHooks('u', 't');
      const hooks = readFile()['hooks'] as Record<string, unknown[]>;
      for (const event of CODEX_HOOK_EVENTS) {
        expect(hooks[event]).toHaveLength(1);
      }
    });

    it('preserves a foreign hook in an event we also install', async () => {
      writeFile({ hooks: { PreToolUse: [FOREIGN] } });
      await installHooks('u', 't');
      const hooks = readFile()['hooks'] as Record<string, unknown[]>;
      expect(hooks['PreToolUse']).toHaveLength(2);
      expect(JSON.stringify(hooks['PreToolUse'][0])).toContain('audit.py');
    });

    it('preserves a foreign hook on an event we never install', async () => {
      writeFile({ hooks: { UserPromptSubmit: [FOREIGN] } });
      await installHooks('u', 't');
      const hooks = readFile()['hooks'] as Record<string, unknown[]>;
      expect(hooks['UserPromptSubmit']).toHaveLength(1);
      expect(JSON.stringify(hooks['UserPromptSubmit'])).toContain('audit.py');
    });

    it('preserves unrelated top-level keys', async () => {
      writeFile({ description: 'my workspace hooks', hooks: {} });
      await installHooks('u', 't');
      expect(readFile()['description']).toBe('my workspace hooks');
    });

    it('backs up a pre-existing file exactly once', async () => {
      writeFile({ hooks: { PreToolUse: [FOREIGN] } });
      const backup = getCodexHooksPath() + '.pixel-agents.backup';

      await installHooks('u', 't');
      expect(fs.existsSync(backup)).toBe(true);
      const first = fs.readFileSync(backup, 'utf-8');
      expect(first).toContain('audit.py');

      // A second install must not overwrite the ORIGINAL backup with our own
      // already-modified content, or the user loses their pristine copy.
      await installHooks('u', 't');
      expect(fs.readFileSync(backup, 'utf-8')).toBe(first);
    });

    it('writes no backup when there was no file to back up', async () => {
      await installHooks('u', 't');
      expect(fs.existsSync(getCodexHooksPath() + '.pixel-agents.backup')).toBe(false);
    });

    it('sweeps our entry off an event that is no longer in the install list', async () => {
      // Simulate a legacy install that hooked an event we since dropped.
      await installHooks('u', 't');
      const file = readFile();
      const hooks = file['hooks'] as Record<string, unknown[]>;
      hooks['Interrupt'] = [...(hooks['PreToolUse'] as unknown[])];
      writeFile(file);

      await installHooks('u', 't');
      expect((readFile()['hooks'] as Record<string, unknown>)['Interrupt']).toBeUndefined();
    });

    it('leaves no temp file behind', async () => {
      await installHooks('u', 't');
      const dir = path.dirname(getCodexHooksPath());
      expect(fs.readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([]);
    });

    it('throws a clear message on malformed JSON rather than overwriting it', async () => {
      const p = getCodexHooksPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{ this is not json');
      await expect(installHooks('u', 't')).rejects.toThrow(/parse/i);
      // The user's file must survive the refusal.
      expect(fs.readFileSync(p, 'utf-8')).toBe('{ this is not json');
    });

    it('throws when hooks is not an object', async () => {
      writeFile({ hooks: ['nope'] });
      await expect(installHooks('u', 't')).rejects.toThrow(/not an object/);
    });

    it('throws when a single event is not an array', async () => {
      writeFile({ hooks: { PreToolUse: { bad: true } } });
      await expect(installHooks('u', 't')).rejects.toThrow(/not an array/);
    });

    it('treats an empty file as absent', async () => {
      const p = getCodexHooksPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '   \n');
      await expect(installHooks('u', 't')).resolves.toBeUndefined();
      expect(Object.keys(readFile()['hooks'] as object)).toHaveLength(CODEX_HOOK_EVENTS.length);
    });
  });

  describe('areHooksInstalled', () => {
    it('is false before install', async () => {
      expect(await areHooksInstalled()).toBe(false);
    });
    it('is true after install', async () => {
      await installHooks('u', 't');
      expect(await areHooksInstalled()).toBe(true);
    });
    it('is false when only SOME events carry our hook', async () => {
      await installHooks('u', 't');
      const file = readFile();
      delete (file['hooks'] as Record<string, unknown>)['Stop'];
      writeFile(file);
      expect(await areHooksInstalled()).toBe(false);
    });
    it('is false when the file is malformed', async () => {
      const p = getCodexHooksPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'not json');
      expect(await areHooksInstalled()).toBe(false);
    });
    it('is false when only foreign hooks are present', async () => {
      writeFile({ hooks: Object.fromEntries(CODEX_HOOK_EVENTS.map((e) => [e, [FOREIGN]])) });
      expect(await areHooksInstalled()).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('removes the file when it held only our hooks', async () => {
      await installHooks('u', 't');
      await uninstallHooks();
      expect(fs.existsSync(getCodexHooksPath())).toBe(false);
    });

    it('keeps foreign hooks and drops only ours', async () => {
      writeFile({ hooks: { PreToolUse: [FOREIGN] } });
      await installHooks('u', 't');
      await uninstallHooks();

      const hooks = readFile()['hooks'] as Record<string, unknown[]>;
      expect(hooks['PreToolUse']).toHaveLength(1);
      expect(JSON.stringify(hooks['PreToolUse'])).toContain('audit.py');
      expect(JSON.stringify(hooks)).not.toContain('codex-hook.js');
    });

    it('keeps the file when other top-level keys remain', async () => {
      writeFile({ description: 'keep me' });
      await installHooks('u', 't');
      await uninstallHooks();
      expect(fs.existsSync(getCodexHooksPath())).toBe(true);
      expect(readFile()['description']).toBe('keep me');
      expect(readFile()['hooks']).toBeUndefined();
    });

    it('strips our handler from a group we share with a stranger', async () => {
      // A hand-merged group holding both commands: ours must go, theirs stay.
      await installHooks('u', 't');
      const file = readFile();
      const hooks = file['hooks'] as Record<string, Array<{ hooks: unknown[] }>>;
      hooks['PreToolUse'][0].hooks.push({
        type: 'command',
        command: 'python3 /opt/theirs.py',
      });
      writeFile(file);

      await uninstallHooks();
      const after = readFile()['hooks'] as Record<string, unknown[]>;
      expect(JSON.stringify(after)).toContain('theirs.py');
      expect(JSON.stringify(after)).not.toContain('codex-hook.js');
    });

    it('is a no-op when there is no file', async () => {
      await expect(uninstallHooks()).resolves.toBeUndefined();
    });

    it('is idempotent', async () => {
      await installHooks('u', 't');
      await uninstallHooks();
      await expect(uninstallHooks()).resolves.toBeUndefined();
    });

    it('leaves a malformed file alone rather than guessing', async () => {
      const p = getCodexHooksPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'not json');
      await expect(uninstallHooks()).rejects.toThrow(/parse/i);
      expect(fs.readFileSync(p, 'utf-8')).toBe('not json');
    });
  });

  describe('isOurHookCommand', () => {
    it('recognizes the shapes we write', () => {
      expect(isOurHookCommand('node "/Users/x/.pixel-agents/hooks/codex-hook.js"')).toBe(true);
      expect(isOurHookCommand('/Users/x/.pixel-agents/hooks/codex-hook.js')).toBe(true);
      expect(isOurHookCommand('node /Users/x/.pixel-agents/hooks/codex-hook.js')).toBe(true);
    });
    it('recognizes a Windows path', () => {
      expect(isOurHookCommand('node "C:/Users/x/.pixel-agents/hooks/codex-hook.js"')).toBe(true);
    });
    it('does not claim a stranger', () => {
      expect(isOurHookCommand('python3 /opt/audit.py')).toBe(false);
      expect(isOurHookCommand('node /opt/other/hook.js')).toBe(false);
      expect(isOurHookCommand('')).toBe(false);
    });
    it('does not claim the Claude hook — the two must be independent', () => {
      expect(isOurHookCommand('node "/Users/x/.pixel-agents/hooks/claude-hook.js"')).toBe(false);
    });
    it('ignores a relative path (cannot be verified as ours)', () => {
      expect(isOurHookCommand('node ./codex-hook.js')).toBe(false);
    });
  });
});
