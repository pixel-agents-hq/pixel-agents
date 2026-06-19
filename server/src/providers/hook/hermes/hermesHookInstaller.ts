import * as fs from 'fs';
import yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { HERMES_HOOK_EVENTS, HERMES_HOOK_SCRIPT_NAME } from './constants.js';

function getHermesConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, HERMES_HOOK_SCRIPT_NAME);
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function isOurEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const cmd = (entry as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.includes(HERMES_HOOK_SCRIPT_NAME);
}

function readConfig(): Record<string, unknown> {
  const p = getHermesConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>) ?? {};
  } catch {
    throw new Error(
      `[Pixel Agents] ~/.hermes/config.yaml is malformed — fix it before installing hooks`,
    );
  }
}

function writeConfig(cfg: Record<string, unknown>): void {
  const p = getHermesConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.pixel-agents-tmp';
  fs.writeFileSync(tmp, yaml.dump(cfg), 'utf-8');
  fs.renameSync(tmp, p);
}

export async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  const cfg = readConfig();
  const hooks =
    cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks)
      ? (cfg.hooks as Record<string, unknown[]>)
      : {};

  const command = makeHookCommand();

  for (const event of HERMES_HOOK_EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const withoutOurs = entries.filter((e) => !isOurEntry(e));
    hooks[event] = [...withoutOurs, { command, timeout: 10 }];
  }

  writeConfig({ ...cfg, hooks });
  console.log('[Pixel Agents] Hermes hooks installed in ~/.hermes/config.yaml');
}

export async function uninstallHooks(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) return;

  const hooks = cfg.hooks as Record<string, unknown[]>;
  let changed = false;

  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurEntry(e));
    if (filtered.length !== entries.length) {
      hooks[event] = filtered;
      changed = true;
    }
    if (hooks[event].length === 0) delete hooks[event];
  }

  if (changed) {
    writeConfig({ ...cfg, hooks });
    console.log('[Pixel Agents] Hermes hooks removed from ~/.hermes/config.yaml');
  }
}

export async function areHooksInstalled(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) return false;
  const hooks = cfg.hooks as Record<string, unknown[]>;
  return HERMES_HOOK_EVENTS.some(
    (event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isOurEntry),
  );
}

export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', HERMES_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);
  try {
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hermes hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Hermes hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Hermes hook script: ${e}`);
  }
}
