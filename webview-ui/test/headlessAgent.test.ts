/**
 * Unit tests for resolveHeadless — the pure decision behind the "headless"
 * (translucent, no-terminal-to-focus) character render cue.
 *
 * Extracted from useExtensionMessages so it is testable without React,
 * mirroring existingAgents.test.ts / officeCanvasCursor.test.ts (the
 * deliberate e2e-over-unit policy forbids unit tests against the React
 * message handler itself).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { resolveHeadless } from '../src/office/engine/headlessAgent.js';

// ── no explicit override: falls back to the isExternal/runtime heuristic ──

test('IDE client, external agent, no override: heuristic marks it headless', () => {
  assert.equal(resolveHeadless(true, undefined, false), true);
});

test('IDE client, internal agent, no override: heuristic leaves it alone', () => {
  assert.equal(resolveHeadless(false, undefined, false), false);
});

test('browser client, external agent, no override: heuristic is exempt (distinguishes nothing there)', () => {
  assert.equal(resolveHeadless(true, undefined, true), false);
});

test('browser client, internal agent, no override: stays false', () => {
  assert.equal(resolveHeadless(false, undefined, true), false);
});

// ── explicit override: a producer's stated value always wins ──────────────

test('browser client: an explicit true overrides the browser-exempt heuristic', () => {
  assert.equal(resolveHeadless(false, true, true), true);
});

test('IDE client: an explicit false overrides a would-be-headless heuristic', () => {
  assert.equal(resolveHeadless(true, false, false), false);
});

test('explicit override does not need isExternal set at all', () => {
  assert.equal(resolveHeadless(undefined, true, true), true);
});
