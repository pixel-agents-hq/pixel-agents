import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isMap, isSeq, parseDocument } from 'yaml';

import { HERMES_HOOK_EVENTS, HERMES_MANAGED_BY, HERMES_TARGET_NAME_PREFIX } from './constants.js';

interface ServerRegistryEntry {
  pid: number;
  port: number;
  token: string;
}

interface HermesOutboundTarget {
  url: string;
  events: readonly string[];
  matcher: string;
  timeout: number;
  name: string;
  secret: string;
  managed_by: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getHermesConfigPath(): string {
  const hermesHome = process.env['HERMES_HOME'];
  return path.join(
    typeof hermesHome === 'string' && hermesHome.trim()
      ? hermesHome.trim()
      : path.join(os.homedir(), '.hermes'),
    'config.yaml',
  );
}

function registryDir(): string {
  return path.join(os.homedir(), '.pixel-agents', 'servers');
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function liveRegistryEntries(): ServerRegistryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const entries: ServerRegistryEntry[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(registryDir(), name), 'utf8')) as unknown;
      if (
        isRecord(value) &&
        Number.isInteger(value.pid) &&
        Number.isInteger(value.port) &&
        typeof value.token === 'string' &&
        value.token.length > 0 &&
        processIsRunning(value.pid as number)
      ) {
        entries.push({
          pid: value.pid as number,
          port: value.port as number,
          token: value.token,
        });
      }
    } catch {
      // Another server may be replacing its registry entry. Ignore partial files.
    }
  }
  return entries;
}

function requireLoopback(serverUrl: string): URL {
  const url = new URL(serverUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    hostname !== '[::1]' &&
    hostname !== '::1'
  ) {
    throw new Error('Hermes automatic hook installation is restricted to loopback servers');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hermes hook server URL must use HTTP or HTTPS');
  }
  return url;
}

function makeTarget(serverUrl: string, secret: string): HermesOutboundTarget {
  const url = requireLoopback(serverUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return {
    url: `${url.origin}/api/hooks/hermes`,
    events: HERMES_HOOK_EVENTS,
    matcher: '.*',
    timeout: 2,
    name: `${HERMES_TARGET_NAME_PREFIX}${port}`,
    secret,
    managed_by: HERMES_MANAGED_BY,
  };
}

function desiredTargets(serverUrl: string, authToken: string): HermesOutboundTarget[] {
  const fallback = makeTarget(serverUrl, authToken);
  const byUrl = new Map<string, HermesOutboundTarget>();
  for (const entry of liveRegistryEntries()) {
    const target = makeTarget(`http://127.0.0.1:${entry.port}`, entry.token);
    byUrl.set(target.url, target);
  }
  if (byUrl.size === 0) byUrl.set(fallback.url, fallback);
  return [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
}

export function isPixelAgentsTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.managed_by === HERMES_MANAGED_BY &&
    typeof value.name === 'string' &&
    value.name.startsWith(HERMES_TARGET_NAME_PREFIX)
  );
}

function readSource(filePath: string): { source: string; mode: number; exists: boolean } {
  try {
    const stat = fs.statSync(filePath);
    return { source: fs.readFileSync(filePath, 'utf8'), mode: stat.mode & 0o777, exists: true };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { source: '', mode: 0o600, exists: false };
  }
}

function updateOutboundTargets(targets: readonly HermesOutboundTarget[] | null): void {
  const configPath = getHermesConfigPath();
  const before = readSource(configPath);
  const document = parseDocument(before.source || '{}\n');
  if (document.errors.length > 0) {
    throw new Error(
      `Hermes config is not valid YAML: ${document.errors[0]?.message ?? 'parse error'}`,
    );
  }

  let hooks = document.get('hooks', true);
  if (hooks === undefined) {
    document.set('hooks', document.createNode({}));
    hooks = document.get('hooks', true);
  }
  if (!isMap(hooks)) throw new Error('Hermes config hooks must be a mapping');

  let outbound = hooks.get('outbound', true);
  if (outbound === undefined) {
    hooks.set('outbound', document.createNode([]));
    outbound = hooks.get('outbound', true);
  }
  if (!isSeq(outbound)) throw new Error('Hermes config hooks.outbound must be a list');

  const nodeValue = (item: unknown): unknown =>
    typeof (item as { toJSON?: unknown } | null)?.toJSON === 'function'
      ? (item as { toJSON: () => unknown }).toJSON()
      : item;
  const preserved = outbound.items.filter((item) => !isPixelAgentsTarget(nodeValue(item)));
  const replacement = targets?.map((target) => document.createNode(target)) ?? [];
  const nextItems = [...preserved, ...replacement];
  if (nextItems.length === outbound.items.length) {
    const previous = outbound.items.map((item) => JSON.stringify(nodeValue(item)));
    const next = nextItems.map((item) => JSON.stringify(nodeValue(item)));
    if (previous.every((value, index) => value === next[index])) return;
  }
  outbound.items = nextItems;
  if (outbound.items.length === 0) hooks.delete('outbound');
  if (hooks.items.length === 0) document.delete('hooks');

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (before.exists) {
    const backupPath = `${configPath}.pixel-agents.backup`;
    try {
      fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, Math.min(before.mode, 0o600));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  // Refuse to overwrite a concurrent user edit made while the document was parsed.
  const current = readSource(configPath);
  if (current.source !== before.source || current.exists !== before.exists) {
    throw new Error('Hermes config changed during installation; retry without overwriting it');
  }

  // A unique exclusive file in the destination directory makes the final
  // rename atomic without following or truncating an attacker-controlled
  // deterministic symlink.
  const tempPath = `${configPath}.pixel-agents.${process.pid}.${crypto.randomUUID()}.tmp`;
  const mode = before.exists ? Math.min(before.mode, 0o600) : 0o600;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, document.toString(), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const beforeRename = readSource(configPath);
    if (beforeRename.source !== before.source || beforeRename.exists !== before.exists) {
      throw new Error('Hermes config changed during installation; retry without overwriting it');
    }
    fs.renameSync(tempPath, configPath);
    fs.chmodSync(configPath, mode);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of a file whose ownership is exact and local.
    }
    throw error;
  }
}

export async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  if (!serverUrl || !authToken)
    throw new Error('Hermes hook installation needs a local server and token');
  updateOutboundTargets(desiredTargets(serverUrl, authToken));
}

export async function uninstallHooks(): Promise<void> {
  updateOutboundTargets(null);
}

export async function areHooksInstalled(): Promise<boolean> {
  const configPath = getHermesConfigPath();
  const before = readSource(configPath);
  if (!before.exists) return false;
  const document = parseDocument(before.source);
  if (document.errors.length > 0) return false;
  const value = document.toJS() as unknown;
  if (!isRecord(value) || !isRecord(value.hooks) || !Array.isArray(value.hooks.outbound))
    return false;
  return value.hooks.outbound.some(isPixelAgentsTarget);
}
