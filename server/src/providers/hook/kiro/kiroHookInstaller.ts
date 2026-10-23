import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  KIRO_AGENT_DESCRIPTION,
  KIRO_AGENT_NAME,
  KIRO_AGENT_PROMPT,
  KIRO_HOOK_EVENTS,
  KIRO_HOOK_SCRIPT_NAME,
  KIRO_HOOK_TIMEOUT_SECONDS,
  KIRO_PROFILE_MODE,
  KIRO_PROFILE_TMP_SUFFIX,
} from './constants.js';

interface KiroProfile {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  permissions: { rules: unknown[] };
  hooks: Array<{
    name: string;
    trigger: string;
    action: { type: string; command: string };
    timeout: number;
  }>;
}

function profilePath(): string {
  return path.join(os.homedir(), '.kiro', 'agents', `${KIRO_AGENT_NAME}.json`);
}

function hookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, KIRO_HOOK_SCRIPT_NAME);
}

function quoteCommandPath(value: string): string {
  // Hooks run through a shell. On Windows Kiro uses the native command shell;
  // POSIX shells need literal quoting, including homes containing apostrophes.
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(value)) {
      throw new Error('The Kiro hook path contains unsupported shell characters.');
    }
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function makeKiroProfile(): KiroProfile {
  const command = `${quoteCommandPath(process.execPath)} ${quoteCommandPath(hookScriptPath())}`;
  return {
    name: KIRO_AGENT_NAME,
    description: KIRO_AGENT_DESCRIPTION,
    prompt: KIRO_AGENT_PROMPT,
    tools: ['@builtin'],
    permissions: { rules: [] },
    hooks: KIRO_HOOK_EVENTS.map((event) => ({
      name: `pixel-agents-${event}`,
      trigger: event,
      action: { type: 'command', command: `${command} ${event}` },
      timeout: KIRO_HOOK_TIMEOUT_SECONDS,
    })),
  };
}

/** Dedicated generated profile only: never claim an unrelated or edited file. */
function isOurProfile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const profile = value as KiroProfile;
  const expected = makeKiroProfile();
  if (isDeepStrictEqual(profile, expected)) {
    return true;
  }
  // The executable can move after a Node upgrade. Accept only our script as
  // the second command token; every other profile field must remain ours.
  if (!Array.isArray(profile.hooks) || profile.hooks.length !== expected.hooks.length) {
    return false;
  }
  const hooks = profile.hooks.map((hook, index) => {
    if (
      !hook ||
      typeof hook !== 'object' ||
      !hook.action ||
      typeof hook.action.command !== 'string'
    ) {
      return hook;
    }
    const event = KIRO_HOOK_EVENTS[index];
    const normalized = hook.action.command.replace(/\\/g, '/').toLowerCase();
    const suffix = `/.pixel-agents/hooks/${KIRO_HOOK_SCRIPT_NAME}`;
    // Match the whole command shape, not a comment or wrapper mentioning us.
    const token = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|[^\\s"\']+)';
    const match = new RegExp(`^${token}\\s+(${token})\\s+${event}$`, 'i').exec(normalized);
    const script = match?.[1].replace(/^["']|["']$/g, '');
    if (!script?.endsWith(suffix)) {
      return hook;
    }
    return { ...hook, action: { ...hook.action, command: expected.hooks[index].action.command } };
  });
  return isDeepStrictEqual({ ...profile, hooks }, expected);
}

function readProfile(): { raw: string; value: unknown } | null {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf8');
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Cannot safely read ${profilePath()}; the Kiro profile was left unchanged.`, {
      cause: error,
    });
  }
}

/** Copy before installing entries, so a failed copy never creates broken hooks. */
export function copyKiroHookScript(packageRoot: string): boolean {
  try {
    const source = path.join(packageRoot, 'dist', 'hooks', KIRO_HOOK_SCRIPT_NAME);
    const target = hookScriptPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return true;
  } catch (error) {
    console.error(`[Pixel Agents] Could not copy Kiro hook script: ${String(error)}`);
    return false;
  }
}

export async function installKiroHooks(): Promise<void> {
  if (!fs.existsSync(hookScriptPath())) {
    throw new Error(
      'Kiro hook script is missing. Build the package and copy the script before installing hooks.',
    );
  }
  const existing = readProfile();
  if (existing && !isOurProfile(existing.value)) {
    throw new Error(
      `${profilePath()} already exists and is not an unchanged Pixel Agents profile. It was not overwritten.`,
    );
  }
  const next = JSON.stringify(makeKiroProfile(), null, 2) + '\n';
  if (existing?.raw === next) {
    return;
  }
  const target = profilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!existing) {
    fs.writeFileSync(target, next, { flag: 'wx', mode: KIRO_PROFILE_MODE });
    return;
  }
  const temporary = target + KIRO_PROFILE_TMP_SUFFIX;
  const mode = fs.statSync(target).mode;
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temporary, next, { flag: 'wx', mode });
    temporaryCreated = true;
    if (fs.readFileSync(target, 'utf8') !== existing.raw) {
      throw new Error('The Kiro profile changed during installation. It was not overwritten.');
    }
    fs.renameSync(temporary, target);
  } finally {
    if (temporaryCreated) {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export async function uninstallKiroHooks(): Promise<void> {
  const existing = readProfile();
  if (!existing) {
    return;
  }
  if (!isOurProfile(existing.value)) {
    throw new Error(
      `${profilePath()} was edited or belongs to another application. It was not removed.`,
    );
  }
  if (fs.readFileSync(profilePath(), 'utf8') !== existing.raw) {
    throw new Error('The Kiro profile changed during removal. It was left unchanged.');
  }
  fs.unlinkSync(profilePath());
}

export function areKiroHooksReady(): boolean {
  try {
    const existing = readProfile();
    return !!existing && isOurProfile(existing.value) && fs.existsSync(hookScriptPath());
  } catch {
    return false;
  }
}

export async function areKiroHooksInstalled(): Promise<boolean> {
  return areKiroHooksReady();
}
