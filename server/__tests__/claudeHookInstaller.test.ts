import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

/** Injected filesystem failures for the write-path tests. `vi.spyOn` cannot
 *  redefine an ESM namespace export, so failures are switched through the same
 *  module-mock seam the homedir redirection above uses. */
const fsFailures: { rename: boolean; copyFile: boolean } = { rename: false, copyFile: false };

/** Side effects injected at a precise point in the write sequence, so a
 *  concurrent writer can be simulated INSIDE writeClaudeSettings rather than
 *  merely before it. */
const fsHooks: { afterChmod: (() => void) | null } = { afterChmod: null };

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const failWith = (code: string, message: string): never => {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) =>
      fsFailures.rename
        ? failWith('EIO', 'EIO: simulated rename failure')
        : actual.renameSync(...args),
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) =>
      fsFailures.copyFile
        ? failWith('EACCES', 'EACCES: simulated backup failure')
        : actual.copyFileSync(...args),
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      const result = actual.chmodSync(...args);
      fsHooks.afterChmod?.();
      return result;
    },
  };
});

const { areHooksInstalled, installHooks, uninstallHooks, copyHookScript } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX, SETTINGS_TMP_SUFFIX } =
  await import('../src/providers/hook/claude/constants.js');

function settingsPathFor(): string {
  return path.join(tmpBase, '.claude', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPathFor(), 'utf-8'));
}

