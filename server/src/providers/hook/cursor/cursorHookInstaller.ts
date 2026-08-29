import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_SCRIPT_NAME,
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_FRESH_FILE_MODE,
  SETTINGS_MUTATE_ATTEMPTS,
  SETTINGS_MUTATE_RETRY_DELAY_MS,
  SETTINGS_TMP_SUFFIX,
} from './constants.js';

/** A single hook definition in ~/.cursor/hooks.json. */
interface CursorHookDef {
  command?: string;
  timeout?: number;
  matcher?: unknown;
  type?: string;
  [key: string]: unknown;
}

/** Partial shape of ~/.cursor/hooks.json. */
interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookDef[]>;
  [key: string]: unknown;
}

function getCursorHooksPath(): string {
  return path.join(os.homedir(), '.cursor', 'hooks.json');
}

function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CURSOR_HOOK_SCRIPT_NAME);
}

export const SETTINGS_UNPARSEABLE_MESSAGE = "Couldn't parse ~/.cursor/hooks.json";

export const SETTINGS_CONCURRENT_WRITE_MESSAGE =
  '~/.cursor/hooks.json is being modified by another process';

class ConcurrentWriteError extends Error {
  constructor() {
    super(SETTINGS_CONCURRENT_WRITE_MESSAGE);
    this.name = 'ConcurrentWriteError';
  }
}

export function settingsNonArrayEventMessage(event: string): string {
  return `hooks.${event} in ~/.cursor/hooks.json is not an array — fix or remove it`;
}

export const SETTINGS_HOOKS_NOT_OBJECT_MESSAGE =
  'hooks in ~/.cursor/hooks.json is not an object — fix or remove it';

function readRawCursorHooks(): string | null {
  const hooksPath = getCursorHooksPath();
  if (!fs.existsSync(hooksPath)) return null;
  return fs.readFileSync(hooksPath, 'utf-8');
}

function parseCursorHooks(raw: string | null): CursorHooksFile {
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as CursorHooksFile;
  } catch (e) {
    throw new Error(SETTINGS_UNPARSEABLE_MESSAGE, { cause: e });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mutateCursorHooks(mutate: (file: CursorHooksFile) => boolean): Promise<boolean> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < SETTINGS_MUTATE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SETTINGS_MUTATE_RETRY_DELAY_MS);
    let raw: string | null;
    let file: CursorHooksFile;
    try {
      raw = readRawCursorHooks();
      file = parseCursorHooks(raw);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!mutate(file)) return false;
    try {
      writeCursorHooks(file, raw);
      return true;
    } catch (e) {
      if (!(e instanceof ConcurrentWriteError)) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error(SETTINGS_UNPARSEABLE_MESSAGE);
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function settingsUnusableBackupMessage(backupPath: string): string {
  return `${backupPath} exists but is not a regular file, so no backup of hooks.json could be made — move or remove it`;
}

function backupCursorHooksOnce(hooksPath: string): void {
  if (!fs.existsSync(hooksPath)) return;
  const backupPath = hooksPath + SETTINGS_BACKUP_SUFFIX;
  try {
    fs.copyFileSync(hooksPath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`[Pixel Agents] Backed up Cursor hooks to ${backupPath}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!isRegularFile(backupPath)) {
      throw new Error(settingsUnusableBackupMessage(backupPath), { cause: e });
    }
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

function writeCursorHooks(file: CursorHooksFile, expectedRaw: string | null): void {
  const hooksPath = getCursorHooksPath();
  const dir = path.dirname(hooksPath);
  const tmpPath = hooksPath + SETTINGS_TMP_SUFFIX;

  removeIfPresent(tmpPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (expectedRaw === null || !fileHoldsOnlyOurHooks(parseCursorHooks(expectedRaw))) {
    backupCursorHooksOnce(hooksPath);
  }

  const mode = fs.existsSync(hooksPath)
    ? fs.statSync(hooksPath).mode & 0o777
    : SETTINGS_FRESH_FILE_MODE;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), {
      encoding: 'utf-8',
      mode: SETTINGS_FRESH_FILE_MODE,
    });
    fs.chmodSync(tmpPath, mode);
    if (readRawCursorHooks() !== expectedRaw) {
      throw new ConcurrentWriteError();
    }
    fs.renameSync(tmpPath, hooksPath);
  } catch (e) {
    removeIfPresent(tmpPath);
    throw e;
  }
}

const HOOK_PATH_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${CURSOR_HOOK_SCRIPT_NAME}`;
const PATH_TERMINATORS = new Set([' ', '\t', '"', "'", ';', '&', '|', '>', '<', ')']);

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

function isOurHookCommand(command: string): boolean {
  const token = firstCommandToken(command);
  if (token === null) return false;
  return token.toLowerCase().endsWith(HOOK_PATH_SUFFIX);
}

function isOurHook(hook: CursorHookDef): boolean {
  return (
    hook !== null &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    isOurHookCommand(hook.command)
  );
}

function fileHoldsOnlyOurHooks(file: CursorHooksFile): boolean {
  const extraKeys = Object.keys(file).filter((k) => k !== 'hooks' && k !== 'version');
  if (extraKeys.length > 0) return false;
  if (!('hooks' in file)) return true;
  const hooks = file.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
      if (!isOurHook(entry)) return false;
    }
  }
  return true;
}

function withoutOurHooks(entries: CursorHookDef[]): CursorHookDef[] | null {
  const filtered = entries.filter((e) => !isOurHook(e));
  return filtered.length === entries.length ? null : filtered;
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function makeHookDef(): CursorHookDef {
  return { command: makeHookCommand(), timeout: 5 };
}

export function areHooksInstalled(): boolean {
  let file: CursorHooksFile;
  try {
    file = parseCursorHooks(readRawCursorHooks());
  } catch {
    return false;
  }
  const hooks = file.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.some((e) => isOurHook(e)),
  );
}

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
    console.log('[Pixel Agents] Hooks installed in ~/.cursor/hooks.json');
  }
}

