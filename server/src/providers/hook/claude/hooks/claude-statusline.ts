/**
 * The usage meter's status line command (installed as `statusLine` in
 * ~/.claude/settings.json by the Settings toggle). Claude Code runs it after
 * every assistant message with the session's state on stdin; its `rate_limits`
 * -- the subscription's 5-hour and 7-day usage -- are stated nowhere else
 * before a limit is hit.
 *
 * It prints a short status line (the model, then the usage) for Claude Code to
 * show, and forwards the two usage windows -- percentages and reset times,
 * nothing else of the input -- to every live Pixel Agents server. Every
 * failure is silent and the exit code is always 0: a status line that errors
 * goes blank, and the meter is never worth that.
 */

import * as http from 'http';

import { USAGE_API_PATH, USAGE_POST_TIMEOUT_MS } from '../../../../constants.js';
import type { ServerTarget } from '../../../../serverConfig.js';
import type { SubscriptionUsageWindows } from '../../../../usage/rateLimits.js';
import { parseRateLimits, percentText } from '../../../../usage/rateLimits.js';
import { readLegacyServer, readRegistry } from './serverRegistry.js';

/** "Opus 5.5 | 5h 23% (resets 6:30 PM) | 7d 41%"; the model alone when the
 *  session has no usage to report (an API-key user, before the first reply). */
export function statusLineText(
  data: Record<string, unknown>,
  windows: SubscriptionUsageWindows | undefined,
): string {
  const model = (data.model as { display_name?: unknown } | undefined)?.display_name;
  const parts: string[] = [];
  if (typeof model === 'string' && model) parts.push(model);
  if (windows?.fiveHour) {
    const resets = new Date(windows.fiveHour.resetsAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    parts.push(`5h ${percentText(windows.fiveHour.usedPercentage)} (resets ${resets})`);
  }
  if (windows?.sevenDay) parts.push(`7d ${percentText(windows.sevenDay.usedPercentage)}`);
  return parts.join(' | ');
}

/** The report body: the two windows in the status line's own shape, so the
 *  server validates it with the same parser. */
export function usageReportBody(windows: SubscriptionUsageWindows): string {
  const raw = (w: SubscriptionUsageWindows['fiveHour']) =>
    w ? { used_percentage: w.usedPercentage, resets_at: w.resetsAt } : undefined;
  return JSON.stringify({
    rate_limits: { five_hour: raw(windows.fiveHour), seven_day: raw(windows.sevenDay) },
  });
}

/** Every live server, or the legacy server.json one, or none. */
function liveServers(): ServerTarget[] {
  const registry = readRegistry();
  if (registry.length > 0) return registry;
  try {
    return [readLegacyServer()];
  } catch {
    return [];
  }
}

/** POST the report to one server. Resolves on any outcome, never rejects. */
function postUsage(server: ServerTarget, body: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: USAGE_API_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: USAGE_POST_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('error', () => resolve());
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch {
      resolve();
    }
  });
}

/** Write to stdout and wait for it to flush (the process exits right after). */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return;
  }
  const windows = parseRateLimits(data.rate_limits, Date.now());

  // The line first: Claude Code cancels a status line still running when the
  // next update comes, and the POSTs below are only best-effort.
  await writeStdout(`${statusLineText(data, windows)}\n`);
  if (!windows) return;
  const body = usageReportBody(windows);
  await Promise.all(liveServers().map((server) => postUsage(server, body)));
}

// Run only as the status line command itself (the bundled CJS entry), not
// when a test imports this module.
if (require.main === module) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
