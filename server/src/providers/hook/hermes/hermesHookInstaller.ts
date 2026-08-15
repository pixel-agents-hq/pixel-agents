import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';

import { HERMES_HOOK_EVENTS, HERMES_HOOK_TARGET_NAME, HERMES_PROVIDER_ID } from './constants.js';

/**
 * Install/uninstall Pixel Agents' Hermes outbound webhook in Hermes'
 * `config.yaml` (`hooks.outbound` list).
 *
 * Hermes needs no hook script: it natively POSTs lifecycle events to
 * configured outbound webhooks (agent/outbound_webhooks.py), and its wire
 * format already matches the Claude-style payloads this server consumes
 * (hook_event_name, tool_name, tool_input, session_id, cwd). The only thing
 * the installer must do is append one target to `hooks.outbound` in
 * `~/.hermes/config.yaml` (or `$HERMES_CONFIG`).
 *
 * CRITICAL: never edit list-valued config keys with `hermes config set` — it
 * corrupts the loader (known Hermes issue). This installer always rewrites the
 * YAML file directly with js-yaml, atomically via tmp + rename, mirroring the
 * Claude settings.json installer.
 */

/** Hermes config location: $HERMES_CONFIG, else ~/.hermes/config.yaml. */
export function getHermesConfigPath(): string {
  const fromEnv = process.env.HERMES_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

/** Read + parse Hermes config.yaml. Returns {} when missing or malformed. */
export function readHermesConfig(): Record<string, unknown> {
  const configPath = getHermesConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Hermes config: ${e}`);
  }
  return {};
}

/** Write config back to ~/.hermes/config.yaml via atomic tmp + rename. */
export function writeHermesConfig(config: Record<string, unknown>): void {
  const configPath = getHermesConfigPath();
  const dir = path.dirname(configPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = configPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, yaml.dump(config, { noRefs: true }), 'utf-8');
    fs.renameSync(tmpPath, configPath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Hermes config: ${e}`);
  }
}

/** True when the entry belongs to Pixel Agents (marker is the `name` field). */
export function isOurHookEntry(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as Record<string, unknown>).name === HERMES_HOOK_TARGET_NAME
  );
}

/**
 * Build the `hooks.outbound` target entry for the Pixel Agents server.
 *
 * `authToken` is written inline as the signing secret so Hermes signs every
 * delivery with `X-Hermes-Signature-256: sha256=<hex>` (GitHub-style HMAC),
 * which the server's hook route accepts in place of a Bearer token. A
 * `secret_env` pointing at an environment variable is the recommended
 * alternative for non-local deployments, but an inline secret keeps a local
 * 127.0.0.1 Pixel Agents server functional out of the box.
 */
export function makeHookTarget(serverUrl: string, authToken: string): Record<string, unknown> {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    url: `${base}/api/hooks/${HERMES_PROVIDER_ID}`,
    events: [...HERMES_HOOK_EVENTS],
    // Matcher is only honored for pre/post_tool_call; matches every tool.
    matcher: '.*',
    // Signs payloads (X-Hermes-Signature-256). Same value the server
    // validates, so the hook route's Bearer-or-HMAC seam accepts these.
    secret: authToken,
    name: HERMES_HOOK_TARGET_NAME,
  };
}

/** Check if the Pixel Agents Hermes outbound webhook is already installed. */
export function areHooksInstalled(): boolean {
  const config = readHermesConfig();
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const outbound = (hooks as Record<string, unknown>).outbound;
  return Array.isArray(outbound) && outbound.some(isOurHookEntry);
}

/**
 * Append the Pixel Agents target to `hooks.outbound`. Idempotent: replaces any
 * existing Pixel Agents entry with a fresh one (server URL/token may have
 * changed since the last install) and preserves every other outbound target
 * and every unrelated config key.
 */
export function installHooks(serverUrl: string, authToken: string): void {
  const config = readHermesConfig();
  const hooksRaw = config.hooks;
  const hooks =
    hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : {};
  const outbound = Array.isArray(hooks.outbound) ? hooks.outbound : [];
  const filtered = outbound.filter((entry) => !isOurHookEntry(entry));
  filtered.push(makeHookTarget(serverUrl, authToken));
  hooks.outbound = filtered;
  config.hooks = hooks;
  writeHermesConfig(config);
  console.log(`[Pixel Agents] Hermes hooks installed in ${getHermesConfigPath()}`);
}

/** Remove all Pixel Agents entries from hooks.outbound. Cleans up empty keys. */
export function uninstallHooks(): void {
  const config = readHermesConfig();
  const hooksRaw = config.hooks;
  if (!hooksRaw || typeof hooksRaw !== 'object' || Array.isArray(hooksRaw)) return;
  const hooks = hooksRaw as Record<string, unknown>;
  if (!Array.isArray(hooks.outbound)) return;

  const filtered = hooks.outbound.filter((entry) => !isOurHookEntry(entry));
  let changed = filtered.length !== hooks.outbound.length;
  if (changed) {
    if (filtered.length === 0) {
      delete hooks.outbound;
    } else {
      hooks.outbound = filtered;
    }
    if (Object.keys(hooks).length === 0) {
      delete config.hooks;
    }
    writeHermesConfig(config);
  }
  if (changed) {
    console.log(`[Pixel Agents] Hermes hooks removed from ${getHermesConfigPath()}`);
  }
}
