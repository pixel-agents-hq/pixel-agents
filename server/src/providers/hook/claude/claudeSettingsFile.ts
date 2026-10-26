/**
 * ~/.claude/settings.json itself: the one guarded read-modify-write every
 * Pixel Agents writer goes through (the hook installer, the status line
 * bridge), and the backup predicate that decides whether what a write
 * replaces is the user's. Each writer owns its own key and the "exactly our
 * output" check for it; this module only composes them.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../../serverConfig.js';
import { type ClaudeHookEntry, hooksHoldOnlyOurs } from './claudeHookEntries.js';
import {
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_FRESH_FILE_MODE,
  SETTINGS_MUTATE_ATTEMPTS,
  SETTINGS_MUTATE_RETRY_DELAY_MS,
  SETTINGS_TMP_SUFFIX,
} from './constants.js';
import { isBareOurStatusLine } from './statusLineBridge.js';

/** Partial shape of ~/.claude/settings.json (only the fields we write). */
export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  statusLine?: unknown;
  [key: string]: unknown;
}

/** Returns the absolute path to ~/.claude/settings.json. */
function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Surfaced to the user when settings.json exists but cannot be parsed. The
 *  operation (install/uninstall) appends its own outcome suffix. */
export const SETTINGS_UNPARSEABLE_MESSAGE = "Couldn't parse ~/.claude/settings.json";

/** Surfaced when settings.json keeps changing under us across all retry attempts. */
export const SETTINGS_CONCURRENT_WRITE_MESSAGE =
  '~/.claude/settings.json is being modified by another process';

/** The one write failure the mutate loop retries. A dedicated class rather than
 *  a message-string comparison: retrying an EACCES or ENOSPC just delays the
 *  same failure, so the loop must be able to tell "the file changed under us"
 *  apart from every other error with certainty, not by text. */
class ConcurrentWriteError extends Error {
  constructor() {
    super(SETTINGS_CONCURRENT_WRITE_MESSAGE);
    this.name = 'ConcurrentWriteError';
  }
}

/** Raw file content, or null when the file does not exist. Throws on read errors. */
function readRawClaudeSettings(): string | null {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  return fs.readFileSync(settingsPath, 'utf-8');
}

/** Parse raw settings content. A missing file (null) is an empty config; content
 *  that cannot be parsed THROWS. It must never be treated as empty:
 *  settings.json holds the user's permission rules, and a later write based on
 *  `{}` would erase them all. */
function parseClaudeSettings(raw: string | null): ClaudeSettings {
  if (raw === null) {
    return {};
  }
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    throw new Error(SETTINGS_UNPARSEABLE_MESSAGE, { cause: e });
  }
}

/** Read and parse ~/.claude/settings.json (see parseClaudeSettings for the throw contract). */
export function readClaudeSettings(): ClaudeSettings {
  return parseClaudeSettings(readRawClaudeSettings());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Guarded read-modify-write cycle for settings.json. `mutate` edits the parsed
 * settings in place and returns whether anything changed; returns whether a
 * write happened.
 *
 * Two failure modes retry up to SETTINGS_MUTATE_ATTEMPTS times, then throw:
 * - a torn read (Claude Code mid-write parses like a corrupt file) — a retry
 *   distinguishes it from a truly unparseable file;
 * - the file changing between our read and our write (detected inside
 *   writeClaudeSettings, immediately before the rename) — writing the stale
 *   object would silently drop the other writer's change, so re-read and
 *   redo the mutation on the fresh content instead.
 *
 * Every OTHER write error (EACCES, ENOSPC, a failed backup) propagates on the
 * first attempt: retrying a permission error just delays the same failure, and
 * the caller must hear about it rather than get a false "installed".
 */
export async function mutateClaudeSettings(
  mutate: (settings: ClaudeSettings) => boolean,
): Promise<boolean> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < SETTINGS_MUTATE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(SETTINGS_MUTATE_RETRY_DELAY_MS);
    }
    let raw: string | null;
    let settings: ClaudeSettings;
    try {
      raw = readRawClaudeSettings();
      settings = parseClaudeSettings(raw);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!mutate(settings)) {
      return false;
    }
    try {
      writeClaudeSettings(settings, raw);
      return true;
    } catch (e) {
      if (!(e instanceof ConcurrentWriteError)) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error(SETTINGS_UNPARSEABLE_MESSAGE);
}

/** One-time safety net: before Pixel Agents' first-ever modification of
 *  settings.json, copy it aside. Never overwritten after that, so even a future
 *  installer bug leaves the user a recoverable copy of their pre-Pixel-Agents
 *  file.
 *
 *  COPYFILE_EXCL makes "create only if absent" one syscall instead of an
 *  existsSync/copy pair with its own TOCTOU. ANY failure THROWS, because "no
 *  backup" must mean "no write" — a backup we only logged about is exactly the
 *  safety net the 1-star review found missing.
 *
 *  EEXIST is the normal already-backed-up path, but ONLY when what sits there
 *  is a recoverable copy. A directory, a dangling symlink, or a socket at that
 *  path also produces EEXIST, and treating that as "already backed up" is the
 *  same failure wearing a different hat: we modified settings.json with nothing
 *  the user could restore from. So EEXIST is re-verified with a stat that
 *  follows symlinks (a symlink to a real file IS recoverable) and anything that
 *  is not a regular file throws.
 *
 *  The caller skips this entirely when the content being replaced is our own
 *  install's output (settingsHoldOnlyOurOutput) — a backup of what we wrote
 *  preserves nothing and masquerades as the user's original. */
