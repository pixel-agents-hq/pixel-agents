/**
 * Installs / removes our hook entries in Codex's user-level hooks config.
 *
 * Target choice: we write `~/.codex/hooks.json` and never touch the user's
 * `config.toml`. Codex accepts hooks in either place and merges them, so a
 * standalone JSON file is strictly safer — we never parse or rewrite TOML, so a
 * bad merge cannot corrupt their model, provider, or approval settings. Codex
 * warns at startup if a single layer has both inline `[hooks]` and hooks.json,
 * which is the user's own pre-existing arrangement and not something we create.
 *
 * Safety rules, mirroring the Claude installer:
 *  - Back up a pre-existing hooks.json exactly once, before our first write.
 *  - Atomic tmp-write + rename, so a crash never leaves a truncated config.
 *  - Only ever remove entries whose command resolves to OUR script path. A
 *    foreign hook in the same event array is preserved verbatim.
 *  - Idempotent: installing twice yields one entry per event.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  CODEX_CONFIG_DIR,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_SCRIPT_NAME,
  CODEX_HOOKS_FILE,
  HOOK_PATH_SUFFIX,
  HOOK_TIMEOUT_SECONDS,
  HOOKS_BACKUP_SUFFIX,
  HOOKS_TMP_SUFFIX,
  SESSION_END_MAX_TIMEOUT_SECONDS,
} from './constants.js';

/** One handler inside a matcher group. */
interface CodexHookHandler {
  type: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  async?: boolean;
  [key: string]: unknown;
}

/** One matcher group in an event's array. */
interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
  [key: string]: unknown;
}

/** Partial shape of hooks.json — only `hooks` is ours to touch; every other
 *  top-level key (e.g. `description`) is preserved as-is. */
interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

export const HOOKS_UNPARSEABLE_MESSAGE = "Couldn't parse ~/.codex/hooks.json";

export function hooksNotObjectMessage(): string {
  return 'hooks in ~/.codex/hooks.json is not an object — fix or remove it';
}
export function eventNotArrayMessage(event: string): string {
  return `hooks.${event} in ~/.codex/hooks.json is not an array — fix or remove it`;
}

/** Absolute path to ~/.codex/hooks.json. */
export function getCodexHooksPath(): string {
  return path.join(os.homedir(), CODEX_CONFIG_DIR, CODEX_HOOKS_FILE);
}

/** Absolute path to the installed hook script. */
export function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

/** Read hooks.json, or an empty object when absent. Throws on malformed JSON so
 *  the caller can surface it rather than silently overwriting the user's file. */
function readHooksFile(): CodexHooksFile {
  const p = getCodexHooksPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return {}; // absent is normal — we create it
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(HOOKS_UNPARSEABLE_MESSAGE);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(HOOKS_UNPARSEABLE_MESSAGE);
  }
  return parsed as CodexHooksFile;
}

/** Atomic write: tmp file next to the target, then rename. Creates ~/.codex if
 *  needed. A one-time backup of a pre-existing file is written first. */
function writeHooksFile(next: CodexHooksFile, hadExisting: boolean): void {
  const p = getCodexHooksPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (hadExisting) {
    const backup = p + HOOKS_BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) {
      try {
        fs.copyFileSync(p, backup);
      } catch {
        /* a failed backup must not block the install; the write is still atomic */
      }
    }
  }

  const tmp = p + HOOKS_TMP_SUFFIX;
  // 0o600: the file records a local port and bearer token path; no reason for
  // it to be group/world readable.
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * First shell token of a command, normalized to forward slashes, or null when
 * it isn't an absolute path. `node "<script>"` and a bare `<script>` are the two
 * shapes we write (and the two a user plausibly hand-edits).
 */
function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  const nodeInvocation = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+(.+)$/.exec(trimmed);
  const raw = nodeInvocation ? nodeInvocation[1] : trimmed;
  const token = readToken(raw.trim());
  if (token === null) return null;
  const normalized = token.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return absolute ? normalized : null;
}

/** Read one shell token: a quoted string, or chars up to the first terminator.
 *  Returns null when empty or unterminated. */
function readToken(raw: string): string | null {
  if (raw === '') return null;
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    if (end <= 1) return null; // unterminated, or empty quotes
    return raw.slice(1, end);
  }
  const match = /^[^\s"';|&]+/.exec(raw);
  return match ? match[0] : null;
}

/**
 * True when this command runs OUR hook script.
 *
 * Matched by path SUFFIX rather than equality with getHookScriptPath(): the
 * absolute path differs across installs (a different home dir, a symlinked
 * home, a Windows drive-letter case), and failing to recognize our own entry
 * would leave a duplicate behind on every reinstall. The suffix is
 * brand-specific (`/codex-hook.js`), so it cannot match a stranger's hook.
 */
export function isOurHookCommand(command: string): boolean {
  const token = firstCommandToken(command);
  if (token === null) return false;
  return token.toLowerCase().endsWith(HOOK_PATH_SUFFIX);
}

/** True when a group contains only our handlers (so removing the whole group
 *  drops nothing of the user's). */
function isOurGroup(group: CodexHookGroup): boolean {
  if (!Array.isArray(group.hooks) || group.hooks.length === 0) return false;
  return group.hooks.every(
    (h) => typeof h?.command === 'string' && isOurHookCommand(h.command as string),
  );
}

/**
 * The handler we install for one event.
 *
 * `async: true` is the whole point: Codex runs it in the background, so the
 * agent loop never waits on our POST even if the office is gone. The short
 * timeout is a second belt on top of that.
 *
 * SessionEnd (and Interrupt) are the documented exceptions — Codex caps their
 * timeout at 3s and ALWAYS runs them synchronously, ignoring `async`. Writing 5
 * there makes Codex print two startup warnings about clamping our own config,
 * so we ask for exactly what it will honour. The hook script's own 2s per-request
 * timeout still bounds the synchronous case.
 */
