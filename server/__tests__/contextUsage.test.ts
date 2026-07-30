import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { CONTEXT_SEED_TAIL_BYTES, DEFAULT_MAX_CONTEXT_TOKENS } from '../src/constants.js';
import {
  extractContextTokens,
  seedContextUsage,
  updateContextUsage,
  widenContextWindow,
} from '../src/contextUsage.js';
import { claudeProvider, contextWindowForModel } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session',
    terminalRef: undefined,
    isExternal: true,
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
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ...overrides,
  } as AgentState;
}

/** Assistant record shaped like Claude's: caching makes input_tokens tiny. */
function assistantRecord(
  opts: {
    input?: number;
    cacheCreation?: number;
    cacheRead?: number;
    output?: number;
    isSidechain?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: opts.input ?? 2,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  };
}

describe('extractContextTokens', () => {
  it('counts cached prompt tokens, which dominate a real turn', () => {
    expect(
      extractContextTokens(
        assistantRecord({ input: 2, cacheCreation: 501, cacheRead: 443_937, output: 240 }),
      ),
    ).toBe(444_680);
  });

  it('reports nothing for records without usage', () => {
    expect(extractContextTokens({ type: 'user', message: { content: 'hi' } })).toBe(0);
    expect(extractContextTokens({ type: 'progress' })).toBe(0);
    expect(extractContextTokens(null)).toBe(0);
    expect(extractContextTokens('not a record')).toBe(0);
  });

  it('reports nothing for synthetic records, whose usage is all zeros', () => {
    expect(
      extractContextTokens({
        type: 'assistant',
        message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ).toBe(0);
  });
});

describe('claudeProvider.contextWindowForModel', () => {
  it('gives the current models their large window', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8']) {
      expect(contextWindowForModel(model)).toBe(1_000_000);
    }
  });

  it('gives Haiku and the older line the small window', () => {
    for (const model of [
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-opus-4-1-20250805',
    ]) {
      expect(contextWindowForModel(model)).toBe(200_000);
    }
  });

  it('answers nothing for models it cannot place, rather than guessing', () => {
    expect(contextWindowForModel(undefined)).toBeUndefined();
    expect(contextWindowForModel('<synthetic>')).toBeUndefined();
  });
});

describe('widenContextWindow', () => {
  it('never reports a window below the default', () => {
    expect(widenContextWindow(1_000, 0)).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('jumps to the next known tier once a context outgrows the default', () => {
    expect(widenContextWindow(444_680, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(1_000_000);
  });

  it('never shrinks, so compaction does not make the gauge lurch', () => {
    expect(widenContextWindow(20_476, 1_000_000)).toBe(1_000_000);
  });

  it('rounds up past the largest known tier instead of pinning at 100%', () => {
    expect(widenContextWindow(1_400_000, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(2_000_000);
  });
});

describe('updateContextUsage', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  it('broadcasts the context of the newest turn', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000, output: 300 }));

    expect(messages).toEqual([
      {
        type: 'agentContextUsage',
        id: 1,
        contextTokens: 50_302,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      },
    ]);
  });

  it('snapshots rather than accumulates: the gauge falls after a compaction', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 240_000 }));
    expect(agent.contextTokens).toBe(240_002);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 20_000 }));
    expect(agent.contextTokens).toBe(20_002);
    // The window learned from the pre-compaction turn stays put.
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('leaves the gauge alone for records that report nothing', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }));
    updateContextUsage(1, agent, agents, { type: 'user', message: { content: 'next prompt' } });

    expect(agent.contextTokens).toBe(50_002);
    expect(messages).toHaveLength(1);
  });

  it("ignores a lead's sidechain records -- those turns are its sub-agents'", () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 120_000 }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 8_000, isSidechain: true }));

    expect(agent.contextTokens).toBe(120_002);
    expect(messages).toHaveLength(1);
  });

  it("measures against the provider's window for the model that wrote the turn", () => {
    // Real numbers: a fresh Opus 5 session's first turn. Against the 200k
    // default this reads 17% -- five times what Claude Code itself reports.
    updateContextUsage(
      1,
      agent,
      agents,
      assistantRecord({ input: 2, cacheCreation: 12_753, cacheRead: 20_623, output: 226 }),
      claudeProvider,
    );

    expect(agent.contextTokens).toBe(33_604);
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('follows the window down when the session switches to a smaller model', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }), claudeProvider);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(
      1,
      agent,
      agents,
      {
        ...assistantRecord({ cacheRead: 50_000 }),
        message: { model: 'claude-haiku-4-5-20251001', usage: { cache_read_input_tokens: 50_000 } },
      },
      claudeProvider,
    );
    expect(agent.maxContextTokens).toBe(200_000);
  });

  it('widens past the declared window rather than showing more than 100%', () => {
    updateContextUsage(
      1,
      agent,
      agents,
      {
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { cache_read_input_tokens: 260_000 },
        },
      },
      claudeProvider,
    );

    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('reads sidechain records in a teammate transcript, which has nothing else', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 44_651, isSidechain: true }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 53_695, isSidechain: true }));

    expect(agent.contextTokens).toBe(53_697);
    expect(messages).toHaveLength(2);
  });
});