function installEntries(): Promise<boolean> {
  return mutateCursorHooks((file) => {
    if (file.version === undefined) {
      file.version = 1;
    }
    if (file.hooks === undefined || file.hooks === null) {
      file.hooks = {};
    } else if (typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
      throw new Error(SETTINGS_HOOKS_NOT_OBJECT_MESSAGE);
    }
    const hooks = file.hooks;
    let changed = file.version !== 1 ? ((file.version = 1), true) : false;

    const listed = new Set<string>(CURSOR_HOOK_EVENTS);
    for (const event of Object.keys(hooks)) {
      if (listed.has(event)) continue;
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const filtered = withoutOurHooks(entries);
      if (filtered === null) continue;
      changed = true;
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }

    for (const event of CURSOR_HOOK_EVENTS) {
      const existing = hooks[event];
      if (existing === undefined) {
        hooks[event] = [];
      } else if (!Array.isArray(existing)) {
        throw new Error(settingsNonArrayEventMessage(event));
      }
      const entries = hooks[event];
      const stripped = withoutOurHooks(entries) ?? entries;
      const next = stripped.concat(makeHookDef());
      if (JSON.stringify(next) !== JSON.stringify(entries)) {
        hooks[event] = next;
        changed = true;
      }
    }
    return changed;
  });
}

export async function uninstallHooks(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await mutateCursorHooks((file) => {
      if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
        return false;
      }
      const hooks = file.hooks;
      let changed = false;
      for (const event of Object.keys(hooks)) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = withoutOurHooks(entries);
        if (filtered === null) continue;
        changed = true;
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
      if (changed && Object.keys(hooks).length === 0) {
        delete file.hooks;
      }
      return changed;
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hook entries left in place.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[Pixel Agents] Hooks removed from ~/.cursor/hooks.json');
  }
}

/** Copy the shipped Cursor hook script to ~/.pixel-agents/hooks/. */
export function copyHookScript(extensionPath: string): boolean {
  const src = path.join(extensionPath, 'dist', 'hooks', CURSOR_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Cursor hook script not found at ${src}`);
      return false;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Cursor hook script installed at ${dst}`);
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Cursor hook script: ${e}`);
    return false;
  }
}
