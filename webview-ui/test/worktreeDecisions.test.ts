/**
 * The decision dialog's queue: which Worktree with uncommitted changes the
 * office asks about, and that an answered one stops being asked.
 */

import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../core/src/messages.js';
import {
  decisionKey,
  newlyPending,
  nextDecision,
  pendingDecisions,
} from '../src/worktrees/worktreeDecisions.js';

const wt = (name: string, state: WorktreeSummary['state']): WorktreeSummary => ({
  name,
  branch: name,
  owner: 'pixelAgents',
  state,
  sizeBytes: 0,
  uncommittedFiles: state === 'needsDecision' ? 2 : 0,
  uniqueCommits: 0,
});

describe('worktree decisions', () => {
  it('asks only about Worktrees that need a decision, in a stable order', () => {
    const byDirectory = {
      '/b': [wt('zeta', 'needsDecision'), wt('alpha', 'needsDecision')],
      '/a': [
        wt('running', 'active'),
        wt('parked', 'parked'),
        wt('kept', 'kept'),
        wt('m', 'needsDecision'),
      ],
    };
    expect(
      pendingDecisions(byDirectory).map((p) => `${p.directoryPath}:${p.worktree.name}`),
    ).toEqual(['/a:m', '/b:alpha', '/b:zeta']);
  });

  it('skips the ones this office answered or put off', () => {
    const byDirectory = { '/a': [wt('one', 'needsDecision'), wt('two', 'needsDecision')] };
    expect(nextDecision(byDirectory, new Set())?.worktree.name).toBe('one');
    expect(nextDecision(byDirectory, new Set([decisionKey('/a', 'one')]))?.worktree.name).toBe(
      'two',
    );
    expect(
      nextDecision(byDirectory, new Set([decisionKey('/a', 'one'), decisionKey('/a', 'two')])),
    ).toBeNull();
  });

  it('an answer from any office clears the question: the next list no longer has it', () => {
    const before = { '/a': [wt('one', 'needsDecision')] };
    const after = { '/a': [wt('one', 'parked')] };
    expect(nextDecision(before, new Set())).not.toBeNull();
    expect(nextDecision(after, new Set())).toBeNull();
  });

  it('a Worktree that comes to need a decision again is a new question', () => {
    const kept = { '/a': [wt('one', 'kept'), wt('two', 'needsDecision')] };
    const flagged = { '/a': [wt('one', 'needsDecision'), wt('two', 'needsDecision')] };
    // Only the one that changed into needing a decision; one still waiting is not new.
    expect(newlyPending(kept, flagged)).toEqual([decisionKey('/a', 'one')]);
    expect(newlyPending(flagged, flagged)).toEqual([]);
    // A Directory listed for the first time: everything waiting in it is new.
    expect(newlyPending({}, flagged)).toHaveLength(2);
  });
});
