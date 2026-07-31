/**
 * Unit tests for the pure `reconcileExistingAgents` decision (issue #334).
 *
 * A restored agent must become a character regardless of whether the
 * `existingAgents` message arrives before or after `layoutLoaded`:
 *   - layout NOT ready → buffer (flushed later by layoutLoaded)
 *   - layout ready     → add immediately (else the agent is stranded, because no
 *                        further layoutLoaded arrives to flush the buffer)
 *
 * Extracted from useExtensionMessages so it is testable without React, mirroring
 * officeCanvasCursor.test.ts (the deliberate e2e-over-unit policy forbids unit
 * tests against the React message handler itself).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type {
  ExistingAgentMeta,
  ExistingAgentsOffice,
  PendingAgent,
} from '../src/office/engine/existingAgents.js';
import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';

// ── Helpers ────────────────────────────────────────────────────

interface AddAgentCall {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  skipSpawnEffect?: boolean;
  folderName?: string;
}

/** A fake office that records addAgent calls, mirroring how officeCanvasCursor
 *  tests inject closures instead of constructing a real OfficeState. */
function fakeOffice(
  existing: number[] = [],
): ExistingAgentsOffice & { calls: AddAgentCall[]; headless: number[] } {
  const ids = new Set(existing);
  const calls: AddAgentCall[] = [];
  const headless: number[] = [];
  return {
    calls,
    headless,
    characters: { has: (id: number) => ids.has(id) },
    addAgent: (id, palette, hueShift, seatId, skipSpawnEffect, folderName) => {
      ids.add(id);
      calls.push({ id, palette, hueShift, seatId, skipSpawnEffect, folderName });
    },
    setHeadless: (id, isHeadless) => {
      if (isHeadless) headless.push(id);
    },
  };
}

// ── layout ready → add immediately (the #334 regression) ────────

test('layout ready: adds restored agents immediately with their seat metadata', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { palette: 2, hueShift: 90, seatId: 'seat-a' },
  };
  const folderNames: Record<number, string> = { 5: 'alpha' };

  const addedDirectly = reconcileExistingAgents(os, [5], meta, folderNames, true, pending);

  assert.equal(addedDirectly, true);
  assert.equal(pending.length, 0, 'nothing should be buffered once the layout is ready');
  assert.deepEqual(os.calls, [
    // skipSpawnEffect must be true so restored agents don't replay the matrix effect.
    {
      id: 5,
      palette: 2,
      hueShift: 90,
      seatId: 'seat-a',
      skipSpawnEffect: true,
      folderName: 'alpha',
    },
  ]);
});

// ── layout not ready → buffer (preserved original behavior) ─────

test('layout not ready: buffers restored agents for the later layoutLoaded flush', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { palette: 2, hueShift: 90, seatId: 'seat-a' },
  };
  const folderNames: Record<number, string> = { 5: 'alpha' };

  const addedDirectly = reconcileExistingAgents(os, [5], meta, folderNames, false, pending);

  assert.equal(addedDirectly, false);
  assert.equal(os.calls.length, 0, 'no agent should be added before the layout is ready');
  assert.deepEqual(pending, [
    { id: 5, palette: 2, hueShift: 90, seatId: 'seat-a', folderName: 'alpha', isHeadless: false },
  ]);
});

// ── idempotence / dedup ─────────────────────────────────────────

test('layout ready: skips an agent that already exists and reports nothing added', () => {
  const os = fakeOffice([5]); // agent 5 already has a character
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [5], {}, {}, true, pending);

  assert.equal(addedDirectly, false);
  assert.equal(os.calls.length, 0);
  assert.equal(pending.length, 0);
});

test('layout ready: a mixed roster adds only the missing agent', () => {
  const os = fakeOffice([5]);
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [5, 6], {}, {}, true, pending);

  assert.equal(addedDirectly, true);
  assert.deepEqual(
    os.calls.map((c) => c.id),
    [6],
  );
});

// ── headless flag (adopted agents, no terminal to focus) ────────

test('layout ready: marks restored headless agents and leaves the others alone', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  reconcileExistingAgents(os, [5, 6], {}, {}, true, pending, { 5: true });

  assert.deepEqual(os.headless, [5]);
});

test('layout not ready: the headless flag rides along on the buffered agent', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  reconcileExistingAgents(os, [5, 6], {}, {}, false, pending, { 5: true });

  assert.equal(os.headless.length, 0, 'nothing is marked before the layout flush');
  assert.deepEqual(
    pending.map((p) => [p.id, p.isHeadless]),
    [
      [5, true],
      [6, false],
    ],
  );
});

// ── missing metadata is tolerated (undefined seat fields) ───────

test('layout ready: agent with no metadata is still added with undefined fields', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [7], {}, {}, true, pending);

  assert.equal(addedDirectly, true);
  assert.deepEqual(os.calls, [
    {
      id: 7,
      palette: undefined,
      hueShift: undefined,
      seatId: undefined,
      skipSpawnEffect: true,
      folderName: undefined,
    },
  ]);
});
