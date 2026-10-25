import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import {
  OPENCLAW_PLUGIN_DIR,
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_INSTALL_DIR,
} from './constants.js';

const execFileAsync = promisify(execFile);

function installedPluginDir(): string {
  return path.join(os.homedir(), '.pixel-agents', OPENCLAW_PLUGIN_INSTALL_DIR);
}

/** Copy the bundled plugin into Pixel Agents-owned storage before installation. */
export function copyOpenClawPlugin(packageRoot: string): boolean {
  const source = path.join(packageRoot, 'dist', OPENCLAW_PLUGIN_DIR);
  const destination = installedPluginDir();
  const staging = `${destination}.tmp-${process.pid}`;
  try {
    if (!fs.existsSync(path.join(source, 'openclaw.plugin.json'))) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    return true;
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

async function openClawPlugins(): Promise<
  Array<{ id?: unknown; enabled?: unknown; status?: unknown }>
> {
  try {
    const { stdout } = await execFileAsync('openclaw', ['plugins', 'list', '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout) as { plugins?: unknown };
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

export async function areOpenClawHooksInstalled(): Promise<boolean> {
  const plugin = (await openClawPlugins()).find((entry) => entry.id === OPENCLAW_PLUGIN_ID);
  return plugin?.enabled === true && plugin.status === 'loaded';
}

export async function installOpenClawHooks(): Promise<void> {
  const pluginDir = installedPluginDir();
  if (!fs.existsSync(path.join(pluginDir, 'openclaw.plugin.json'))) {
    throw new Error('Pixel Agents OpenClaw plugin is missing from ~/.pixel-agents');
  }
  try {
    await execFileAsync(
      'openclaw',
      ['plugins', 'install', '--link', '--force', '--accept-capabilities', pluginDir],
      { encoding: 'utf8' },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenClaw plugin installation failed: ${detail}`);
  }
  if (!(await areOpenClawHooksInstalled())) {
    throw new Error('OpenClaw plugin installation completed but the plugin is not loaded');
  }
}

export async function uninstallOpenClawHooks(): Promise<void> {
  const installed = (await openClawPlugins()).some((entry) => entry.id === OPENCLAW_PLUGIN_ID);
  if (!installed) return;
  try {
    await execFileAsync('openclaw', ['plugins', 'uninstall', OPENCLAW_PLUGIN_ID, '--force'], {
      encoding: 'utf8',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenClaw plugin uninstall failed: ${detail}`);
  }
}
