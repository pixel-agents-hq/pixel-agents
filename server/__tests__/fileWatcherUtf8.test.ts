import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { readNewLines } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

describe('transcript UTF-8 reads', () => {
  let dir: string;
  let agent: AgentState;
  let store: AgentStateStore;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    vi.useFakeTimers();
    setHookProvider(claudeProvider);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-utf8-'));
    agent = {
      id: 1,
      sessionId: 'session',
      projectDir: dir,
      jsonlFile: path.join(dir, 'session.jsonl'),
      fileOffset: 0,
      lineBuffer: '',
      isExternal: true,
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
      contextTokens: 0,
      maxContextTokens: 200_000,
    } as AgentState;
    store = new AgentStateStore();
    store.set(agent.id, agent);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    waitingTimers.clear();
    permissionTimers.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(description: string, id = 'task') {
    return Buffer.from(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Task', id, input: { description } }] },
      }) + '\n',
    );
  }

  function read() {
    readNewLines(agent.id, store, waitingTimers, permissionTimers);
  }

  it.each([
    ['整理文档', '整'],
    ['Review 🧠 output', '🧠'],
  ])('preserves %s across partial appends', (description, character) => {
    const data = record(description);
    const split = data.indexOf(Buffer.from(character)) + 1;
    fs.writeFileSync(agent.jsonlFile, data.subarray(0, split));
    read();
    expect(agent.activeToolStatuses.size).toBe(0);
    fs.appendFileSync(agent.jsonlFile, data.subarray(split));
    read();
    expect(agent.activeToolStatuses.get('task')).toBe(`Subtask: ${description}`);
  });

  it('preserves a character split by the 64 KiB read limit', () => {
    const data = record('整理文档');
    const padding = Buffer.alloc(65536 - (data.indexOf(Buffer.from('整')) + 1), ' ');
    fs.writeFileSync(agent.jsonlFile, Buffer.concat([padding, data]));
    read();
    expect(agent.activeToolStatuses.size).toBe(0);
    read();
    expect(agent.activeToolStatuses.get('task')).toBe('Subtask: 整理文档');
  });

  it('discards pending bytes when the transcript offset is reset', () => {
    const data = record('整理文档');
    fs.writeFileSync(agent.jsonlFile, data.subarray(0, data.indexOf(Buffer.from('整')) + 1));
    read();
    fs.writeFileSync(agent.jsonlFile, record('New session', 'new-task'));
    agent.fileOffset = 0;
    agent.lineBuffer = '';
    read();
    expect(agent.activeToolStatuses.get('new-task')).toBe('Subtask: New session');
  });
});
