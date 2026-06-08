import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { CODEX_HOOK_EVENTS, CODEX_HOOK_SCRIPT_NAME } from './constants.js';

const HOOK_SCRIPT_MARKER = CODEX_HOOK_SCRIPT_NAME;

interface CodexHookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function getCodexHooksPath(): string {
  return path.join(getCodexHome(), 'hooks.json');
}

function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

function readCodexHooksFile(): CodexHooksFile {
  const hooksPath = getCodexHooksPath();
  try {
    if (fs.existsSync(hooksPath)) {
      return JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as CodexHooksFile;
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Codex hooks config: ${e}`);
  }
  return {};
}

function writeCodexHooksFile(settings: CodexHooksFile): void {
  const hooksPath = getCodexHooksPath();
  const dir = path.dirname(hooksPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = hooksPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, hooksPath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Codex hooks config: ${e}`);
  }
}

function isOurHookEntry(entry: CodexHookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_MARKER));
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function makeHookEntry(): CodexHookEntry {
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

export function areHooksInstalled(): boolean {
  const settings = readCodexHooksFile();
  if (!settings.hooks) return false;
  return CODEX_HOOK_EVENTS.every((event) => {
    const entries = settings.hooks?.[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

export function installHooks(): void {
  const settings = readCodexHooksFile();
  if (!settings.hooks) {
    settings.hooks = {};
  }

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }
    const entries = settings.hooks[event];
    const filtered = entries.filter((e) => !isOurHookEntry(e));
    filtered.push(makeHookEntry());
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeCodexHooksFile(settings);
    console.log('[Pixel Agents] Hooks installed in ~/.codex/hooks.json');
  }
}

export function uninstallHooks(): void {
  const settings = readCodexHooksFile();
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
    writeCodexHooksFile(settings);
    console.log('[Pixel Agents] Hooks removed from ~/.codex/hooks.json');
  }
}

export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy hook script: ${e}`);
  }
}