describe('seedContextUsage', () => {
  let tmpDir: string;
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-context-'));
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(name: string, records: Array<Record<string, unknown>>): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  function seedAgent(jsonlFile: string, overrides: Partial<AgentState> = {}): AgentState {
    const agent = createTestAgent({ jsonlFile, ...overrides });
    agents.set(agent.id, agent);
    seedContextUsage(agent.id, agents);
    return agent;
  }

  it('seeds from the newest turn so a mid-session adoption has a gauge immediately', () => {
    const file = writeTranscript('session.jsonl', [
      assistantRecord({ cacheRead: 10_000 }),
      assistantRecord({ cacheRead: 90_000 }),
      { type: 'user', message: { content: 'a prompt with no usage' } },
    ]);

    const agent = seedAgent(file);

    expect(agent.contextTokens).toBe(90_002);
    expect(messages).toHaveLength(1);
  });

  it('prefers the main chain over a sub-agent turn recorded after it', () => {
    const file = writeTranscript('lead.jsonl', [
      assistantRecord({ cacheRead: 150_000 }),
      assistantRecord({ cacheRead: 5_000, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(150_002);
  });

  it('falls back to sidechain records for a teammate transcript', () => {
    const file = writeTranscript('teammate.jsonl', [
      assistantRecord({ cacheRead: 44_651, isSidechain: true }),
      assistantRecord({ cacheRead: 53_695, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(53_697);
  });

  it('reads only the tail, skipping the record the read landed inside', () => {
    const filler = { type: 'user', message: { content: 'x'.repeat(4_000) } };
    const fillerCount = Math.ceil(CONTEXT_SEED_TAIL_BYTES / 4_000) + 10;
    const file = writeTranscript('long.jsonl', [
      assistantRecord({ cacheRead: 1_000 }),
      ...Array.from({ length: fillerCount }, () => filler),
      assistantRecord({ cacheRead: 77_000 }),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(CONTEXT_SEED_TAIL_BYTES);

    expect(seedAgent(file).contextTokens).toBe(77_002);
  });

  it('stays quiet for a transcript with no turns yet, and for a missing file', () => {
    seedAgent(writeTranscript('fresh.jsonl', [{ type: 'user', message: { content: 'hello' } }]));
    seedAgent(path.join(tmpDir, 'gone.jsonl'), { id: 2 });

    expect(messages).toHaveLength(0);
  });

  it('leaves an agent that already reported its context untouched', () => {
    const file = writeTranscript('known.jsonl', [assistantRecord({ cacheRead: 90_000 })]);

    const agent = seedAgent(file, { contextTokens: 12_345 });

    expect(agent.contextTokens).toBe(12_345);
    expect(messages).toHaveLength(0);
  });
});
