import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoNameForCwd, repoNameForCwdOnDisk } from '../src/transcriptCwd.js';

/**
 * Helper agents run in git worktrees kept inside the repo. Their labels,
 * tasks and tokens belong to the repo, not to a "repo" named after the
 * worktree (`agent-a02c…`, `phase-g`).
 */
describe('repoNameForCwd', () => {
  it('is the basename of an ordinary directory', () => {
    expect(repoNameForCwd(String.raw`D:\Projects\pixel-agents`)).toBe('pixel-agents');
    expect(repoNameForCwd('/home/me/hobbyfi-blog-automation/')).toBe('hobbyfi-blog-automation');
  });

  it("folds Claude Code's agent worktrees into their repo", () => {
    expect(
      repoNameForCwd(
        String.raw`D:\Projects\hobbyfi-blog-automation\.claude\worktrees\agent-a02c5c5ab`,
      ),
    ).toBe('hobbyfi-blog-automation');
    expect(repoNameForCwd('/repo/x/.claude/worktrees/m-ui-tasks-board/webview-ui')).toBe('x');
  });

  it('folds a .worktrees/<name> checkout, at any depth below, into its repo', () => {
    expect(repoNameForCwd(String.raw`D:\Projects\pixel-agents\.worktrees\phase-g`)).toBe(
      'pixel-agents',
    );
    expect(repoNameForCwd('D:/Projects/pixel-agents/.worktrees/phase-g/server')).toBe(
      'pixel-agents',
    );
  });

  it('leaves a directory that only looks like one alone', () => {
    expect(repoNameForCwd('/srv/worktrees/app')).toBe('app');
    expect(repoNameForCwd('/home/me/.claude')).toBe('.claude');
  });
});

describe('repoNameForCwdOnDisk', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-checkout-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('names a folder inside a checkout after the checkout', () => {
    const repo = path.join(tmp, 'hobbyfi-video-automation');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'assets', 'audio'), { recursive: true });
    expect(repoNameForCwdOnDisk(path.join(repo, 'assets', 'audio'))).toBe(
      'hobbyfi-video-automation',
    );
    expect(repoNameForCwdOnDisk(repo)).toBe('hobbyfi-video-automation');
  });

  it("keeps a worktree's repo, whose own .git is a file", () => {
    const wt = path.join(tmp, 'pixel-agents', '.worktrees', 'phase-g');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere');
    expect(repoNameForCwdOnDisk(path.join(wt))).toBe('pixel-agents');
  });

  it('keeps the basename outside any checkout, or for a folder gone from disk', () => {
    fs.mkdirSync(path.join(tmp, 'scratch'));
    expect(repoNameForCwdOnDisk(path.join(tmp, 'scratch'))).toBe('scratch');
    expect(repoNameForCwdOnDisk(path.join(tmp, 'deleted-long-ago'))).toBe('deleted-long-ago');
  });
});
