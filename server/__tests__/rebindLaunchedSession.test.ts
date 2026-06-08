import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import { rebindLaunchedSessionFromHook, setDismissalTracker } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

let tmpBase: string;

describe('rebindLaunchedSessionFromHook', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-rebind-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rebinds a launched agent to the real Codex transcript', () => {
    const projectDir = path.join(tmpBase, 'sessions', '2026', '06', '08');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, 'rollout-abc.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"session_meta"}\n');

    setDismissalTracker(new DismissalTracker());

    const store = new AgentStateStore();
    const knownJsonlFiles = new Set<string>();
    const fileWatchers = new Map<number, fs.FSWatcher>();
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    const agent: AgentState = {
      id: 1,
      sessionId: 'placeholder-uuid',
      terminalRef: undefined,
      isExternal: false,
      projectDir,
      jsonlFile: path.join(projectDir, '__pending__.jsonl'),
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
      hookDelivered: false,
      inputTokens: 0,
      outputTokens: 0,
    };
    store.set(1, agent);

    let reboundSessionId = '';
    let previousSessionId = '';
    const bound = rebindLaunchedSessionFromHook(
      'real-codex-session',
      transcriptPath,
      '/workspace/pixel-agents',
      knownJsonlFiles,
      store,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
      (rebound, prev) => {
        reboundSessionId = rebound.sessionId;
        previousSessionId = prev;
      },
    );

    expect(bound).toBe(true);
    expect(previousSessionId).toBe('placeholder-uuid');
    expect(reboundSessionId).toBe('real-codex-session');
    expect(store.get(1)?.jsonlFile).toBe(transcriptPath);
    expect(store.get(1)?.hookDelivered).toBe(true);
    expect(knownJsonlFiles.has(transcriptPath)).toBe(true);
  });
});
