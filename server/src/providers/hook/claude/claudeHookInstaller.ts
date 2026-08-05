import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR, SERVER_JSON_DIR } from '../../../constants.js';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SCRIPT_NAME,
  SETTINGS_MUTATE_ATTEMPTS,
  SETTINGS_MUTATE_RETRY_DELAY_MS,
} from './constants.js';

/** Marker string used to identify Pixel Agents hook entries in Claude's settings. */
const HOOK_SCRIPT_MARKER = CLAUDE_HOOK_SCRIPT_NAME;

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
 * - the file changing between our read and our write — writing the stale
 *   object would silently drop the other writer's change, so re-read and
 *   redo the mutation on the fresh content instead.
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
      if (readRawClaudeSettings() !== raw) {
        lastError = new Error(SETTINGS_CONCURRENT_WRITE_MESSAGE);
        continue;
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    writeClaudeSettings(settings);
    return true;
  }
  throw lastError ?? new Error(SETTINGS_UNPARSEABLE_MESSAGE);
}

/** One-time safety net: before Pixel Agents' first-ever modification of
 *  settings.json, copy it to settings.json.backup. Never overwritten after
 *  that, so even a future installer bug leaves the user a recoverable copy. */
function backupClaudeSettingsOnce(settingsPath: string): void {
  const backupPath = settingsPath + '.backup';
  try {
    if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(settingsPath, backupPath);
      console.log(`[Pixel Agents] Backed up Claude settings to ${backupPath}`);
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to back up Claude settings: ${e}`);
  }
}

/** Write settings back to ~/.claude/settings.json via atomic tmp + rename. */
function writeClaudeSettings(settings: ClaudeSettings): void {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    backupClaudeSettingsOnce(settingsPath);
    // Atomic write via tmp file + rename
    const tmpPath = settingsPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Claude settings: ${e}`);
  }
}

/** Legacy script name (before rename to claude-hook.js). Brand-named, so a
 *  bare substring match carries no real collision risk. */
const LEGACY_HOOK_MARKER = 'pixel-agents-hook.js';

/** Check if a single hook command is ours. The script name alone is NOT
 *  identity: `claude-hook.js` is a generic name another Claude tool could
 *  plausibly use, and matching it alone would delete that tool's hook as if it
 *  were ours. Ours = the script name AND our `.pixel-agents` directory in the
 *  same command (any absolute path, either path-separator style). */
function isOurHookCommand(command: string): boolean {
  return (
    (command.includes(HOOK_SCRIPT_MARKER) && command.includes(SERVER_JSON_DIR)) ||
    command.includes(LEGACY_HOOK_MARKER)
  );
}

/** Whether any command in the entry is ours (used by areHooksInstalled). */
function entryHasOurHook(entry: ClaudeHookEntry): boolean {
  return (
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === 'string' && isOurHookCommand(h.command))
  );
}

/** Remove our commands from an entry, preserving third-party hooks that share
 *  it. Returns the slimmed entry, or null when nothing remains. Filtering at
 *  the entry level would be wrong: an entry holds an ARRAY of hooks, and a
 *  user who hand-merged our command into their own entry must not lose theirs
 *  when we clean up ours. */
function withoutOurHooks(entry: ClaudeHookEntry): ClaudeHookEntry | null {
  if (!Array.isArray(entry.hooks)) return entry;
  const kept = entry.hooks.filter(
    (h) => !(typeof h.command === 'string' && isOurHookCommand(h.command)),
  );
  if (kept.length === entry.hooks.length) return entry;
  if (kept.length === 0) return null;
  return { ...entry, hooks: kept };
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

/** Check if Pixel Agents hooks are already installed in ~/.claude/settings.json.
 *  An unparseable file reads as "not installed" — the install path will then
 *  refuse to touch it rather than rewrite it. */
export function areHooksInstalled(): boolean {
  let settings: ClaudeSettings;
  try {
    settings = readClaudeSettings();
  } catch {
    return false;
  }
  if (!settings.hooks) return false;
  const events = CLAUDE_HOOK_EVENTS;
  return events.every((event) => {
    const entries = settings.hooks?.[event];
    return Array.isArray(entries) && entries.some(entryHasOurHook);
  });
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
    if (!settings.hooks) {
      settings.hooks = {};
    }
    let changed = false;
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = [];
      }
      const entries = settings.hooks[event];
      // Remove any existing Pixel Agents commands (in case the script path changed)
      const filtered = entries.map(withoutOurHooks).filter((e): e is ClaudeHookEntry => e !== null);
      filtered.push(makeHookEntry());
      if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
        settings.hooks[event] = filtered;
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
      if (!settings.hooks) return false;
      let changed = false;
      for (const event of Object.keys(settings.hooks)) {
        const entries = settings.hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = entries
          .map(withoutOurHooks)
          .filter((e): e is ClaudeHookEntry => e !== null);
        // Length alone misses a slimmed shared entry (entry kept, our command
        // removed from inside it) — compare content.
        if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
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
