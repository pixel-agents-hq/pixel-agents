import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  EXTERNAL_IDLE_EVICT_BUSY_MS,
  EXTERNAL_IDLE_EVICT_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
} from '../src/constants.js';
import { setAgentRemovalCallback, startStaleExternalAgentCheck } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

function agentFor(id: number, jsonlFile: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `s${id}`,
    isExternal: true,
    projectDir: path.dirname(jsonlFile),
    jsonlFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

describe('startStaleExternalAgentCheck: idle eviction', () => {
  let dir: string;
  let agents: AgentStateStore;
  let known: Set<string>;
  let removed: number[];
  let timer: ReturnType<typeof setInterval>;

  /** Write a transcript whose mtime is `ageMs` in the past. */
  function transcript(name: string, ageMs: number): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '{}\n');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    known.add(file);
    return file;
  }

  beforeEach(() => {
    // Fake only the interval: mtimes are real, so Date.now must stay real too.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-stale-'));
    agents = new AgentStateStore();
    known = new Set();
    removed = [];
    setAgentRemovalCallback((id) => {
      removed.push(id);
      agents.delete(id);
    });
  });

  afterEach(() => {
    clearInterval(timer);
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('evicts a quiet session even though hooks are on, and frees it for re-adoption', () => {
    const quiet = transcript('quiet.jsonl', EXTERNAL_IDLE_EVICT_MS + 60_000);
    agents.set(1, agentFor(1, quiet));
    timer = startStaleExternalAgentCheck(agents, known);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(removed).toEqual([1]);
    expect(known.has(quiet)).toBe(false);
  });

  it('keeps a session that wrote recently', () => {
    agents.set(1, agentFor(1, transcript('live.jsonl', 30_000)));
    timer = startStaleExternalAgentCheck(agents, known);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(removed).toEqual([]);
  });

  it('gives an open tool call the longer grace, then evicts it', () => {
    const building = transcript('build.jsonl', EXTERNAL_IDLE_EVICT_MS + 60_000);
    const stuck = transcript('stuck.jsonl', EXTERNAL_IDLE_EVICT_BUSY_MS + 60_000);
    agents.set(1, agentFor(1, building, { activeToolIds: new Set(['toolu_1']) }));
    agents.set(2, agentFor(2, stuck, { activeToolIds: new Set(['toolu_2']) }));
    timer = startStaleExternalAgentCheck(agents, known);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(removed).toEqual([2]);
  });

  it('gives a pending permission prompt the longer grace', () => {
    const file = transcript('ask.jsonl', EXTERNAL_IDLE_EVICT_MS + 60_000);
    agents.set(1, agentFor(1, file, { permissionSent: true }));
    timer = startStaleExternalAgentCheck(agents, known);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(removed).toEqual([]);
  });

  it('never touches a terminal-owned agent', () => {
    const file = transcript('own.jsonl', EXTERNAL_IDLE_EVICT_BUSY_MS + 60_000);
    agents.set(1, agentFor(1, file, { isExternal: false }));
    timer = startStaleExternalAgentCheck(agents, known);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(removed).toEqual([]);
  });
});
