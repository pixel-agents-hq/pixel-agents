import { describe, expect, it } from 'vitest';

import type { WorktreeOptions } from '../../core/src/messages.js';
import {
  filterBranches,
  initialLocations,
  newWorktreeNameProblem,
  offeredLocations,
  orderedBranches,
  toggleLocation,
} from '../src/worktrees/newWorktree.js';

const options: WorktreeOptions = {
  type: 'worktreeOptions',
  directoryPath: '/repo',
  name: 'calm-heron',
  prefix: 'feature/',
  branches: [
    { name: 'feature/old', location: 'local' },
    { name: 'main', location: 'origin' },
    { name: 'main', location: 'local', current: true },
    { name: 'release', location: 'origin' },
  ],
  defaultBase: { name: 'main', location: 'origin' },
};

describe('the new-worktree modal', () => {
  it('lists the default first, then the current branch, then the rest in order', () => {
    expect(orderedBranches(options).map((b) => `${b.location}:${b.name}`)).toEqual([
      'origin:main',
      'local:main',
      'local:feature/old',
      'origin:release',
    ]);
  });

  it('filters by every word, origin branches by their origin/ name too', () => {
    expect(filterBranches(options.branches, 'origin rel')).toEqual([
      { name: 'release', location: 'origin' },
    ]);
    expect(filterBranches(options.branches, '  ')).toHaveLength(4);
  });

  it('refuses a bad name and one whose branch (prefix + name) exists locally', () => {
    expect(newWorktreeNameProblem('calm-heron', options)).toBeNull();
    expect(newWorktreeNameProblem('old', options)).toContain('already exists');
    expect(newWorktreeNameProblem('a/b', options)).not.toBeNull();
    expect(newWorktreeNameProblem('', options)).not.toBeNull();
  });

  it("lists local branches to begin with, plus the default branch's own location", () => {
    expect(offeredLocations(options)).toEqual(['local', 'origin']);
    // The default is origin's main: origin is shown too, so it is in view.
    expect(initialLocations(options)).toEqual(['local', 'origin']);
    const localDefault = { ...options, defaultBase: options.branches[2] };
    expect(initialLocations(localDefault)).toEqual(['local']);
    const originOnly = {
      ...options,
      branches: options.branches.filter((b) => b.location === 'origin'),
      defaultBase: undefined,
    };
    expect(initialLocations(originOnly)).toEqual(['origin']);
  });

  it('a chip shows or hides its location, never leaving none', () => {
    expect(toggleLocation(['local'], 'origin')).toEqual(['local', 'origin']);
    expect(toggleLocation(['local', 'origin'], 'local')).toEqual(['origin']);
    expect(toggleLocation(['origin'], 'origin')).toEqual(['origin']);
    expect(filterBranches(options.branches, '', ['origin']).map((b) => b.location)).toEqual([
      'origin',
      'origin',
    ]);
  });
});
