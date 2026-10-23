import { describe, expect, it } from 'vitest';

import {
  WORKER_TITLE_MAX_CHARS,
  workerSummary,
  workerTile,
  workerTiles,
} from '../src/components/workerTiles.js';

const NOW = 1_700_000_000_000;

describe('workerTile', () => {
  it('names the tile by its title, with the repo below', () => {
    const tile = workerTile(
      7,
      { title: 'Nightly dependency audit', directoryName: 'hobbyfi-blog' },
      NOW,
    );
    expect(tile).toMatchObject({
      id: 7,
      name: 'Nightly dependency audit',
      fullName: 'Nightly dependency audit',
      repo: 'hobbyfi-blog',
    });
  });

  it('falls back to the repo as the name, never showing it twice', () => {
    const tile = workerTile(7, { directoryName: 'hobbyfi-blog' }, NOW);
    expect(tile.name).toBe('hobbyfi-blog');
    expect(tile.repo).toBeUndefined();
    expect(workerTile(8, {}, NOW).name).toBe('Agent 8');
  });

  it('shortens a long title, keeping the full one for the tooltip', () => {
    const title = 'Rewrite the whole email sequence for the autumn launch';
    const tile = workerTile(1, { title }, NOW);
    expect(Array.from(tile.name)).toHaveLength(WORKER_TITLE_MAX_CHARS);
    expect(tile.name.endsWith('…')).toBe(true);
    expect(tile.fullName).toBe(title);
  });

  it('shows the running tool as active', () => {
    const tile = workerTile(
      1,
      {
        seenActivity: true,
        tools: [
          { toolId: 'a', status: 'Reading README.md', done: true },
          { toolId: 'b', status: 'Running: npm test', done: false },
        ],
      },
      NOW,
    );
    expect(tile.status).toBe('active');
    expect(tile.activity).toBe('Running: npm test');
  });

  it('a pending approval outranks everything', () => {
    const tile = workerTile(
      1,
      {
        seenActivity: true,
        status: 'waiting',
        tools: [{ toolId: 'a', status: 'Running: rm -rf dist', done: false, permissionWait: true }],
      },
      NOW,
    );
    expect(tile.status).toBe('permission');
    expect(tile.activity).toBe('Needs approval');
  });

  it('a finished turn is waiting: done, or waiting for input', () => {
    expect(workerTile(1, { seenActivity: true, status: 'waiting' }, NOW)).toMatchObject({
      status: 'waiting',
      activity: 'Done',
    });
    expect(
      workerTile(1, { seenActivity: true, status: 'waiting', awaitingInput: true }, NOW).activity,
    ).toBe('Waiting for input');
  });

  it('mid-turn between tools keeps the last tool’s status', () => {
    const tile = workerTile(
      1,
      { seenActivity: true, tools: [{ toolId: 'a', status: 'Editing app.ts', done: true }] },
      NOW,
    );
    expect(tile.status).toBe('active');
    expect(tile.activity).toBe('Editing app.ts');
  });

  it('asleep reads as idle with how long', () => {
    const tile = workerTile(
      1,
      { seenActivity: true, sleep: { idleSince: NOW - 3 * 3_600_000 } },
      NOW,
    );
    expect(tile.status).toBe('idle');
    expect(tile.activity).toBe('💤 idle 3h');
  });

  it('nothing seen yet is idle', () => {
    expect(workerTile(1, {}, NOW)).toMatchObject({ status: 'idle', activity: 'Idle' });
  });
});

describe('workerTiles', () => {
  it('orders tiles oldest agent first, whatever order the ids come in', () => {
    const tiles = workerTiles([9, 3, 5], (id) => ({ title: `Job ${id}` }), NOW);
    expect(tiles.map((t) => t.id)).toEqual([3, 5, 9]);
  });
});

describe('workerSummary', () => {
  it('counts the workers and shows the most urgent status', () => {
    const tiles = [
      workerTile(1, { seenActivity: true, status: 'waiting' }, NOW),
      workerTile(2, { tools: [{ toolId: 'a', status: 'x', done: false }] }, NOW),
      workerTile(3, {}, NOW),
    ];
    expect(workerSummary(tiles)).toEqual({ count: 3, status: 'active' });
    const withApproval = [
      ...tiles,
      workerTile(
        4,
        { tools: [{ toolId: 'b', status: 'y', done: false, permissionWait: true }] },
        NOW,
      ),
    ];
    expect(workerSummary(withApproval).status).toBe('permission');
  });

  it('is idle and zero with no workers', () => {
    expect(workerSummary([])).toEqual({ count: 0, status: 'idle' });
  });
});