function backupClaudeSettingsOnce(settingsPath: string): void {
  if (!fs.existsSync(settingsPath)) return;
  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
  try {
    fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`[Pixel Agents] Backed up Claude settings to ${backupPath}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!isRegularFile(backupPath)) {
      throw new Error(settingsUnusableBackupMessage(backupPath), { cause: e });
    }
  }
}

/** Whether the path resolves (through symlinks) to a regular file. */
function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    // ENOENT here means a dangling symlink: the name exists (COPYFILE_EXCL said
    // EEXIST) but resolves to nothing.
    return false;
  }
}

/** Surfaced when the backup path is occupied by something that is not a
 *  recoverable copy of settings.json. */
export function settingsUnusableBackupMessage(backupPath: string): string {
  return `${backupPath} exists but is not a regular file, so no backup of settings.json could be made — move or remove it`;
}

/**
 * Write settings back to ~/.claude/settings.json via atomic tmp + rename.
 *
 * `expectedRaw` is the exact file content the caller's mutation was based on
 * (null = the file did not exist). The final re-read verify sits immediately
 * before the rename, AFTER mkdir/backup/tmp-write, so the lost-update window is
 * one read plus one rename instead of the whole preparation sequence. This is a
 * narrowing, not a guarantee — Claude Code does not coordinate with us, and a
 * write landing inside that gap is still lost.
 *
 * Every failure throws after a best-effort tmp cleanup. Nothing is logged and
 * swallowed: a caller that hears no error installs an entry pointing at a file
 * that was never written.
 */
function writeClaudeSettings(settings: ClaudeSettings, expectedRaw: string | null): void {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  const tmpPath = settingsPath + SETTINGS_TMP_SUFFIX;

  // A tmp file left by a crashed earlier run would make the rename below write
  // stale content on a platform where rename is not the commit we assume.
  removeIfPresent(tmpPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The backup preserves the user's pre-Pixel-Agents file; when the content
  // being replaced is entirely of our own writing (typical after our install
  // CREATED settings.json in a fresh home), there is nothing to preserve and
  // the copy is skipped. The decision reads expectedRaw — the same content the
  // verify below pins: if the file gained user content after our read, the
  // skip is stale but the write aborts before the rename and the retry
  // re-decides on the fresh content, so a commit never outruns a warranted
  // backup. expectedRaw === null keeps the call: a file present NOW was
  // written by someone else, and preserving it costs nothing (the verify
  // aborts this write anyway). The re-parse of expectedRaw is required, not
  // redundant: the object mutateClaudeSettings parsed from it has already
  // been mutated by the callback — it now holds what we are ABOUT to write,
  // and this decision must be about what we are REPLACING.
  if (expectedRaw === null || !settingsHoldOnlyOurOutput(parseClaudeSettings(expectedRaw))) {
    backupClaudeSettingsOnce(settingsPath);
  }

  // Preserve the user's mode: chmod 600 on settings.json is a deliberate choice
  // (the file holds permission rules), and writeFileSync's umask-derived 0644
  // would silently relax it. chmod rather than the writeFileSync `mode` option
  // because `mode` is masked by umask; chmod is not.
  const mode = fs.existsSync(settingsPath)
    ? fs.statSync(settingsPath).mode & 0o777
    : SETTINGS_FRESH_FILE_MODE;

  try {
    // Created restrictively (umask can only tighten `mode`, never loosen it),
    // then chmod'd to the exact target: the tmp holds the user's full settings
    // and must never sit world-readable, not even for the microseconds between
    // creation and the chmod, when the source was 0600.
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), {
      encoding: 'utf-8',
      mode: SETTINGS_FRESH_FILE_MODE,
    });
    fs.chmodSync(tmpPath, mode);
    if (readRawClaudeSettings() !== expectedRaw) {
      throw new ConcurrentWriteError();
    }
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    removeIfPresent(tmpPath);
    throw e;
  }
}

/** Best-effort unlink: a leftover tmp file we cannot remove must not mask the
 *  real error we are already reporting. */
function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

/** Every top-level key a Pixel Agents writer owns, with its "this value is
 *  exactly our output" check. */
const OUR_KEYS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ['hooks', hooksHoldOnlyOurs],
  ['statusLine', isBareOurStatusLine],
]);

/** Whether the parsed settings hold nothing a backup could preserve: every
 *  top-level key is one a Pixel Agents writer owns (OUR_KEYS), and its value
 *  is exactly the shape that writer writes, running our script: `hooks` with
 *  only our entries, and `statusLine` as the bare bridge (our command wrapping
 *  nothing, what install writes into a file with no status line). This is what settings.json looks like
 *  when OUR install created the file in a home that never had one — and a
 *  backup taken then would enshrine our own output as "the user's original"
 *  (observed: a fresh home's first uninstall backed up the install's 12
 *  entries, a copy that can restore nothing the user wrote).
 *
 *  `{"hooks":{}}` and a bare `{}` both qualify: the first is what our
 *  uninstall leaves after emptying an install of ours before it drops the key,
 *  the second is what it writes in a home whose file we created (everything
 *  removed, `hooks` key deleted) — and neither holds a byte a backup could
 *  restore. Every other deviation — an extra top-level key, a wrapped status line, a
 *  non-empty matcher, an unknown field on an entry or hook, a foreign command,
 *  an event array we would not leave behind — reads as user-authored content,
 *  and the ordinary backup-before-write rule applies.
 *
 *  Each key's check compares against its WRITER (makeHookEntry,
 *  makeBareStatusLine), never a hand-written twin of it: see hooksHoldOnlyOurs
 *  for why. A new key we write joins OUR_KEYS with its own check. A top level
 *  that is not an object (a number, a string, an array) is never ours: we only
 *  ever write an object. */
export function settingsHoldOnlyOurOutput(settings: ClaudeSettings): boolean {
  if (!isRecord(settings)) return false;
  return Object.keys(settings).every((key) => OUR_KEYS.get(key)?.(settings[key]) ?? false);
}
