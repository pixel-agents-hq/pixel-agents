/**
 * Claude Code status line bridge (bundled to dist/hooks/claude-statusline.js,
 * installed as the `statusLine` command by statusLineInstaller.ts).
 *
 * Two jobs, and the first one always wins:
 *
 * 1. Run the user's own status line — the command after `--wrap`, decoded —
 *    with the same stdin, environment (COLUMNS/LINES) and working directory,
 *    passing its output and exit code through untouched. With nothing wrapped,
 *    print nothing.
 * 2. Report Claude Code's subscription rate limits, and this session's context
 *    share, to every live Pixel Agents server. ONLY `rate_limits`, the
 *    `session_id` and the context window's `used_percentage` and
 *    `context_window_size` are sent — the rest of the status line input (cwd,
 *    model, cost, transcript path) never leaves this process. With neither
 *    (before the session's first response) there is no POST at all.
 *
 * The report runs alongside the wrapped command and is bounded by a short
 * timeout, so a stopped or slow server never holds up the status bar.
 */

import { spawn } from 'child_process';

import { USAGE_API_PREFIX } from '../../../../constants.js';
import { isRecord } from '../../../../serverConfig.js';
import { STATUSLINE_WRAP_FLAG } from '../constants.js';
import { liveServers, postToServer } from './serverRegistry.js';

/** Per-server POST timeout: well under any status line refresh. */
const USAGE_POST_TIMEOUT_MS = 1000;

const noDebug = (): void => {};

/** The command after `--wrap`, decoded, or undefined when nothing is wrapped. */
function wrappedCommand(argv: readonly string[]): string | undefined {
  const at = argv.indexOf(STATUSLINE_WRAP_FLAG);
  if (at < 0 || at + 1 >= argv.length) return undefined;
  const decoded = Buffer.from(argv[at + 1], 'base64url').toString('utf-8');
  return decoded.trim() === '' ? undefined : decoded;
}

/** What of the status line input is reported: the rate limits and this
 *  session's context share, picked field by field. Null when it has neither. */
function reportOf(input: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const body: Record<string, unknown> = {};
  if (isRecord(data.rate_limits)) body.rate_limits = data.rate_limits;
  const window = data.context_window;
  if (
    typeof data.session_id === 'string' &&
    isRecord(window) &&
    typeof window.used_percentage === 'number'
  ) {
    body.session_id = data.session_id;
    body.context_window = {
      used_percentage: window.used_percentage,
      context_window_size: window.context_window_size,
    };
  }
  return Object.keys(body).length > 0 ? body : null;
}

/** Run the user's status line through the shell, as Claude Code would have,
 *  feeding it our stdin and passing its output straight through. Resolves with
 *  its exit code (1 when it could not be started). */
function runWrapped(command: string, input: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    // Claude Code cancels a status line run that a newer update supersedes:
    // take the user's command down with us rather than leave it running.
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
      process.exit(1);
    };
    process.once('SIGTERM', forward('SIGTERM'));
    process.once('SIGINT', forward('SIGINT'));
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
    // A command that never reads stdin closes it early; that is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** POST the rate limits to every live server; never rejects. */
async function report(payload: Record<string, unknown>): Promise<void> {
  const servers = liveServers(noDebug, 'usage');
  if (!servers) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    servers.map((server) =>
      postToServer(server, {
        path: `${USAGE_API_PREFIX}/claude`,
        body,
        label: 'usage',
        debug: noDebug,
        timeoutMs: USAGE_POST_TIMEOUT_MS,
      }),
    ),
  );
}

async function main(): Promise<number> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  const payload = reportOf(input);
  const reporting = payload ? report(payload).catch(() => {}) : Promise.resolve();
  const command = wrappedCommand(process.argv.slice(2));
  const exitCode = command === undefined ? 0 : await runWrapped(command, input);
  await reporting;
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
