import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** git with the test's own identity and none of the GIT_* variables that would
 *  point it at another repo (the suite may run inside a git worktree). */
export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Pixel Agents Test',
      '-c',
      'user.email=test@pixel-agents.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env, encoding: 'utf-8' },
  ).trim();
}

/** Make `dir` (created if missing) a git repo with one commit on `main`. */
export function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'initial');
}

/** Whether `ref` names a commit in the repo at `cwd`. */
export function gitHasRef(cwd: string, ref: string): boolean {
  try {
    git(cwd, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}
