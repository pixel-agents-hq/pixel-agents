/**
 * Installs/removes the pixel-agents-bridge Hermes plugin under ~/.hermes/plugins/.
 * See constants.ts for why the plugin-hook system (not gateway hooks or shell hooks)
 * is the correct integration point, and why this only affects Hermes sessions
 * started after installation.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  HERMES_CLI_BIN,
  HERMES_PLUGIN_MODULE_FILENAME,
  HERMES_PLUGIN_NAME,
  HERMES_PLUGINS_DIRNAME,
} from './constants.js';

function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function pluginDir(): string {
  return path.join(hermesHome(), HERMES_PLUGINS_DIRNAME, HERMES_PLUGIN_NAME);
}

const PLUGIN_YAML = `name: ${HERMES_PLUGIN_NAME}
version: 1.0.0
description: "Forwards Hermes plugin-hook activity (tool calls, session lifecycle, subagents) to a running Pixel Agents office (POST /api/hooks/hermes). Installed and managed by pixel-office; safe to remove at any time with \`hermes plugins remove ${HERMES_PLUGIN_NAME}\`."
author: "pixel-office"
hooks:
  - on_session_start
  - pre_tool_call
  - post_tool_call
  - on_session_end
  - on_session_finalize
  - subagent_start
  - subagent_stop
`;

function runHermesCli(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    // Best-effort: a missing/broken `hermes` binary must not crash the Pixel Agents
    // server. Worst case the plugin file exists on disk but isn't in the
    // plugins.enabled allow-list yet -- areHooksInstalled() below reports that
    // honestly rather than lying about success.
    execFile(HERMES_CLI_BIN, args, { timeout: 15_000 }, () => resolve());
  });
}

/** Copies the bundled plugin source into ~/.hermes/plugins/. Mirrors
 *  copyHookScript(packageRoot) for Claude: cli.ts passes packageRoot (the npm
 *  package root at runtime, dist/.. ) since the compiled dist/ layout -- not the
 *  TypeScript source tree -- is what actually ships in the npm tarball.
 *  Returns false (and copies nothing) if the bundled source is missing. */
export function copyHermesPlugin(packageRoot: string): boolean {
  const source = path.join(packageRoot, 'dist', 'hooks', 'pixel_agents_bridge_plugin.py');
  if (!fs.existsSync(source)) return false;
  const dir = pluginDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.yaml'), PLUGIN_YAML, 'utf-8');
  fs.copyFileSync(source, path.join(dir, HERMES_PLUGIN_MODULE_FILENAME));
  return true;
}

/** Enables the plugin in ~/.hermes/config.yaml via the documented `hermes plugins
 *  enable` CLI (idempotent -- safe to call even if already enabled). Assumes
 *  copyHermesPlugin() already placed the plugin directory on disk. */
export async function installHermesHooks(): Promise<void> {
  await runHermesCli(['plugins', 'enable', HERMES_PLUGIN_NAME]);
}

export async function uninstallHermesHooks(): Promise<void> {
  await runHermesCli(['plugins', 'disable', HERMES_PLUGIN_NAME]);
  fs.rmSync(pluginDir(), { recursive: true, force: true });
}

export function areHermesHooksInstalled(): boolean {
  return fs.existsSync(path.join(pluginDir(), HERMES_PLUGIN_MODULE_FILENAME));
}
