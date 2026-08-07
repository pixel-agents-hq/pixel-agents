import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SCRIPT_NAME,
  LEGACY_HOOK_SCRIPT_NAME,
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_FRESH_FILE_MODE,
  SETTINGS_MUTATE_ATTEMPTS,
  SETTINGS_MUTATE_RETRY_DELAY_MS,
  SETTINGS_TMP_SUFFIX,
} from './constants.js';

/** A single hook entry in Claude Code's ~/.claude/settings.json hooks config. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

/** Partial shape of ~/.claude/settings.json (only the hooks field is relevant). */
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

/** Returns the absolute path to ~/.claude/settings.json. */
function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Returns the destination path for the hook script (~/.pixel-agents/hooks/claude-hook.js). */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CLAUDE_HOOK_SCRIPT_NAME);
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

/** Surfaced when a `hooks.<Event>` field holds something other than an array.
 *  The value is malformed but it is the USER's — replacing it with `[]` (what
 *  we used to do) silently destroys hand-written config, which is the same
 *  class of bug as rewriting an unparseable file. Refuse instead. */
export function settingsNonArrayEventMessage(event: string): string {
  return `hooks.${event} in ~/.claude/settings.json is not an array — fix or remove it`;
}

/** Surfaced when `hooks` itself is not an object (an array or a scalar). Same
 *  rule one level up: writing our events onto it would either lose them
 *  silently (string keys on an array do not survive JSON.stringify) or crash
 *  with a raw TypeError. */
