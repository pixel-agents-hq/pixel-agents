import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveUserDirectory } from '../src/directories.js';
import { createStandaloneDirectoryNameResolver, repoRootFor } from '../src/repoDirectoryName.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Standalone labels an external agent by the git repository its cwd is in, with
 * linked worktrees resolving to their main checkout. The layouts below are the
 * ones git itself writes: a `.git` directory in a main checkout, and in a linked
 * worktree a `.git` file whose `gitdir:` points at `<main>/.git/worktrees/<name>`,
 * which holds a `commondir` file leading back to `<main>/.git`.
 */
describe('repoDirectoryName', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let root: string;

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-repo-name-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    root = path.join(tempHome, 'code');
    fs.mkdirSync(root);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** A main checkout at `<root>/<name>` with a `.git` directory. */
  function mainCheckout(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  }

  /** A linked worktree of `main` at `where`, laid out the way `git worktree add` does. */
  function linkedWorktree(main: string, where: string, gitdirLine?: string): string {
    const name = path.basename(where);
    const gitDir = path.join(main, '.git', 'worktrees', name);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, '.git'), `${gitdirLine ?? `gitdir: ${gitDir}`}\n`);
    return where;
  }

  describe('repoRootFor', () => {
    it('finds the main checkout from its root and from a subfolder', () => {
      const app = mainCheckout('my-app');
      fs.mkdirSync(path.join(app, 'server', 'src'), { recursive: true });
      expect(repoRootFor(app)).toBe(app);
      expect(repoRootFor(path.join(app, 'server', 'src'))).toBe(app);
    });

    it('resolves a linked worktree to its main checkout', () => {
      const app = mainCheckout('my-app');
      const wt = linkedWorktree(app, path.join(root, 'worktrees', 'fix-login-redirect'));
      expect(repoRootFor(wt)).toBe(app);
    });

    it('resolves a worktree nested inside the main checkout to that checkout', () => {
      const app = mainCheckout('my-app');
      const wt = linkedWorktree(app, path.join(app, '.claude', 'worktrees', 'busy-fox-2bc2ed'));
      expect(repoRootFor(path.join(wt, 'src'))).toBe(app);
    });

    it('follows a relative gitdir', () => {
      const app = mainCheckout('my-app');
      const where = path.join(root, 'wt-relative');
      const rel = path.relative(where, path.join(app, '.git', 'worktrees', 'wt-relative'));
      linkedWorktree(app, where, `gitdir: ${rel}`);
      expect(repoRootFor(where)).toBe(app);
    });

    it('treats a .git file without commondir (a submodule) as its own repo', () => {
      const parent = mainCheckout('parent');
      const modGitDir = path.join(parent, '.git', 'modules', 'lib');
      fs.mkdirSync(modGitDir, { recursive: true });
      const sub = path.join(parent, 'lib');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${modGitDir}\n`);
      expect(repoRootFor(sub)).toBe(sub);
    });

    it('returns undefined outside any repository', () => {
      const plain = path.join(root, 'notes');
      fs.mkdirSync(plain);
      expect(repoRootFor(plain)).toBeUndefined();
    });

    it.skipIf(!hasGit())('agrees with a worktree made by real git', () => {
      const app = path.join(root, 'real-app');
      fs.mkdirSync(app);
      const git = (...args: string[]): void => {
        execFileSync('git', ['-C', app, ...args], { stdio: 'ignore' });
      };
      git('init', '-q');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      );
      const wt = path.join(root, 'real-app-wt');
      git('worktree', 'add', '-q', wt);
      expect(path.normalize(repoRootFor(wt) ?? '').toLowerCase()).toBe(
        path.normalize(app).toLowerCase(),
      );
    });
  });

  describe('createStandaloneDirectoryNameResolver', () => {
    it('labels every worktree of a repo with the repo name', () => {
      const app = mainCheckout('vps-app-template');
      const a = linkedWorktree(
        app,
        path.join(app, '.claude', 'worktrees', 'workflow-dry-run-d4f84f'),
      );
      const b = linkedWorktree(app, path.join(root, 'elsewhere', 'feature-x'));
      const resolve = createStandaloneDirectoryNameResolver(() => []);
      expect(resolve({ cwd: app })).toBe('vps-app-template');
      expect(resolve({ cwd: a })).toBe('vps-app-template');
      expect(resolve({ cwd: b })).toBe('vps-app-template');
    });

    it('uses the name of a user Directory at the repo root, so its Area mapping matches', () => {
      const app = mainCheckout('vps-app-template');
      const wt = linkedWorktree(app, path.join(app, '.claude', 'worktrees', 'feature-x'));
      expect(saveUserDirectory({ name: 'VPS App', path: app }).ok).toBe(true);
      const resolve = createStandaloneDirectoryNameResolver(() => []);
      expect(resolve({ cwd: wt })).toBe('VPS App');
    });

    it('uses the name of a host Directory at the repo root', () => {
      const app = mainCheckout('my-app');
      const wt = linkedWorktree(app, path.join(root, 'wt'));
      const resolve = createStandaloneDirectoryNameResolver(() => [
        { name: 'Host App', path: app },
      ]);
      expect(resolve({ cwd: wt })).toBe('Host App');
    });

    it('leaves the label to the existing fallback outside a repo or without a cwd', () => {
      const plain = path.join(root, 'notes');
      fs.mkdirSync(plain);
      const resolve = createStandaloneDirectoryNameResolver(() => []);
      expect(resolve({ cwd: plain })).toBeUndefined();
      expect(
        resolve({ projectDir: path.join(tempHome, '.claude', 'projects', '-x') }),
      ).toBeUndefined();
      expect(resolve({})).toBeUndefined();
    });
  });
});
