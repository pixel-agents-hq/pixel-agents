import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAgentDiagnostics } from '../src/agentDiagnostics.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    ...overrides,
  } as AgentState;
}

describe('buildAgentDiagnostics', () => {
  let tmpDir: string;
  let realJsonl: string;
  const FILE_CONTENTS = '{"type":"x"}\n{"type":"y"}\n';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-diag-'));
    realJsonl = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(realJsonl, FILE_CONTENTS);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits the exact 9-field shape for an agent with an existing jsonl file', () => {
    const store = new AgentStateStore();
    store.set(
      7,
      createTestAgent({
        id: 7,
        projectDir: tmpDir,
        jsonlFile: realJsonl,
        fileOffset: 42,
        lastDataAt: 1_700_000_000_000,
        linesProcessed: 2,
      }),
    );

    const [entry] = buildAgentDiagnostics(store);

    expect(Object.keys(entry).sort()).toEqual(
      [
        'fileOffset',
        'fileSize',
        'id',
        'jsonlExists',
        'jsonlFile',
        'lastDataAt',
        'linesProcessed',
        'projectDir',
        'projectDirExists',
      ].sort(),
    );
    expect(entry.id).toBe(7);
    // jsonlExists + fileSize are coupled (one statSync); fileSize is the real byte length.
    expect(entry.jsonlExists).toBe(true);
    expect(entry.fileSize).toBe(Buffer.byteLength(FILE_CONTENTS));
    expect(entry.projectDirExists).toBe(true);
    expect(entry.jsonlFile).toBe(realJsonl);
    expect(entry.fileOffset).toBe(42);
    expect(entry.lastDataAt).toBe(1_700_000_000_000);
    expect(entry.linesProcessed).toBe(2);
  });

  it('reports jsonlExists=false and fileSize=0 when the file is missing, and preserves lastDataAt=0', () => {
    const store = new AgentStateStore();
    const missing = path.join(tmpDir, 'does-not-exist.jsonl');
    store.set(
      3,
      createTestAgent({
        id: 3,
        projectDir: path.join(tmpDir, 'no-such-dir'),
        jsonlFile: missing,
        lastDataAt: 0,
      }),
    );

    const [entry] = buildAgentDiagnostics(store);

    expect(entry.jsonlExists).toBe(false);
    expect(entry.fileSize).toBe(0);
    expect(entry.projectDirExists).toBe(false);
    // 0 is a meaningful "never" sentinel — must NOT be coerced.
    expect(entry.lastDataAt).toBe(0);
  });

  it('returns one entry per agent in the store', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, jsonlFile: realJsonl }));
    store.set(2, createTestAgent({ id: 2, jsonlFile: realJsonl }));

    const entries = buildAgentDiagnostics(store);

    expect(entries.map((e) => e.id).sort()).toEqual([1, 2]);
  });
});