/** The command string our installer writes, for the current fake homedir. */
function ourCommand(): string {
  return `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
}

/** Every command string across every event, flattened. */
function allCommands(): string[] {
  const hooks = (readSettings().hooks ?? {}) as Record<
    string,
    Array<{ hooks?: Array<{ command?: string }> }>
  >;
  return Object.values(hooks).flatMap((entries) =>
    entries.flatMap((entry) => (entry.hooks ?? []).map((h) => h.command ?? '')),
  );
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

  // 4a. A PARTIAL install still fires. Both consent surfaces branch on this
  //     answer, and an all-12-or-nothing reading presented live hooks as
  //     "nothing installed": the checkbox read off while hooks fired, "Not
  //     Now" left them firing without saying so, and "Don't Ask Again"
  //     persisted hooks-off without removing them.
  it.each([
    ['one event', 1],
    ['all but one event', CLAUDE_HOOK_EVENTS.length - 1],
  ])('areHooksInstalled is true for a partial install (%s)', (_label, count) => {
    const entry = { matcher: '', hooks: [{ type: 'command', command: ourCommand(), timeout: 5 }] };
    fs.writeFileSync(
      settingsPathFor(),
      JSON.stringify({
        hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.slice(0, count).map((e) => [e, [entry]])),
      }),
    );

    expect(areHooksInstalled()).toBe(true);
  });

  // 4b. Leftovers under an event we no longer install fire too. uninstallHooks
  //     already walks every key, so this must agree with it — otherwise
  //     "remove" leaves behind something this reports as absent.
  it('areHooksInstalled is true for leftovers under an unlisted event', () => {
    const entry = { matcher: '', hooks: [{ type: 'command', command: ourCommand(), timeout: 5 }] };
    fs.writeFileSync(settingsPathFor(), JSON.stringify({ hooks: { UserPromptSubmit: [entry] } }));

    expect(areHooksInstalled()).toBe(true);
  });

  // 4c. ...and a partial install is repaired by the next consented install,
  //     so reporting it honestly costs nothing.
  it('a partial install is completed by the next install', async () => {
    const entry = { matcher: '', hooks: [{ type: 'command', command: ourCommand(), timeout: 5 }] };
    fs.writeFileSync(settingsPathFor(), JSON.stringify({ hooks: { Stop: [entry] } }));

    await installHooks();

    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(allCommands().filter((c) => c === ourCommand())).toHaveLength(CLAUDE_HOOK_EVENTS.length);
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

  // 6a. ...but only what OUR removal emptied. An event the user left empty
  //     themselves is theirs to keep — uninstall preserves what isn't ours,
  //     empty arrays included.
  it('uninstallHooks keeps a user-authored empty event array', async () => {
    const settingsPath = settingsPathFor();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          MyOwnEvent: [],
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: ourCommand() }] }],
        },
      }),
    );

    await uninstallHooks();

    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['MyOwnEvent']).toEqual([]);
    expect(hooks['Stop']).toBeUndefined();
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
    expect(fs.existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
    expect(fs.existsSync(settingsPath + SETTINGS_TMP_SUFFIX)).toBe(false);
  });

  // 8a'. Same for a BOM'd file: JSON.parse rejects a UTF-8 BOM, and an
  //      editor-saved settings.json is exactly the kind of file that has one.
  it('leaves a BOM-prefixed settings.json unchanged on install', async () => {
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const bommed = '﻿' + JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, bommed);

    await expect(installHooks()).rejects.toThrow(/Couldn't parse/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(bommed);
    expect(fs.existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
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
    const settingsPath = settingsPathFor();
    const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, original);

    await installHooks();
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);

    // A later modification must NOT refresh the backup: it preserves the
    // pre-Pixel-Agents state, not the previous write.
    await uninstallHooks();
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
  });

  // 8b-2. The backup is a file WE create holding the user's permission rules,
  //       so it inherits the source mode. Otherwise F11's fix is just relocated:
  //       a 0600 settings.json copied to a 0644 backup is the same exposure.
  it.skipIf(process.platform === 'win32')('gives the backup the source file mode', async () => {
    const settingsPath = settingsPathFor();
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    fs.chmodSync(settingsPath, 0o600);

    await installHooks();

    expect(fs.statSync(settingsPath + SETTINGS_BACKUP_SUFFIX).mode & 0o777).toBe(0o600);
  });

  // 8c. No backup when there was nothing to back up
  it('creates no backup when settings.json did not exist', async () => {
    await installHooks();
    const backupPath = settingsPathFor() + SETTINGS_BACKUP_SUFFIX;
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  // ── W1: the write path throws instead of logging ──────────────
  //
  // A swallowed write error used to leave callers logging "Hooks installed"
  // over a file that was never written, with a stray tmp file next to it.

  // 8d. A failing rename surfaces AND leaves nothing behind
  it('rejects when the settings write fails, leaving the file and no tmp behind', async () => {
    const settingsPath = settingsPathFor();
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, original);

    fsFailures.rename = true;
    try {
      await expect(installHooks()).rejects.toThrow(/hooks not installed/);
    } finally {
      fsFailures.rename = false;
    }

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
    expect(fs.existsSync(settingsPath + SETTINGS_TMP_SUFFIX)).toBe(false);
  });

  // 8e. An unwritable .claude directory is a hard failure, not a silent no-op
  it.skipIf(process.platform === 'win32')(
    'rejects when the .claude directory is not writable',
    async () => {
      const claudeDir = path.join(tmpBase, '.claude');
      const settingsPath = settingsPathFor();
      const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
      fs.writeFileSync(settingsPath, original);
      fs.chmodSync(claudeDir, 0o500);

      try {
        await expect(installHooks()).rejects.toThrow(/hooks not installed/);
        expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
      } finally {
        fs.chmodSync(claudeDir, 0o700);
      }
    },
  );

  // 8f. Mode preservation: a deliberate chmod 600 must survive our write.
  //     settings.json holds the user's permission rules; relaxing it to the
  //     umask default (0644) is a silent privacy downgrade.
  it.skipIf(process.platform === 'win32')(
    'preserves the existing settings.json file mode',
    async () => {
      const settingsPath = settingsPathFor();
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
      fs.chmodSync(settingsPath, 0o600);

      await installHooks();

      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    },
  );

  // 8g. A settings.json we create ourselves starts restrictive, not umask-wide
  it.skipIf(process.platform === 'win32')(
    'creates a fresh settings.json with mode 0600',
    async () => {
      await installHooks();
      expect(fs.statSync(settingsPathFor()).mode & 0o777).toBe(0o600);
    },
  );

  // 8h. A backup failure blocks the write: no backup means no modification.
  it('rejects and writes nothing when the backup cannot be made', async () => {
    const settingsPath = settingsPathFor();
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    fs.writeFileSync(settingsPath, original);

    fsFailures.copyFile = true;
    try {
      await expect(installHooks()).rejects.toThrow(/hooks not installed/);
    } finally {
      fsFailures.copyFile = false;
    }

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  // 8i. A pre-existing backup is the normal "already backed up" path (EEXIST
  //     from COPYFILE_EXCL), not an error — and it is never overwritten.
  it('tolerates a pre-existing backup without overwriting it', async () => {
    const settingsPath = settingsPathFor();
    const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
    fs.writeFileSync(backupPath, 'older backup contents');

    await installHooks();

    expect(fs.readFileSync(backupPath, 'utf-8')).toBe('older backup contents');
    expect(areHooksInstalled()).toBe(true);
  });

  // 8i-2. ...but "the name is taken" is not the same as "a backup exists".
  //       COPYFILE_EXCL reports EEXIST for a DIRECTORY at that path too, and
  //       treating that as already-backed-up modified settings.json with
  //       nothing to restore from — the exact safety net the 1-star review
  //       found missing, failing silently in a new way.
  it.skipIf(process.platform === 'win32')(
    'refuses to write when the backup path is a directory',
    async () => {
      const settingsPath = settingsPathFor();
      const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
      fs.writeFileSync(settingsPath, original);
      fs.mkdirSync(settingsPath + SETTINGS_BACKUP_SUFFIX, { recursive: true });

      await expect(installHooks()).rejects.toThrow(/not a regular file/);
      await expect(installHooks()).rejects.toThrow(/hooks not installed/);

      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
      expect(fs.existsSync(settingsPath + SETTINGS_TMP_SUFFIX)).toBe(false);
    },
  );

  // 8i-3. Same rule for a dangling symlink: the name exists (EEXIST) but
  //       resolves to nothing, so there is no recoverable copy.
  it.skipIf(process.platform === 'win32')(
    'refuses to write when the backup path is a dangling symlink',
    async () => {
      const settingsPath = settingsPathFor();
      const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
      fs.writeFileSync(settingsPath, original);
      fs.symlinkSync(path.join(tmpBase, 'nowhere'), settingsPath + SETTINGS_BACKUP_SUFFIX);

      await expect(installHooks()).rejects.toThrow(/not a regular file/);

      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
    },
  );

  // 8i-4. A symlink that DOES resolve to a real file is a recoverable copy —
  //       the check follows symlinks rather than banning them.
  it.skipIf(process.platform === 'win32')(
    'accepts a backup symlink that resolves to a real file',
    async () => {
      const settingsPath = settingsPathFor();
      const realBackup = path.join(tmpBase, 'kept-elsewhere.json');
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
      fs.writeFileSync(realBackup, 'older backup contents');
      fs.symlinkSync(realBackup, settingsPath + SETTINGS_BACKUP_SUFFIX);

      await installHooks();

      expect(areHooksInstalled()).toBe(true);
      expect(fs.readFileSync(realBackup, 'utf-8')).toBe('older backup contents');
    },
  );

  // 8j. A stale tmp file from a crashed run is cleaned up, not renamed over
  it('removes a stale tmp file left by a previous crash', async () => {
    const tmpPath = settingsPathFor() + SETTINGS_TMP_SUFFIX;
    fs.writeFileSync(tmpPath, '{"stale":true}');

    await installHooks();

    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(areHooksInstalled()).toBe(true);
  });

  // 8j-2. F12: the concurrent-write check sits immediately before the rename,
  //       AFTER mkdir/backup/tmp-write, so the lost-update window is one read
  //       plus one rename. Simulate the other writer landing inside the write
  //       itself: a chmod-time hook rewrites settings.json, so the verify that
  //       follows must catch it, abandon the tmp, and retry on fresh content —
  //       and the other writer's change must survive in the final file.
  it('detects a write that lands mid-write and redoes the mutation on fresh content', async () => {
    const settingsPath = settingsPathFor();
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));

    let fired = false;
    fsHooks.afterChmod = () => {
      if (fired) return;
      fired = true;
      // Another process writes between our tmp write and our rename.
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }),
      );
    };
    try {
      await installHooks();
    } finally {
      fsHooks.afterChmod = null;
    }

    expect(fired).toBe(true);
    const settings = readSettings();
    // The concurrent writer's change was NOT lost...
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    // ...and our install still landed, on top of the fresh content.
    expect(areHooksInstalled()).toBe(true);
    expect(fs.existsSync(settingsPath + SETTINGS_TMP_SUFFIX)).toBe(false);
  });

  // 8k. A malformed-but-user-authored hooks.<Event> value is refused, never
  //     replaced with []. Same philosophy as the unparseable-file abort.
  it('refuses to install when a hooks.<Event> value is not an array', async () => {
    const settingsPath = settingsPathFor();
    const original = JSON.stringify({ hooks: { Stop: { matcher: '' } } });
    fs.writeFileSync(settingsPath, original);

    await expect(installHooks()).rejects.toThrow(/hooks\.Stop/);
    await expect(installHooks()).rejects.toThrow(/hooks not installed/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  // 8k-2. Same rule one level up. An ARRAY `hooks` is the nastier case: string
  //       keys assigned onto it vanish from JSON.stringify, so the old code
  //       committed a write, logged "Hooks installed" and reported
  //       installed:true over a file that still had no hooks — the checkbox
  //       W6 made truthful would then flip straight back off.
  it.each([
    ['an array', [] as unknown],
    ['a string', 'yes' as unknown],
    ['a number', 7 as unknown],
  ])('refuses to install when hooks is %s, not an object', async (_label, value) => {
    const settingsPath = settingsPathFor();
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: value });
    fs.writeFileSync(settingsPath, original);

    await expect(installHooks()).rejects.toThrow(/hooks in ~\/\.claude\/settings\.json/);
    await expect(installHooks()).rejects.toThrow(/hooks not installed/);

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
    expect(areHooksInstalled()).toBe(false);
  });

  // 8k-3. Junk parked inside an event array is the user's and cannot be ours.
  //       It must not crash the scan — least of all in an event we no longer
  //       install, where the migration sweep newly walks it and a throw would
  //       block install on a key we are trying to clean up.
  it('installs past junk entries in an event array', async () => {
    const settingsPath = settingsPathFor();
    const malformedEntry = { matcher: '' }; // no hooks array
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { UserPromptSubmit: [null, 'junk'], Stop: [null, 'junk', malformedEntry] },
      }),
    );

    // Before the guard this threw "Cannot read properties of null".
    await installHooks();

    expect(areHooksInstalled()).toBe(true);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    // ALL junk survives next to our freshly appended entry, `null` included.
    // `null` used to be the internal "this entry is now empty" sentinel, so a
    // user-authored null was silently deleted; it is a Symbol now, which
    // cannot appear in parsed JSON.
    expect(hooks['Stop']).toHaveLength(4);
    expect(hooks['Stop'][0]).toBe(null);
    expect(hooks['Stop'][1]).toBe('junk');
    expect(hooks['Stop'][2]).toEqual(malformedEntry);
    // The unlisted event is untouched: nothing of OURS was in it, so we have
    // no business rewriting it at all.
    expect(hooks['UserPromptSubmit']).toEqual([null, 'junk']);
  });

  // 8k-4. The sentinel collision, isolated: a settings.json with NO Pixel
  //       Agents command anywhere came back rewritten (and logged as "Hooks
  //       removed") purely because it contained a JSON null.
  it('never rewrites a file whose only oddity is a user-authored null', async () => {
    const settingsPath = settingsPathFor();
    const original = JSON.stringify({ hooks: { Stop: [null, 'third-party-junk'] } });
    fs.writeFileSync(settingsPath, original);

    await uninstallHooks();

    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  // 8k-5. An unlisted event holding a non-array value is the user's alone: we
  //       have nothing of ours to strip from it, so the migration sweep must
  //       pass it through untouched rather than skip-then-rewrite or refuse.
  it('preserves a non-array value under an event we do not install', async () => {
    const settingsPath = settingsPathFor();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { FutureClaudeEvent: { some: 'object' } } }),
    );

    await installHooks();

    const hooks = readSettings().hooks as Record<string, unknown>;
    expect(hooks['FutureClaudeEvent']).toEqual({ some: 'object' });
    expect(areHooksInstalled()).toBe(true);
  });

  // ── W3: exact-suffix hook identity ────────────────────────────

  describe('hook command identity', () => {
    const ours = (p: string) => ({ matcher: '', hooks: [{ type: 'command', command: p }] });

    it.each([
      ['unix path', 'node "/home/me/.pixel-agents/hooks/claude-hook.js"', true],
      ['windows path', 'node "C:\\Users\\x\\.pixel-agents\\hooks\\claude-hook.js"', true],
      ['unquoted unix path', 'node /home/me/.pixel-agents/hooks/claude-hook.js', true],
      ['bare absolute path, no node', '/home/me/.pixel-agents/hooks/claude-hook.js', true],
      [
        'absolute node binary',
        '/usr/local/bin/node /home/me/.pixel-agents/hooks/claude-hook.js',
        true,
      ],
      [
        'windows node binary',
        'C:\\Program Files\\node.exe "C:\\U\\x\\.pixel-agents\\hooks\\claude-hook.js"',
        true,
      ],
      // A RELATIVE path resolves against whatever directory Claude Code runs
      // in, so it names a project-local file that is almost certainly not ours
      // — and we always write an absolute one.
      ['bare relative path', '.pixel-agents/hooks/claude-hook.js', false],
      ['dot-slash relative path', './.pixel-agents/hooks/claude-hook.js', false],
      ['relative path via node', 'node .pixel-agents/hooks/claude-hook.js', false],
      ['legacy script name', 'node /home/me/.pixel-agents/pixel-agents-hook.js', true],
      // The accidental-collision case: both old substrings present, in
      // unrelated positions, in a path that is not ours at all.
      ['foreign .pixel-agents-backup dir', 'node /opt/.pixel-agents-backup/claude-hook.js', false],
      ['bare script name', 'node claude-hook.js', false],
      ['other tool', 'node /opt/other-tool/hook.js', false],
      // Token-boundary cases. Every one of these was classified as OURS by the
      // substring matcher, and uninstallHooks DELETED all of them.
      ['suffixed .backup file', 'node /opt/.pixel-agents/hooks/claude-hook.js.backup', false],
      ['suffixed .disabled file', 'node /opt/.pixel-agents/hooks/claude-hook.js.disabled', false],
      [
        'no separator before .pixel-agents',
        'node /opt/evil.pixel-agents/hooks/claude-hook.js',
        false,
      ],
      ['legacy name without separator', 'node /opt/my-pixel-agents-hook.js', false],
      ['legacy name with suffix', 'node /opt/.pixel-agents/pixel-agents-hook.js.bak', false],
      // Our path appears, but not as the thing being RUN.
      ['inside a comment', 'true # /opt/.pixel-agents/hooks/claude-hook.js', false],
      [
        'as a wrapper argument',
        'wrapper --note=".pixel-agents/hooks/claude-hook.js" /usr/bin/x',
        false,
      ],
      [
        'deeper path under ours',
        'node /home/me/.pixel-agents/hooks/claude-hook.js/inner.js',
        false,
      ],
      // Casing is normalized away (W3). On the case-insensitive volumes this
      // ships on (macOS, Windows) a differently-cased path is the SAME INODE as
      // our script and is genuinely firing, so reading it as foreign duplicated
      // it on reinstall and orphaned it on uninstall.
      ['differently cased path', 'node "/home/X/.Pixel-Agents/Hooks/Claude-Hook.js"', true],
    ])('%s -> %s', async (_label, command, isOurs) => {
      const settingsPath = settingsPathFor();
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [ours(command)]])),
        }),
      );
      expect(areHooksInstalled()).toBe(isOurs);
    });

    // Behavioral consequence of the old two-substring matcher: a third-party
    // hook under a `.pixel-agents-backup` directory read as ours, so install
    // was skipped and uninstall DELETED it.
    it('never claims or deletes a foreign hook that merely contains both markers', async () => {
      const settingsPath = settingsPathFor();
      const foreign = ours('node /opt/.pixel-agents-backup/claude-hook.js');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [foreign]])),
        }),
      );

      expect(areHooksInstalled()).toBe(false);

      await uninstallHooks();
      const stop = (readSettings().hooks as Record<string, unknown[]>)['Stop'];
      expect(stop).toEqual([foreign]);
    });

    // The full deletion set, driven through the real uninstall. Each of these
    // was reported by the bundled installer as ours and REMOVED from the user's
    // settings.json — the same "we destroyed your config" class the whole
    // module exists to fix.
    it.each([
      ['a .backup copy of our script', 'node /opt/.pixel-agents/hooks/claude-hook.js.backup'],
      ['a disabled legacy script', 'node /opt/pixel-agents-hook.js.disabled'],
      ['a shell comment mentioning our path', 'true # /opt/.pixel-agents/hooks/claude-hook.js'],
      [
        'a wrapper naming our path in an argument',
        'my-wrapper --note=".pixel-agents/hooks/claude-hook.js" /usr/bin/real-hook',
      ],
      ['a lookalike directory', 'node /opt/evil.pixel-agents/hooks/claude-hook.js'],
      ['a lookalike legacy name', 'node /opt/my-pixel-agents-hook.js.bak'],
    ])('uninstall leaves %s in place', async (_label, command) => {
      const settingsPath = settingsPathFor();
      const foreign = ours(command);
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [foreign] } }));

      await uninstallHooks();

      expect((readSettings().hooks as Record<string, unknown[]>)['Stop']).toEqual([foreign]);
    });

    // The positive half of W3, and the shipped bug it fixes: on macOS/Windows a
    // differently-cased path is the SAME FILE as our script and is genuinely
    // firing. The case-sensitive matcher could not see it, so uninstall left it
    // behind — a live hook the user had no route to remove, since our own
    // areHooksInstalled reported nothing installed.
    it('uninstall removes a differently-cased path to our own script', async () => {
      const settingsPath = settingsPathFor();
      const cased = ours('node "/home/X/.Pixel-Agents/Hooks/Claude-Hook.js"');
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [cased] } }));

      expect(areHooksInstalled()).toBe(true);
      await uninstallHooks();

      // Our removal emptied the entry (DROP_ENTRY), then the Stop key, then the
      // whole hooks object — each removed only because OUR removal emptied it.
      expect(readSettings().hooks).toBeUndefined();
      expect(areHooksInstalled()).toBe(false);
    });

    // The trade-off named in isOurHookCommand's contract, pinned so a future
    // change to it is deliberate: a symlink ALIAS to our script is not
    // recognized (we compare text, never resolve paths from a config file).
    // The consequence is bounded — a second, canonical entry appears next to
    // the alias — and it is the safe direction: resolving paths would let a
    // symlink a stranger controls point at our script and get their hook
    // deleted.
    it('does not recognize a symlink alias to our script, and installs alongside it', async () => {
      const settingsPath = settingsPathFor();
      const alias = ours(`node "${path.join(tmpBase, 'my-hook-alias.js')}"`);
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [alias] } }));

      expect(areHooksInstalled()).toBe(false);
      await installHooks();

      const stop = (
        readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
      )['Stop'];
      expect(stop[0]).toEqual(alias);
      expect(stop).toHaveLength(2);
      expect(stop[1].hooks[0].command).toBe(ourCommand());
    });
  });

  // ── W4: event-scope reduction + stale-install migration ───────

  it('installs no UserPromptSubmit or TaskCreated hook', async () => {
    await installHooks();
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['UserPromptSubmit']).toBeUndefined();
    expect(hooks['TaskCreated']).toBeUndefined();
    expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
  });

  // The migration that matters: a legacy 14-event install still satisfies
  // areHooksInstalled (superset), so nothing else would ever strip the two
  // prompt-forwarding events. The next install must do it.
  it('strips our hooks from unlisted events left by a legacy install', async () => {
    const settingsPath = settingsPathFor();
    const legacyEvents = [...CLAUDE_HOOK_EVENTS, 'UserPromptSubmit', 'TaskCreated'];
    const theirCommand = 'node /elsewhere/other-tool.js';
    const hooks: Record<string, unknown[]> = {};
    for (const event of legacyEvents) {
      hooks[event] = [
        { matcher: '', hooks: [{ type: 'command', command: ourCommand(), timeout: 5 }] },
      ];
    }
    // A third-party hook sharing the UserPromptSubmit entry must survive the sweep.
    (
      hooks['UserPromptSubmit'] as Array<{ hooks: Array<{ type: string; command: string }> }>
    )[0].hooks.unshift({
      type: 'command',
      command: theirCommand,
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks }));

    // Precondition: the legacy install reads as installed (superset of the new list).
    expect(areHooksInstalled()).toBe(true);

    await installHooks();

    const after = readSettings().hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    // TaskCreated held only our hook -> emptied and removed entirely.
    expect(after['TaskCreated']).toBeUndefined();
    // UserPromptSubmit kept the third-party hook and lost only ours.
    expect(after['UserPromptSubmit']).toHaveLength(1);
    expect(after['UserPromptSubmit'][0].hooks.map((h) => h.command)).toEqual([theirCommand]);
    // Every installed event still carries exactly one of ours.
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(after[event].flatMap((e) => e.hooks.map((h) => h.command))).toEqual([ourCommand()]);
    }
    expect(allCommands().filter((c) => c === ourCommand())).toHaveLength(CLAUDE_HOOK_EVENTS.length);
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
  it.skipIf(process.platform === 'win32')('copyHookScript sets executable permissions', () => {
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
