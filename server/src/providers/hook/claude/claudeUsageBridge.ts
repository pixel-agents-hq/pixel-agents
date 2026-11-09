/**
 * Claude's UsageBridge: the status line wrapper (statusLineInstaller.ts) plus
 * the shape of what it reports.
 *
 * Claude Code puts `rate_limits` in the status line input only for claude.ai
 * Pro/Max subscribers, and only after a session's first response:
 *
 *   "rate_limits": {
 *     "five_hour": { "used_percentage": 42, "resets_at": 1738425600 },
 *     "seven_day": { "used_percentage": 18, "resets_at": 1738857600 }
 *   }
 *
 * (https://code.claude.com/docs/en/statusline — "Rate limit usage"). Each
 * window can be absent on its own.
 *
 * The same input carries the session's own context, which the office's gauge
 * copies so it reads what the status line reads:
 *
 *   "session_id": "…",
 *   "context_window": { "used_percentage": 8, "context_window_size": 200000, … }
 *
 * `used_percentage` counts input tokens only (input + cache writes + cache
 * reads, no output) and is null early in a session.
 */

import type { UsageWindow } from '../../../../../core/src/messages.js';
import type {
  ReportedContext,
  ReportedUsage,
  UsageBridge,
} from '../../../../../core/src/provider.js';
import { isRecord } from '../../../serverConfig.js';
import { SETTINGS_BACKUP_SUFFIX } from './constants.js';
import {
  installStatusLineBridge,
  isStatusLineBridgeInstalled,
  refreshStatusLineScript,
  uninstallStatusLineBridge,
} from './statusLineInstaller.js';

/** Shown before the user confirms the install (Settings → Usage Bars). */
export const USAGE_BRIDGE_DISCLOSURE = [
  'To show your remaining weekly and 5-hour usage in the top-left corner, Pixel Agents ' +
    'wraps your status line in ~/.claude/settings.json. It keeps working and looks the same ' +
    '(with no status line, Claude Code hides some footer hints). A one-time backup is saved as ' +
    `settings.json${SETTINGS_BACKUP_SUFFIX}.`,
  "Only your usage percentages and reset times, and each session's context percentage, are sent, " +
    'to the Pixel Agents server on this machine.',
  'You can turn this off at any time from Settings → Usage Bars.',
].join('\n\n');

/** A window as reported, or undefined when absent or malformed. */
function windowOf(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { used_percentage: used, resets_at: resetsAt } = raw;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return undefined;
  }
  return { usedPercentage: Math.min(100, Math.max(0, used)), resetsAt };
}

/** The report's limits, or null when it carries no valid window at all. */
export function normalizeClaudeUsageReport(raw: unknown): ReportedUsage | null {
  if (!isRecord(raw)) return null;
  const limits = raw.rate_limits;
  if (!isRecord(limits)) return null;
  const fiveHour = windowOf(limits.five_hour);
  const sevenDay = windowOf(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** The reporting session's context, or null when it carries none. */
export function normalizeClaudeContextReport(raw: unknown): ReportedContext | null {
  if (!isRecord(raw)) return null;
  const { session_id: sessionId, context_window: window } = raw;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (!isRecord(window)) return null;
  const { used_percentage: used, context_window_size: size } = window;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  return { sessionId, usedPercentage: Math.min(100, Math.max(0, used)), windowTokens: size };
}

export const claudeUsageBridge: UsageBridge = {
  disclosure: USAGE_BRIDGE_DISCLOSURE,
  isInstalled: isStatusLineBridgeInstalled,
  install: installStatusLineBridge,
  uninstall: uninstallStatusLineBridge,
  refreshScript: refreshStatusLineScript,
  normalizeReport: normalizeClaudeUsageReport,
  normalizeContext: normalizeClaudeContextReport,
};
