import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ClaudeCli,
  createClaudeSignIn,
  signInStateFromStatus,
} from '../src/providers/hook/claude/claudeSignIn.js';
import { removeTempDir } from './helpers/removeTempDir.js';

// A stand-in for `claude` that speaks the two commands the way the CLI does
// (probed on Claude Code 2.1.322): `auth status` prints JSON and exits 1
// while signed out; `auth login` prints its page, then reads one line and
// exits 0 on the right code, 1 with "Login failed: …" on any other.
const FAKE_CLI = `
const fs = require('fs');
const [, , stateFile, ...args] = process.argv;
const signedIn = () => fs.existsSync(stateFile);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: signedIn(), authMethod: signedIn() ? 'claude.ai' : 'none' }));
  process.exit(signedIn() ? 0 : 1);
}
if (args[0] === 'auth' && args[1] === 'login') {
  fs.writeFileSync(stateFile + '.args', JSON.stringify({ args, browser: process.env.BROWSER ?? null, session: process.env.CLAUDE_CODE_SESSION_ID ?? null }));
  process.stdout.write('Opening browser to sign in…\\n');
  process.stdout.write("If the browser didn't open, visit: https://claude.example/authorize?code=true&state=abc\\n");
  process.stdout.write('Paste code here if prompted > ');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    typed += chunk;
    if (!typed.includes('\\n')) return;
    if (typed.trim() === 'good-code#state') {
      fs.writeFileSync(stateFile, '1');
      process.stdout.write('Login successful.\\n');
      process.exit(0);
    }
    process.stderr.write("Login failed: That code wasn't accepted.\\n");
    process.exit(1);
  });
}
`;

let dir: string;
let stateFile: string;
let cli: ClaudeCli;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-signin-'));
  stateFile = path.join(dir, 'signed-in');
  const script = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(script, FAKE_CLI);
  cli = {
    output: (args) =>
      new Promise((resolve) => {
        execFile(process.execPath, [script, stateFile, ...args], (_e, stdout) =>
          resolve(String(stdout)),
        );
      }),
    start: (args, env) =>
      spawn(process.execPath, [script, stateFile, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  };
});

afterEach(() => {
  removeTempDir(dir);
});

const launchedWith = (): { args: string[]; browser: string | null; session: string | null } =>
  JSON.parse(fs.readFileSync(`${stateFile}.args`, 'utf8'));

describe('signInStateFromStatus', () => {
  it('reads loggedIn off the JSON and nothing else', () => {
    expect(signInStateFromStatus('{"loggedIn":true,"authMethod":"claude.ai"}').signedIn).toBe(true);
    expect(signInStateFromStatus('{"loggedIn":false,"authMethod":"none"}').signedIn).toBe(false);
    expect(signInStateFromStatus('{"loggedIn":"true"}').signedIn).toBe(false);
    expect(signInStateFromStatus('Not logged in.').signedIn).toBe(false);
    expect(signInStateFromStatus('').signedIn).toBe(false);
    expect(signInStateFromStatus('null').signedIn).toBe(false);
  });

  it('says an account has no plan limits only when the CLI plainly names one without a plan', () => {
    const state = (o: object) => signInStateFromStatus(JSON.stringify(o));
    // A subscription, however it was signed in.
    expect(state({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })).toEqual({
      signedIn: true,
    });
    expect(state({ loggedIn: true, authMethod: 'oauth_token' })).toEqual({ signedIn: true });
    // An API account: another method, and no subscription named.
    expect(state({ loggedIn: true, authMethod: 'api_key' })).toEqual({
      signedIn: true,
      planLimits: false,
    });
    expect(state({ loggedIn: true, authMethod: 'console', subscriptionType: '' })).toEqual({
      signedIn: true,
      planLimits: false,
    });
    // A method this code has never heard of that still names a subscription keeps its bars.
    expect(state({ loggedIn: true, authMethod: 'sso', subscriptionType: 'team' })).toEqual({
      signedIn: true,
    });
    // No method named: nothing to go on.
    expect(state({ loggedIn: true })).toEqual({ signedIn: true });
  });
});

describe('Claude sign-in', () => {
  it('reports signed out although the CLI exits 1 to say so', async () => {
    expect(await createClaudeSignIn(cli).status()).toEqual({ signedIn: false });
  });

  it('signs in with the code the page ended on', async () => {
    const signIn = createClaudeSignIn(cli);
    const attempt = signIn.begin({ openBrowser: false, account: 'subscription' });
    expect(await attempt.url).toBe('https://claude.example/authorize?code=true&state=abc');
    attempt.submitCode('good-code#state');
    expect(await attempt.done).toEqual({ ok: true });
    expect((await signIn.status()).signedIn).toBe(true);
    expect(launchedWith().args).toEqual(['auth', 'login', '--claudeai']);
  });

  it('gives the reason the CLI gave for a refused code, without its label', async () => {
    const attempt = createClaudeSignIn(cli).begin({ openBrowser: false, account: 'subscription' });
    await attempt.url;
    attempt.submitCode('wrong');
    expect(await attempt.done).toEqual({ ok: false, reason: "That code wasn't accepted." });
  });

  it('keeps the CLI from opening a browser here unless the office is on the host', async () => {
    const signIn = createClaudeSignIn(cli);
    const prior = process.env.BROWSER;
    process.env.BROWSER = 'the-users-browser';
    try {
      const away = signIn.begin({ openBrowser: false, account: 'subscription' });
      await away.url;
      const awayBrowser = launchedWith().browser;
      away.cancel();
      await away.done;
      if (process.platform !== 'win32') expect(awayBrowser).toMatch(/\/true$/);

      const here = signIn.begin({ openBrowser: true, account: 'subscription' });
      await here.url;
      expect(launchedWith().browser).toBe('the-users-browser');
      here.cancel();
      await here.done;
    } finally {
      if (prior === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = prior;
    }
  });

  it('asks for the API account with --console', async () => {
    const attempt = createClaudeSignIn(cli).begin({ openBrowser: false, account: 'api' });
    await attempt.url;
    expect(launchedWith().args).toEqual(['auth', 'login', '--console']);
    attempt.cancel();
    await attempt.done;
  });

  it('does not hand the CLI the session this server may run inside', async () => {
    const prior = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'outer-session';
    try {
      const attempt = createClaudeSignIn(cli).begin({
        openBrowser: false,
        account: 'subscription',
      });
      await attempt.url;
      expect(launchedWith().session).toBeNull();
      attempt.cancel();
      await attempt.done;
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prior;
    }
  });

  it('ends as not signed in when cancelled', async () => {
    const signIn = createClaudeSignIn(cli);
    const attempt = signIn.begin({ openBrowser: false, account: 'subscription' });
    await attempt.url;
    attempt.cancel();
    expect((await attempt.done).ok).toBe(false);
    expect((await signIn.status()).signedIn).toBe(false);
  });

  it('says so when the CLI cannot be started', async () => {
    const missing: ClaudeCli = {
      output: async () => '',
      start: (args, env) =>
        spawn(path.join(dir, 'no-such-claude'), args, { env, stdio: ['pipe', 'pipe', 'pipe'] }),
    };
    const signIn = createClaudeSignIn(missing);
    expect((await signIn.status()).signedIn).toBe(false);
    const attempt = signIn.begin({ openBrowser: false, account: 'subscription' });
    await expect(attempt.url).rejects.toThrow();
    const outcome = await attempt.done;
    expect(outcome.ok).toBe(false);
  });
});
