import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import { AgentStateStore } from '../src/agentStateStore.js';
import { completeUtf8Length, readNewLines } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

describe('completeUtf8Length', () => {
  it('keeps a buffer that ends on a character boundary', () => {
    expect(completeUtf8Length(Buffer.from('abc'))).toBe(3);
    expect(completeUtf8Length(Buffer.from('aş'))).toBe(3);
    expect(completeUtf8Length(Buffer.from('a😀'))).toBe(5);
    expect(completeUtf8Length(Buffer.alloc(0))).toBe(0);
  });

  it('stops before a multi-byte character whose last bytes are missing', () => {
    const s = Buffer.from('aş'); // 'ş' = c5 9f
    expect(completeUtf8Length(s.subarray(0, 2))).toBe(1);
    const emoji = Buffer.from('a😀'); // f0 9f 98 80
    expect(completeUtf8Length(emoji.subarray(0, 2))).toBe(1);
    expect(completeUtf8Length(emoji.subarray(0, 3))).toBe(1);
    expect(completeUtf8Length(emoji.subarray(0, 4))).toBe(1);
  });
});

describe('readNewLines across the 64 KB read cap', () => {
  let dir: string;

  beforeEach(() => {
    setHookProvider(claudeProvider);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-utf8-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('decodes a character that straddles the cap intact', () => {
    const file = path.join(dir, 'session.jsonl');
    // A Bash command whose 'ş' starts at byte 65535: the cap cuts it in two.
    const head =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"';
    const pad = 'a'.repeat(65535 - Buffer.byteLength(head));
    const line = `${head}${pad}ş echo"}}]}}\n`;
    fs.writeFileSync(file, line);
    expect(Buffer.from(line).indexOf(Buffer.from('ş'))).toBe(65535);

    const agents = new AgentStateStore();
    agents.set(1, {
      id: 1,
      sessionId: 's',
      isExternal: true,
      projectDir: dir,
      jsonlFile: file,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundSpawns: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: 200_000,
    } as AgentState);
    const waiting = new Map<number, ReturnType<typeof setTimeout>>();
    const permission = new Map<number, ReturnType<typeof setTimeout>>();

    readNewLines(1, agents, waiting, permission);
    // The first read stops right before the cut character, not inside it.
    expect(agents.get(1)!.fileOffset).toBe(65535);
    readNewLines(1, agents, waiting, permission);

    const agent = agents.get(1)!;
    expect(agent.fileOffset).toBe(Buffer.byteLength(line));
    expect(agent.lineBuffer).toBe('');
    expect(agent.activeToolIds.has('t1')).toBe(true);
  });
});
