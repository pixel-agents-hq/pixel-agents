/**
 * Real temporary git repos for the tests that need git itself (the worktrees
 * module): under os.tmpdir(), with their own committer identity (never the
 * machine's), and git run with the variables that would point it at another
 * repo removed — the suite may itself run inside a git worktree or hook.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

import { removeTempDir } from '../helpers/removeTempDir.js';

const IDENTITY = [
  '-c',
  'user.name=Pixel Agents Test',
  '-c',
  'user.email=test@pixel-agents.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(out)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete out[key];
  }
  return out;
}

/** Run git in `cwd`; returns its trimmed stdout. Throws on failure. */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    env: env(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Whether git succeeds in `cwd`. */
export function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    gitIn(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

const made: string[] = [];

/** A fresh directory under the temp dir (realpath'd: macOS's /var is /private/var). */
export function tempDir(prefix = 'pxl-git-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A repo with one commit (README.md) on `main`. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# test\n' }): string {
  const dir = tempDir('pxl-repo-');
  gitIn(dir, 'init', '--quiet');
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '--quiet', '-m', 'initial');
  return dir;
}

/** A symlink to `dir` in a fresh temp folder: another spelling of the same
 *  folder (a Directory opened through a link). Removed with the rest. */
export function linkTo(dir: string): string {
  const link = path.join(tempDir('pxl-link-'), path.basename(dir));
  fs.symlinkSync(dir, link, 'dir');
  return link;
}

/** Write a file (making its folders) under `dir`. */
export function writeFile(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Commit everything in `dir` with `message`; returns the new commit. */
export function commitAll(dir: string, message: string): string {
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '--quiet', '-m', message);
  return gitIn(dir, 'rev-parse', 'HEAD');
}

/** Remove every directory this module made. */
export function removeTempRepos(): void {
  for (const dir of made.splice(0)) removeTempDir(dir);
}

/** How long a wait after a git operation may take: git spawns (create, inspect, add +
 *  commit + `worktree remove`) under a loaded test run do not fit vi.waitFor's 1 s. */
export const GIT_WAIT_MS = 10_000;
/** The test timeout of a suite that waits on git (vitest.config's 10 s would cut a wait short). */
export const GIT_TEST_TIMEOUT_MS = 30_000;

/** vi.waitFor with room for the git operations a wait in a worktree suite follows. */
export function waitForGit<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: GIT_WAIT_MS, interval: 50 });
}
