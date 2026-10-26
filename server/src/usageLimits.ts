/**
 * The account's plan usage, for the office's usage bars: the last report each
 * provider's usage bridge sent, kept in ~/.pixel-agents/usage-limits.json so a
 * restarted server still has it (reports only arrive while a CLI session is
 * open). Shared by both surfaces.
 *
 * Usage is the operator's account data, so it goes to privileged clients only:
 * the handshake sends it only to them and httpServer drops these broadcasts on
 * read-only sockets (PRIVILEGED_BROADCAST_TYPES).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type { UsageBridgeStatus, UsageLimits, UsageWindow } from '../../core/src/messages.js';
import type { HookProvider, ReportedUsage } from '../../core/src/provider.js';
import {
  PIXEL_AGENTS_DIR,
  USAGE_LIMITS_FILE_NAME,
  USAGE_UNCHANGED_REFRESH_MS,
} from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { hookProviders } from './providers/index.js';
import { isRecord } from './serverConfig.js';

/** A provider's last report: its windows and when it arrived (epoch ms). */
interface StoredUsage extends ReportedUsage {
  updatedAt: number;
}

/** Wire message types only privileged sockets receive. */
export const PRIVILEGED_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'usageLimits',
  'usageBridgeStatus',
]);

let cache: Record<string, StoredUsage> | null = null;

function usageFilePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, USAGE_LIMITS_FILE_NAME);
}

function isWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value)) return false;
  const { usedPercentage, resetsAt } = value;
  return (
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt)
  );
}

/** Parse the file's content, keeping only well-formed entries. */
function parseStored(raw: unknown): Record<string, StoredUsage> {
  const out: Record<string, StoredUsage> = {};
  if (!isRecord(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const { fiveHour, sevenDay, updatedAt } = entry;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;
    out[id] = {
      updatedAt,
      ...(isWindow(fiveHour) ? { fiveHour } : {}),
      ...(isWindow(sevenDay) ? { sevenDay } : {}),
    };
  }
  return out;
}

function stored(): Record<string, StoredUsage> {
  if (cache) return cache;
  try {
    cache = parseStored(JSON.parse(fs.readFileSync(usageFilePath(), 'utf-8')));
  } catch {
    cache = {}; // absent or unreadable: no usage known yet
  }
  return cache;
}

/**
 * Take one report from a provider's usage bridge. Returns true when the office
 * should hear about it: the numbers moved, or the last word is old enough that
 * "updated N min ago" would mislead. A status line runs on every assistant
 * message, so identical reports in between are dropped, not written.
 *
 * A window missing from the report keeps its last value: Claude Code drops a
 * window once it resets, and the client already shows a window past its reset
 * time as full.
 */
export function recordUsageReport(
  provider: HookProvider,
  raw: unknown,
  now: number = Date.now(),
): boolean {
  const limits = provider.usageBridge?.normalizeReport(raw);
  if (!limits) return false;
  const all = stored();
  const prev = all[provider.id];
  const next: StoredUsage = {
    ...(prev?.fiveHour ? { fiveHour: prev.fiveHour } : {}),
    ...(prev?.sevenDay ? { sevenDay: prev.sevenDay } : {}),
    ...limits,
    updatedAt: now,
  };
  const { updatedAt: _prevAt, ...prevWindows } = prev ?? { updatedAt: 0 };
  const { updatedAt: _nextAt, ...nextWindows } = next;
  const moved = !isDeepStrictEqual(prevWindows, nextWindows);
  if (!moved && prev && now - prev.updatedAt < USAGE_UNCHANGED_REFRESH_MS) return false;
  all[provider.id] = next;
  try {
    writeJsonAtomic(usageFilePath(), all);
  } catch (err) {
    // The office still gets the report; only a restart would lose it.
    console.error('[Pixel Agents] Could not save usage limits:', err);
  }
  return true;
}

/** The `usageLimits` message for a provider (no windows when none is known). */
export function usageLimitsMessage(providerId: string): UsageLimits {
  const entry = stored()[providerId];
  return { type: 'usageLimits', providerId, ...(entry ?? {}) };
}

/** The `usageBridgeStatus` message: install state, plus why a change failed. */
export function usageBridgeStatusMessage(
  provider: HookProvider,
  error?: string,
): UsageBridgeStatus {
  return {
    type: 'usageBridgeStatus',
    providerId: provider.id,
    installed: provider.usageBridge?.isInstalled() ?? false,
    disclosure: provider.usageBridge?.disclosure ?? '',
    ...(error ? { error } : {}),
  };
}

/** What a privileged office is told about usage when it connects: for each
 *  provider with a usage bridge, in registration order, its install state and
 *  then its last known usage. Both surfaces' handshakes send exactly this. */
export function usageSnapshotMessages(): Array<UsageBridgeStatus | UsageLimits> {
  return hookProviders
    .filter((provider) => provider.usageBridge)
    .flatMap((provider) => [usageBridgeStatusMessage(provider), usageLimitsMessage(provider.id)]);
}

/**
 * Carry out the Usage Bars toggle: install (the click IS the consent — the
 * disclosure was on screen) or restore the user's status line. Never rejects;
 * answers with the ACTUAL install state and, on failure, the reason, so the
 * checkbox never shows an intent the file doesn't hold.
 */
export async function applyUsageBridgeChoice(
  provider: HookProvider,
  packageRoot: string | undefined,
  enabled: boolean,
): Promise<UsageBridgeStatus> {
  const bridge = provider.usageBridge;
  if (!bridge) return usageBridgeStatusMessage(provider);
  try {
    if (enabled) {
      if (!packageRoot) throw new Error('This server cannot install the usage bridge.');
      await bridge.install(packageRoot);
    } else {
      await bridge.uninstall();
    }
    return usageBridgeStatusMessage(provider);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Pixel Agents] ${reason}`);
    return usageBridgeStatusMessage(provider, reason);
  }
}

/** Tests only: forget the cached file content. */
export function resetUsageLimitsCacheForTests(): void {
  cache = null;
}
