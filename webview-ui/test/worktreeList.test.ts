/**
 * The Worktrees list's rows: the state each one names and the actions it
 * offers — Claude Code's offer Remove (folder and branch), never Delete.
 */

import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../core/src/messages.js';
import {
  deleteNeedsConfirmation,
  formatSize,
  removeNeedsConfirmation,
  worktreeActions,
  worktreeStateLabel,
} from '../src/worktrees/worktreeList.js';

const wt = (patch: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  name: 'brave-otter',
  branch: 'brave-otter',
  owner: 'pixelAgents',
  state: 'kept',
  sizeBytes: 0,
  uncommittedFiles: 0,
  uniqueCommits: 0,
  ...patch,
});

describe('worktree list', () => {
  it('names each state in the user-facing words', () => {
    expect(worktreeStateLabel(wt({ state: 'active', agentId: 3 }))).toBe('running');
    expect(worktreeStateLabel(wt({ state: 'kept' }))).toBe('kept');
    expect(worktreeStateLabel(wt({ state: 'parked' }))).toBe('parked');
    expect(worktreeStateLabel(wt({ state: 'needsDecision' }))).toBe('needs a decision');
    expect(worktreeStateLabel(wt({ owner: 'cli', state: 'active', agentId: 1 }))).toBe('running');
  });

  it('a running one only goes to its agent', () => {
    expect(worktreeActions(wt({ state: 'active', agentId: 3, latestSessionId: 's' }))).toEqual([
      'open',
    ]);
  });

  it('ours: resume when it has a conversation, remove a folder, delete a parked branch', () => {
    expect(worktreeActions(wt({ state: 'kept', latestSessionId: 's' }))).toEqual([
      'resume',
      'remove',
    ]);
    expect(worktreeActions(wt({ state: 'needsDecision' }))).toEqual(['remove']);
    expect(worktreeActions(wt({ state: 'parked', latestSessionId: 's' }))).toEqual([
      'resume',
      'deleteBranch',
    ]);
    // Active with no agent in the office (left by a crash): nothing to act on but resume.
    expect(worktreeActions(wt({ state: 'active', latestSessionId: 's' }))).toEqual(['resume']);
  });

  it("Claude Code's: Resume and Remove once no agent is in it, never Delete branch", () => {
    expect(worktreeActions(wt({ owner: 'cli', latestSessionId: 's' }))).toEqual([
      'resume',
      'remove',
    ]);
    expect(worktreeActions(wt({ owner: 'cli' }))).toEqual(['remove']);
    expect(worktreeActions(wt({ owner: 'cli', state: 'active', agentId: 1 }))).toEqual(['open']);
    expect(worktreeActions(wt({ owner: 'cli', state: 'parked' }))).toEqual([]);
  });

  it("removing asks first: Claude Code's when it loses files or commits, ours when it holds files", () => {
    expect(removeNeedsConfirmation(wt({ owner: 'cli' }))).toBe(false);
    expect(removeNeedsConfirmation(wt({ owner: 'cli', uncommittedFiles: 1 }))).toBe(true);
    expect(removeNeedsConfirmation(wt({ owner: 'cli', uniqueCommits: 2 }))).toBe(true);
    expect(removeNeedsConfirmation(wt({ uncommittedFiles: 3 }))).toBe(true);
    // Ours, clean: commits are parked on the branch, nothing is lost.
    expect(removeNeedsConfirmation(wt({ uniqueCommits: 2 }))).toBe(false);
  });

  it('deleting a branch with commits of its own is confirmed first', () => {
    expect(deleteNeedsConfirmation(wt({ state: 'parked', uniqueCommits: 2 }))).toBe(true);
    expect(deleteNeedsConfirmation(wt({ state: 'parked', uniqueCommits: 0 }))).toBe(false);
  });

  it('sizes read short', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(12 * 1024)).toBe('12 KB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatSize(230 * 1024 * 1024)).toBe('230 MB');
    expect(formatSize(1024 * 1024 - 1)).toBe('1 MB');
  });
});