function ourHandler(event: string): CodexHookHandler {
  const synchronousEvent = event === 'SessionEnd' || event === 'Interrupt';
  return {
    type: 'command',
    command: `node "${getHookScriptPath()}"`,
    timeout: synchronousEvent ? SESSION_END_MAX_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS,
    // Stating async on an event that ignores it is just noise in the user's file.
    ...(synchronousEvent ? {} : { async: true }),
  };
}

/** Drop every group of ours from an event array, preserving foreign groups and
 *  foreign handlers inside mixed groups. Returns the filtered array. */
function stripOurGroups(groups: CodexHookGroup[]): CodexHookGroup[] {
  const out: CodexHookGroup[] = [];
  for (const group of groups) {
    // A non-object element is the user's problem, not ours — preserve it rather
    // than silently deleting data we don't understand.
    if (typeof group !== 'object' || group === null || !Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    if (isOurGroup(group)) continue; // entirely ours — drop
    const kept = group.hooks.filter(
      (h) => !(typeof h?.command === 'string' && isOurHookCommand(h.command as string)),
    );
    if (kept.length === group.hooks.length) {
      out.push(group); // nothing of ours in here
    } else if (kept.length > 0) {
      out.push({ ...group, hooks: kept }); // mixed group — keep the stranger's
    }
    // kept.length === 0 with a length change means every handler was ours
    // inside a group that also carried other keys; dropping it is correct.
  }
  return out;
}

/** Copy the shipped hook script to ~/.pixel-agents/hooks/. Returns false when
 *  the source is missing or the copy fails, so the caller reports the failure
 *  instead of logging a false success: a hooks entry pointing at a missing
 *  script makes Codex spawn a dead `node` for every event, which is worse than
 *  no hooks at all. Mirrors the Claude installer's contract. */
export function copyHookScript(extensionPath: string): boolean {
  const src = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Codex hook script not found at ${src}`);
      return false;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Codex hook script installed at ${dst}`);
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Codex hook script: ${e}`);
    return false;
  }
}

/**
 * Install our handler for every event in CODEX_HOOK_EVENTS.
 *
 * Idempotent: existing entries of ours are stripped first, so a reinstall (or an
 * upgrade that changes the handler shape) converges to exactly one per event.
 * Also sweeps events we no longer install, so a legacy install that carried a
 * wider surface is narrowed on the next run.
 *
 * `serverUrl`/`authToken` are accepted for interface parity with the Claude
 * provider but intentionally unused: the script discovers live servers through
 * ~/.pixel-agents/servers/ at call time, which keeps a stale port out of the
 * user's config file.
 */
export async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  const p = getCodexHooksPath();
  const hadExisting = fs.existsSync(p);
  const file = readHooksFile();

  const hooks = file.hooks ?? {};
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error(hooksNotObjectMessage());
  }

  const next: Record<string, CodexHookGroup[]> = {};
  // Sweep EVERY event present, not just the ones we install: an event we
  // dropped from the list must lose our entry too.
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(eventNotArrayMessage(event));
    }
    const stripped = stripOurGroups(groups);
    if (stripped.length > 0) next[event] = stripped;
  }

  for (const event of CODEX_HOOK_EVENTS) {
    const existing = next[event] ?? [];
    // No `matcher`: we want every tool, and an omitted matcher is Codex's
    // match-everything default.
    next[event] = [...existing, { hooks: [ourHandler(event)] }];
  }

  writeHooksFile({ ...file, hooks: next }, hadExisting);
}

/** Remove every entry of ours, leaving foreign hooks untouched. Deletes the
 *  `hooks` key (and the file, when it holds nothing else) rather than leaving an
 *  empty scaffold behind. */
export async function uninstallHooks(): Promise<void> {
  const p = getCodexHooksPath();
  if (!fs.existsSync(p)) return;

  const file = readHooksFile();
  const hooks = file.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return; // nothing of ours can be in a shape we didn't write
  }

  const next: Record<string, CodexHookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups as unknown as CodexHookGroup[]; // preserve as-is
      continue;
    }
    const stripped = stripOurGroups(groups);
    if (stripped.length > 0) next[event] = stripped;
  }

  const rest = { ...file };
  delete rest.hooks;

  if (Object.keys(next).length > 0) {
    writeHooksFile({ ...rest, hooks: next }, true);
    return;
  }

  // Nothing left under `hooks`. If the file carried nothing else, remove it.
  if (Object.keys(rest).length === 0) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
    return;
  }
  writeHooksFile(rest, true);
}

/** True when our handler is installed for every event we claim. A partial
 *  install reports false, so the caller reinstalls and converges. */
export async function areHooksInstalled(): Promise<boolean> {
  let file: CodexHooksFile;
  try {
    file = readHooksFile();
  } catch {
    return false; // unparseable — we cannot claim an install
  }
  const hooks = file.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false;

  return CODEX_HOOK_EVENTS.every((event) => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return false;
    return groups.some(
      (g) =>
        typeof g === 'object' &&
        g !== null &&
        Array.isArray(g.hooks) &&
        g.hooks.some(
          (h) => typeof h?.command === 'string' && isOurHookCommand(h.command as string),
        ),
    );
  });
}

export { CODEX_HOOK_EVENTS, isOurGroup, ourHandler, readHooksFile, stripOurGroups, writeHooksFile };
export type { CodexHookGroup, CodexHookHandler, CodexHooksFile };
