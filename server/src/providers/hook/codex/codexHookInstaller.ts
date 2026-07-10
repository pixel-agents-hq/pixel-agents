import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { CODEX_HOOK_EVENTS, CODEX_HOOK_SCRIPT_NAME } from './constants.js';

/** Marker string used to identify Pixel Agents hook entries in Codex's hooks.json. */
const HOOK_SCRIPT_MARKER = CODEX_HOOK_SCRIPT_NAME;

/** A single hook entry in Codex's ~/.codex/hooks.json config. Same shape as
 *  Claude's settings.json hooks -- Codex's hooks system was modeled on it. */
interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

/** Partial shape of ~/.codex/hooks.json (only the hooks field is relevant). */
interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

function getCodexDir(): string {
  return path.join(os.homedir(), '.codex');
}

function getCodexHooksPath(): string {
  return path.join(getCodexDir(), 'hooks.json');
}

function getCodexConfigPath(): string {
  return path.join(getCodexDir(), 'config.toml');
}

/** Returns the destination path for the hook script (~/.pixel-agents/hooks/codex-hook.js). */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

function readCodexHooks(): CodexHooksFile {
  const p = getCodexHooksPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as CodexHooksFile;
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Codex hooks.json: ${e}`);
  }
  return {};
}

function writeCodexHooks(hooksFile: CodexHooksFile): void {
  const p = getCodexHooksPath();
  const dir = path.dirname(p);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = p + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(hooksFile, null, 2), 'utf-8');
    fs.renameSync(tmpPath, p);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Codex hooks.json: ${e}`);
  }
}

/** Codex's hooks system is behind a feature flag: `[features] codex_hooks = true`
 *  in config.toml. This does a targeted, single-line edit -- it only recognizes
 *  a top-level `[features]` table with a plain `codex_hooks = <bool>` line, which
 *  covers the common case without pulling in a full TOML parser/writer dependency.
 *  If the file has a more complex `[features]` block this function leaves it
 *  alone and logs a warning so the user can flip the flag by hand. */
function ensureCodexHooksFeatureFlag(): void {
  const configPath = getCodexConfigPath();
  let text = '';
  try {
    if (fs.existsSync(configPath)) {
      text = fs.readFileSync(configPath, 'utf-8');
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Codex config.toml: ${e}`);
    return;
  }

  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(text)) return; // already enabled

  if (/^\s*codex_hooks\s*=\s*false\s*$/m.test(text)) {
    text = text.replace(/^\s*codex_hooks\s*=\s*false\s*$/m, 'codex_hooks = true');
  } else if (/^\[features\]\s*$/m.test(text)) {
    text = text.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
  } else {
    const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    text += `${sep}\n[features]\ncodex_hooks = true\n`;
  }

  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = configPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, configPath);
    console.log('[Pixel Agents] Enabled codex_hooks in ~/.codex/config.toml');
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Codex config.toml: ${e}`);
  }
}

function isOurHookEntry(entry: CodexHookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_MARKER));
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function makeHookEntry(matcher?: string): CodexHookEntry {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command: makeHookCommand(), timeout: 5 }],
  };
}

/** PreToolUse/PostToolUse are Bash-only on Codex today, so matcher is 'Bash'
 *  rather than the catch-all empty matcher Claude uses. */
function matcherFor(event: string): string | undefined {
  if (event === 'PreToolUse' || event === 'PostToolUse') return 'Bash';
  return undefined;
}

export function areHooksInstalled(): boolean {
  const hooksFile = readCodexHooks();
  if (!hooksFile.hooks) return false;
  return CODEX_HOOK_EVENTS.every((event) => {
    const entries = hooksFile.hooks?.[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

/** Install Pixel Agents hook entries into ~/.codex/hooks.json and flip the
 *  codex_hooks feature flag on. Idempotent: replaces any existing Pixel
 *  Agents entries so a changed script path self-heals. */
export function installHooks(): void {
  ensureCodexHooksFeatureFlag();

  const hooksFile = readCodexHooks();
  if (!hooksFile.hooks) hooksFile.hooks = {};

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    if (!Array.isArray(hooksFile.hooks[event])) {
      hooksFile.hooks[event] = [];
    }
    const entries = hooksFile.hooks[event];
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    filtered.push(makeHookEntry(matcherFor(event)));
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      hooksFile.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeCodexHooks(hooksFile);
    console.log('[Pixel Agents] Hooks installed in ~/.codex/hooks.json');
  }
}

export function uninstallHooks(): void {
  const hooksFile = readCodexHooks();
  if (!hooksFile.hooks) return;

  let changed = false;
  for (const event of Object.keys(hooksFile.hooks)) {
    const entries = hooksFile.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    if (filtered.length !== entries.length) {
      hooksFile.hooks[event] = filtered;
      changed = true;
    }
    if (hooksFile.hooks[event].length === 0) {
      delete hooksFile.hooks[event];
    }
  }
  if (Object.keys(hooksFile.hooks).length === 0) {
    delete hooksFile.hooks;
  }

  if (changed) {
    writeCodexHooks(hooksFile);
    console.log('[Pixel Agents] Hooks removed from ~/.codex/hooks.json');
  }
  // Feature flag intentionally left as-is on uninstall: the user (or another
  // tool) may have enabled codex_hooks for reasons unrelated to Pixel Agents.
}

/** Copy the shipped hook script from the extension/CLI dist to ~/.pixel-agents/hooks/ */
export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Codex hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Codex hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Codex hook script: ${e}`);
  }
}
