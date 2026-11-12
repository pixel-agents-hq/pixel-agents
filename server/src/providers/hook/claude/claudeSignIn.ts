/**
 * Claude Code's sign-in, as the office drives it (HookProvider.cliSignIn).
 *
 * `claude auth status` prints JSON whose `loggedIn` says whether the CLI holds
 * a login (exit 1 when it holds none, the JSON still printed). `claude auth
 * login` needs no terminal: it prints the page to sign in on, then reads from
 * stdin the code that page ends on, and exits 0 once signed in. Left to itself
 * it also opens a browser on this machine at a second address that returns to
 * a port it listens on, which finishes with no code; that only works where
 * the browser runs here, so it is offered only when the office says it is
 * open on the host (`openBrowser`). Otherwise `BROWSER` names a command that
 * does nothing and the office opens the printed page wherever it is shown.
 *
 * Nothing is kept: the code goes to the CLI's stdin and the CLI stores its
 * own login.
 */

import { type ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';

import type {
  CliSignIn,
  CliSignInAttempt,
  CliSignInState,
} from '../../../../../core/src/provider.js';
import { CLI_SIGN_IN_STATUS_TIMEOUT_MS } from '../../../constants.js';
import { isInheritedClaudeSessionEnv } from './sessionEnv.js';

/** Commands that open nothing, for `BROWSER` (the CLI runs it with the address). */
const NO_BROWSER_COMMANDS = ['/usr/bin/true', '/bin/true'];

/** The page the CLI prints. */
const SIGN_IN_URL_PATTERN = /https:\/\/\S+/;

/** The words a failed login ends on, after the CLI's own label. */
const LOGIN_FAILED_PREFIX = /^Login failed:\s*/i;

const SIGN_IN_ENDED = 'The sign-in ended before it finished.';
const SIGN_IN_NOT_STARTED = "Claude Code couldn't be started. Is it installed?";

/** How the CLI is run: swapped by tests for a stand-in. */
export interface ClaudeCli {
  /** Run to the end and give what it printed, whatever its exit code. */
  output(args: string[]): Promise<string>;
  /** Start it with stdin and stdout piped. */
  start(args: string[], env: NodeJS.ProcessEnv): ChildProcess;
}

/** This process's env without the markers of a session it may run inside. */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isInheritedClaudeSessionEnv(key)) env[key] = value;
  }
  return env;
}

/** npm installs `claude` as a .cmd on Windows, which only a shell can run. The arguments are fixed words. */
const viaShell = process.platform === 'win32';

const realCli: ClaudeCli = {
  output: (args) =>
    new Promise((resolve) => {
      execFile(
        'claude',
        args,
        { env: cliEnv(), timeout: CLI_SIGN_IN_STATUS_TIMEOUT_MS, shell: viaShell },
        (_error, stdout) => resolve(String(stdout)),
      );
    }),
  start: (args, env) =>
    spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: viaShell }),
};

/** The ways of signing in that come with a plan (`authMethod`): a claude.ai login, or a long-lived token of one. */
const PLAN_AUTH_METHODS: ReadonlySet<unknown> = new Set(['claude.ai', 'oauth_token']);

/**
 * What `claude auth status` printed → signed in or not (anything unreadable
 * is "not"), and whether the account has plan limits. Only a login that
 * plainly has none says so: one the CLI names as neither a claude.ai login
 * nor a token of one, and gives no `subscriptionType` for (an API key, a
 * Console account, a cloud provider's). The status line reports limits to
 * subscribers alone, so their usage bars would stay empty for good.
 */
export function signInStateFromStatus(output: string): CliSignInState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { signedIn: false };
  }
  if (typeof parsed !== 'object' || parsed === null) return { signedIn: false };
  const { loggedIn, authMethod, subscriptionType } = parsed as Record<string, unknown>;
  if (loggedIn !== true) return { signedIn: false };
  const noPlan =
    typeof authMethod === 'string' &&
    !PLAN_AUTH_METHODS.has(authMethod) &&
    (typeof subscriptionType !== 'string' || subscriptionType === '');
  return { signedIn: true, ...(noPlan ? { planLimits: false } : {}) };
}

function noBrowserCommand(): string | undefined {
  return NO_BROWSER_COMMANDS.find((file) => fs.existsSync(file));
}

export function createClaudeSignIn(cli: ClaudeCli = realCli): CliSignIn {
  return {
    status: async () => signInStateFromStatus(await cli.output(['auth', 'status', '--json'])),

    begin({ openBrowser, account }): CliSignInAttempt {
      const env = cliEnv();
      if (!openBrowser) {
        const none = noBrowserCommand();
        if (none) env.BROWSER = none;
      }
      const args = ['auth', 'login', account === 'api' ? '--console' : '--claudeai'];

      let child: ChildProcess;
      try {
        child = cli.start(args, env);
      } catch {
        const url = Promise.reject<string>(new Error(SIGN_IN_NOT_STARTED));
        url.catch(() => undefined);
        return {
          url,
          submitCode: () => undefined,
          done: Promise.resolve({ ok: false, reason: SIGN_IN_NOT_STARTED }),
          cancel: () => undefined,
        };
      }

      let printed = '';
      let errors = '';
      let cancelled = false;
      let resolveUrl: (url: string) => void = () => undefined;
      let rejectUrl: (error: Error) => void = () => undefined;
      const url = new Promise<string>((resolve, reject) => {
        resolveUrl = resolve;
        rejectUrl = reject;
      });
      url.catch(() => undefined);

      child.stdout?.on('data', (chunk: Buffer) => {
        printed += chunk.toString();
        // The address is whole once the line it is on has ended.
        const line = printed
          .split('\n')
          .find((l, i, all) => i < all.length - 1 && SIGN_IN_URL_PATTERN.test(l));
        const found = line?.match(SIGN_IN_URL_PATTERN);
        if (found) resolveUrl(found[0]);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      // A CLI that exits while a code is on its way must not take the server down with EPIPE.
      child.stdin?.on('error', () => undefined);

      const done = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
        child.on('error', () => {
          rejectUrl(new Error(SIGN_IN_NOT_STARTED));
          resolve({ ok: false, reason: SIGN_IN_NOT_STARTED });
        });
        child.on('close', (code) => {
          rejectUrl(new Error(SIGN_IN_ENDED));
          if (code === 0) return resolve({ ok: true });
          const said = errors.trim().split('\n').filter(Boolean).pop() ?? '';
          resolve({
            ok: false,
            reason: cancelled || !said ? SIGN_IN_ENDED : said.replace(LOGIN_FAILED_PREFIX, ''),
          });
        });
      });

      return {
        url,
        submitCode: (code) => {
          if (child.stdin?.writable) child.stdin.write(`${code}\n`);
        },
        done,
        cancel: () => {
          cancelled = true;
          child.kill();
        },
      };
    },
  };
}

export const claudeSignIn: CliSignIn = createClaudeSignIn();