export const SETTINGS_HOOKS_NOT_OBJECT_MESSAGE =
  'hooks in ~/.claude/settings.json is not an object — fix or remove it';

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
function readClaudeSettings(): ClaudeSettings {
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
async function mutateClaudeSettings(
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
 *  is not a regular file throws. */
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
  backupClaudeSettingsOnce(settingsPath);

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

/** Legacy script name (before rename to claude-hook.js), as a path suffix. */
const LEGACY_HOOK_PATH_SUFFIX = `/${LEGACY_HOOK_SCRIPT_NAME}`;

/** The path suffix we own: `/.pixel-agents/hooks/claude-hook.js`. The leading
 *  separator is load-bearing — without it `/opt/evil.pixel-agents/hooks/...`
 *  and `my-pixel-agents-hook.js` match by substring. */
const HOOK_PATH_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${CLAUDE_HOOK_SCRIPT_NAME}`;

/** Characters that end a path token in a shell command line. A path we own is
 *  either the whole token or ends at one of these; anything else after it
 *  (`.backup`, `.disabled`, more path segments) means the command names a
 *  DIFFERENT file that merely starts with our path. */
const PATH_TERMINATORS = new Set([' ', '\t', '"', "'", ';', '&', '|', '>', '<', ')']);

/**
 * Check if a single hook command is ours.
 *
 * Neither half of the path is identity on its own: `claude-hook.js` is a
 * generic name another Claude tool could plausibly use, and substring tests
 * claim unrelated commands. Empirically, plain `includes` classified all of
 * these as ours — and `uninstallHooks` then DELETED them:
 *   node /opt/.pixel-agents/hooks/claude-hook.js.backup   (a different file)
 *   true # /opt/.pixel-agents/hooks/claude-hook.js        (a comment)
 *   wrapper --note=".pixel-agents/hooks/claude-hook.js" x (an argument)
 *   node /opt/evil.pixel-agents/hooks/claude-hook.js      (no token boundary)
 *   node /opt/my-pixel-agents-hook.js.bak                 (legacy, no boundary)
 * Deleting a third-party hook is the same "we destroyed the user's config"
 * class of bug this whole module exists to fix, so identity is anchored at
 * BOTH ends: our path suffix must start at a path separator and must END the
 * command's script token.
 *
 * Deliberate scope choices:
 * - Casing is NOT significant: the token is normalized to lower case before the
 *   suffix compare. macOS and Windows — the two GUI platforms this ships on —
 *   have case-insensitive volumes, where `/home/x/.Pixel-Agents/Hooks/Claude-Hook.js`
 *   is the SAME INODE as our script and is genuinely firing. Reading it as
 *   foreign is what shipped: reinstall appended a duplicate (both fired), and
 *   uninstall left the cased entry behind as an orphan our own uninstall could
 *   no longer see — a running hook the user has no route to remove. The folding
 *   is UNCONDITIONAL (we do not probe the filesystem's case sensitivity), so the
 *   accepted residual is a Linux-only false positive that is NOT harmless: on a
 *   case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely
 *   DIFFERENT file, we classify it as ours, and uninstall DELETES it — the same
 *   class of loss this module exists to prevent, traded knowingly against a
 *   guaranteed unremovable live hook on the two platforms that actually ship
 *   here (see the removal pinned in claudeHookInstaller.test.ts). Nothing we or
 *   Claude Code write ever creates that path. The blast radius is bounded by the
 *   rest of the anchoring: a third-party hook differing in more than case is
 *   still untouched.
 * - The FIRST token only. A command is `node <script>` or `<script>`; our path
 *   appearing later is an argument or a comment, not the thing being run.
 * - ABSOLUTE paths only. We always write one, and a RELATIVE
 *   `.pixel-agents/hooks/claude-hook.js` resolves against whatever directory
 *   Claude Code happens to run in — so it names a project-local file that is
 *   almost certainly not ours, and deleting it would be the same mistake as
 *   deleting a lookalike.
 * - Suffix, not the resolved homedir: an entry written under a previous or
 *   moved HOME is still ours to clean up.
 * - A symlink ALIAS pointing at our script is not recognized (we compare text,
 *   never resolve). That direction is safe — a later install appends the
 *   canonical command next to the alias, so the worst case is one duplicate
 *   execution for a user who hand-aliased us, versus deleting a stranger's
 *   hook for everyone if we resolved paths from a config file.
 */
function isOurHookCommand(command: string): boolean {
  const token = firstCommandToken(command);
  if (token === null) return false;
  // Both suffix constants are lower-case, so folding the token is the whole
  // normalization.
  const normalized = token.toLowerCase();
  return normalized.endsWith(HOOK_PATH_SUFFIX) || normalized.endsWith(LEGACY_HOOK_PATH_SUFFIX);
}

/**
 * The ABSOLUTE path of the script a command runs, normalized to forward
 * slashes, or null when the command doesn't look like one of ours.
 *
 * `node "<path>"` and a bare `<path>` are the two shapes we write (and the two
 * a user plausibly hand-edits). A Windows drive prefix (`C:/…`) counts as
 * absolute; a relative path does not (see isOurHookCommand's contract).
 */
function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  // `node <script>` / `node "<script>"` — take the argument. The interpreter
  // itself may be a path (quoted, and on Windows containing spaces).
  const nodeInvocation = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+(.+)$/.exec(trimmed);
  const raw = nodeInvocation ? nodeInvocation[1] : trimmed;
  const token = readToken(raw.trim());
  if (token === null) return null;
  const normalized = token.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return absolute ? normalized : null;
}

/** Read one shell token: a quoted string, or characters up to the first
 *  terminator. Returns null when the token is empty or unterminated. */
function readToken(raw: string): string | null {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  let end = 0;
  while (end < raw.length && !PATH_TERMINATORS.has(raw[end])) end++;
  return end > 0 ? raw.slice(0, end) : null;
}

/** Whether any command in the entry is ours (used by areHooksInstalled). */
function entryHasOurHook(entry: ClaudeHookEntry): boolean {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isOurHook(h))
  );
}

/** A single hook object is ours. Tolerates junk elements (null, scalars) —
 *  none of them can be ours, and they must not crash the scan. */
function isOurHook(hook: ClaudeHookEntry['hooks'][number]): boolean {
  return (
    hook !== null &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    isOurHookCommand(hook.command)
  );
}

/** "This entry held only our hooks and is now empty — drop it."
 *
 *  A unique symbol, never `null`: `null` is a value a user's settings.json can
 *  legitimately contain inside a hooks array, and using it as the sentinel made
 *  us DELETE it. Observed: `{"hooks":{"Stop":[null,"third-party-junk"]}}` — a
 *  file with no Pixel Agents command anywhere — came back rewritten as
 *  `{"hooks":{"Stop":["third-party-junk"]}}` and logged "Hooks removed". A
 *  sentinel that can collide with user data is a sentinel that eats user data;
 *  a symbol cannot appear in parsed JSON. */
const DROP_ENTRY = Symbol('drop-entry');

/** Remove our commands from an entry, preserving third-party hooks that share
 *  it. Returns the slimmed entry, or DROP_ENTRY when OUR removal emptied it.
 *  Filtering at the entry level would be wrong: an entry holds an ARRAY of
 *  hooks, and a user who hand-merged our command into their own entry must not
 *  lose theirs when we clean up ours. */
function withoutOurHooks(entry: ClaudeHookEntry): ClaudeHookEntry | typeof DROP_ENTRY {
  // Junk elements (null, a scalar, an object without a hooks array) are passed
  // through untouched rather than dereferenced: none of them can be ours, and
  // crashing on one would block install/uninstall on a file we are trying to
  // clean up.
  if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
  const kept = entry.hooks.filter((h) => !isOurHook(h));
  if (kept.length === entry.hooks.length) return entry;
  if (kept.length === 0) return DROP_ENTRY;
  return { ...entry, hooks: kept };
}

/** Strip our commands from one event's entry array. Returns the new array, or
 *  null when nothing of ours was in it (so the caller leaves the key alone —
 *  we never rewrite a field we did not author). */
function withoutOurEntries(entries: ClaudeHookEntry[]): ClaudeHookEntry[] | null {
  const filtered = entries
    .map(withoutOurHooks)
    .filter((e): e is ClaudeHookEntry => e !== DROP_ENTRY);
  // Length alone misses a slimmed shared entry (entry kept, our command removed
  // from inside it) — compare content.
  return JSON.stringify(filtered) === JSON.stringify(entries) ? null : filtered;
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

/**
 * Whether ANY Pixel Agents hook command is present in ~/.claude/settings.json.
 *
 * "Any", not "all 12", and the difference is the whole point. Every caller asks
 * this question for one of two reasons — "are our hooks firing right now?"
 * (the consent gate) or "does the checkbox say hooks are installed?"
 * (`hooksStatus`) — and a hook fires whether or not its eleven siblings are
 * there. An all-or-nothing answer made a partial or textually unrecognized
 * install read as "nothing installed": the checkbox showed OFF while hooks
 * fired, "Not Now" left them firing without saying so, and "Don't Ask Again"
 * persisted hooks-off without removing anything — the exact stranded state
 * this gate exists to prevent.
 *
 * The walk covers EVERY event key, not just the ones we currently install: a
 * legacy install's leftovers under an unlisted event fire too, and uninstall
 * already walks all keys (they must agree, or "remove" would leave behind
 * something this reports as absent).
 *
 * Completeness is not lost information — the install path is idempotent and
 * runs on every consented startup, so a partial install repairs itself the
 * moment consent exists. What it cannot repair is a user who was never told.
 *
 * An unparseable file reads as "not installed" — the install path will then
 * refuse to touch it rather than rewrite it.
 */
export function areHooksInstalled(): boolean {
  let settings: ClaudeSettings;
  try {
    settings = readClaudeSettings();
  } catch {
    return false;
  }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.some(entryHasOurHook),
  );
}

/**
 * Install Pixel Agents hook entries into ~/.claude/settings.json for
 * Notification, Stop, and PermissionRequest events. Idempotent: removes
 * any existing Pixel Agents entries before adding fresh ones.
 *
 * Rejects (before any write) when settings.json exists but cannot be parsed or
 * keeps changing concurrently — callers surface the error to the user instead
 * of installing.
 */
export async function installHooks(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await installEntries();
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hooks not installed.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[Pixel Agents] Hooks installed in ~/.claude/settings.json');
  }
}

function installEntries(): Promise<boolean> {
  return mutateClaudeSettings((settings) => {
    if (settings.hooks === undefined || settings.hooks === null) {
      settings.hooks = {};
    } else if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      // The container itself is malformed. Assigning event keys onto an ARRAY
      // silently loses them (JSON.stringify emits only numeric indices), so the
      // write would commit, log "Hooks installed", and report installed:true
      // over a file with no hooks in it. A scalar crashes with a raw TypeError.
      // Refuse, like a non-array event value one level down.
      throw new Error(SETTINGS_HOOKS_NOT_OBJECT_MESSAGE);
    }
    const hooks = settings.hooks;
    let changed = false;

    // Migration sweep FIRST: strip our commands from every event we no longer
    // install. The per-event loop below only touches listed events, so without
    // this a legacy install (which included UserPromptSubmit and TaskCreated)
    // would keep forwarding prompt text and task payloads forever — the users
    // with the widest install would be the only ones never migrated.
    const listed = new Set<string>(CLAUDE_HOOK_EVENTS);
    for (const event of Object.keys(hooks)) {
      if (listed.has(event)) continue;
      const entries = hooks[event];
      // A non-array under an event we do NOT install is the user's alone (a
      // future Claude event, a hand-written shape). We have nothing of ours to
      // strip from it, so passing it through untouched IS the whole obligation
      // — refusing here would block install on a key that costs us nothing.
      // The listed-event branch below is the one a non-array actually blocks,
      // and there we throw rather than normalize.
      if (!Array.isArray(entries)) continue;
      const filtered = withoutOurEntries(entries);
      if (filtered === null) continue;
      changed = true;
      // Only remove the key when OUR removal emptied it. An event the user
      // left empty on their own is theirs to keep — same rule uninstallHooks
      // follows, and the same reason we never rewrite fields we did not author.
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }

    for (const event of CLAUDE_HOOK_EVENTS) {
      const existing = hooks[event];
      if (existing === undefined) {
        hooks[event] = [];
      } else if (!Array.isArray(existing)) {
        // The value is malformed but it is the USER's. Replacing it with []
        // (what we used to do) silently destroys hand-written config — the
        // same class of bug as rewriting an unparseable file. Refuse: the
        // throw propagates out of the mutate callback and installHooks wraps
        // it with "— hooks not installed."
        throw new Error(settingsNonArrayEventMessage(event));
      }
      const entries = hooks[event];
      // Remove any existing Pixel Agents commands (in case the script path changed)
      const filtered = (withoutOurEntries(entries) ?? entries).concat(makeHookEntry());
      if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
        hooks[event] = filtered;
        changed = true;
      }
    }
    return changed;
  });
}

/** Remove all Pixel Agents hook entries from ~/.claude/settings.json. Cleans up empty objects.
 *  Rejects (before any write) when the file cannot be parsed — same protection
 *  as install: never rewrite a file we could not read. Callers surface the
 *  error; claiming success after an aborted uninstall is how a "removed"
 *  log line ends up next to entries that are still live. */
export async function uninstallHooks(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await mutateClaudeSettings((settings) => {
      if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
        return false;
      }
      const hooks = settings.hooks;
      let changed = false;
      for (const event of Object.keys(hooks)) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = withoutOurEntries(entries);
        if (filtered === null) continue;
        changed = true;
        // Remove the key only when OUR removal emptied it. An event the user
        // left empty themselves is theirs to keep — same rule as installEntries'
        // migration sweep, and the same reason we never rewrite what we did not
        // author.
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
      if (changed && Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
      return changed;
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hook entries left in place.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[Pixel Agents] Hooks removed from ~/.claude/settings.json');
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
