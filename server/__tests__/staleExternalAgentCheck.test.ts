import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts imports 'vscode' at module load; stub what it touches at runtime.
vi.mock('vscode', () => ({ window: { activeTerminal: undefined, terminals: [] } }));

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_IDLE_REMOVE_MS, EXTERNAL_STALE_CHECK_INTERVAL_MS } from '../src/constants.js';
import { setAgentRemovalCallback, startStaleExternalAgentCheck } from '../src/fileWatcher.js';

describe('startStaleExternalAgentCheck', () => {
  let tmpDir: string;
  let agents: AgentStateStore;
  let knownJsonlFiles: Set<string>;
  let removed: number[];
  let timer: ReturnType<typeof setInterval>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-stale-'));
    agents = new AgentStateStore();
    knownJsonlFiles = new Set();
    removed = [];
    setAgentRemovalCallback((id) => {
      removed.push(id);
      agents.delete(id);
    });
    timer = startStaleExternalAgentCheck(agents, knownJsonlFiles);
  });

  afterEach(() => {
    clearInterval(timer);
    setAgentRemovalCallback(null);
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addExternalAgent(id: number, idleMs: number, extra: { leadAgentId?: number } = {}) {
    const jsonlFile = path.join(tmpDir, `${id}.jsonl`);
    fs.writeFileSync(jsonlFile, '{}\n');
    const written = new Date(Date.now() - idleMs);
    fs.utimesSync(jsonlFile, written, written);
    knownJsonlFiles.add(jsonlFile);
    agents.set(
      id,
      createAgentState({
        id,
        sessionId: `s${id}`,
        isExternal: true,
        projectDir: tmpDir,
        jsonlFile,
        ...extra,
      }),
    );
    return jsonlFile;
  }

  const runCheck = () => vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);

  it('removes an external agent whose transcript has been idle past the limit', () => {
    const file = addExternalAgent(1, EXTERNAL_IDLE_REMOVE_MS + 60_000);
    runCheck();
    expect(removed).toEqual([1]);
    expect(knownJsonlFiles.has(file)).toBe(false);
  });

  it('keeps an external agent that wrote within the limit', () => {
    addExternalAgent(1, EXTERNAL_IDLE_REMOVE_MS - 60_000);
    runCheck();
    expect(removed).toEqual([]);
  });

  it('removes an external agent whose transcript was deleted', () => {
    const file = addExternalAgent(1, 0);
    fs.rmSync(file);
    runCheck();
    expect(removed).toEqual([1]);
  });

  it('leaves derived children to their lead, however idle', () => {
    addExternalAgent(1, 0);
    addExternalAgent(2, EXTERNAL_IDLE_REMOVE_MS + 60_000, { leadAgentId: 1 });
    runCheck();
    expect(removed).toEqual([]);
  });

  it('takes the children of a removed lead along', () => {
    addExternalAgent(1, EXTERNAL_IDLE_REMOVE_MS + 60_000);
    addExternalAgent(2, 0, { leadAgentId: 1 });
    runCheck();
    expect(removed.sort()).toEqual([1, 2]);
  });

  it('never touches an agent the office launched itself', () => {
    const jsonlFile = path.join(tmpDir, 'own.jsonl');
    fs.writeFileSync(jsonlFile, '{}\n');
    const old = new Date(Date.now() - EXTERNAL_IDLE_REMOVE_MS - 60_000);
    fs.utimesSync(jsonlFile, old, old);
    agents.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's1',
        isExternal: false,
        projectDir: tmpDir,
        jsonlFile,
      }),
    );
    runCheck();
    expect(removed).toEqual([]);
  });

  it('frees the transcript of a removed session so the scan can adopt it again', () => {
    const file = addExternalAgent(1, EXTERNAL_IDLE_REMOVE_MS + 60_000);
    runCheck();
    expect(knownJsonlFiles.has(file)).toBe(false);
  });
});
