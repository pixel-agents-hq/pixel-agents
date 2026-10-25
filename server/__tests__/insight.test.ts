import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { THINKING_PREVIEW_MAX_CHARS } from '../src/constants.js';
import {
  addUsage,
  isEmptyUsage,
  isRealModelId,
  latestThinking,
  spawnInsight,
} from '../src/insight.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

describe('insight helpers', () => {
  it('isRealModelId rejects placeholders and non-strings', () => {
    expect(isRealModelId('claude-opus-5-5')).toBe(true);
    expect(isRealModelId('<synthetic>')).toBe(false);
    expect(isRealModelId('')).toBe(false);
    expect(isRealModelId(undefined)).toBe(false);
    expect(isRealModelId(42)).toBe(false);
  });

  it('latestThinking returns the last non-empty thinking block', () => {
    expect(
      latestThinking([
        { type: 'thinking', thinking: 'first' },
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: '  second  ' },
      ]),
    ).toBe('second');
  });

  it('latestThinking ignores redacted (empty) thinking and falls back to an earlier one', () => {
    expect(latestThinking([{ type: 'thinking', thinking: '', signature: 'EuYB' }])).toBeUndefined();
    expect(
      latestThinking([
        { type: 'thinking', thinking: 'real' },
        { type: 'thinking', thinking: '', signature: 'EuYB' },
      ]),
    ).toBe('real');
  });

  it('latestThinking truncates with an ellipsis', () => {
    const out = latestThinking([{ type: 'thinking', thinking: 'x'.repeat(5000) }])!;
    expect(out).toHaveLength(THINKING_PREVIEW_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('addUsage sums the four counters and treats junk as 0', () => {
    const first = addUsage(undefined, {
      input_tokens: 3,
      output_tokens: 120,
      cache_read_input_tokens: 50000,
      cache_creation_input_tokens: 800,
    });
    expect(first).toEqual({
      inputTokens: 3,
      outputTokens: 120,
      cacheReadTokens: 50000,
      cacheCreationTokens: 800,
    });
    expect(addUsage(first, { input_tokens: 2, output_tokens: 'x' })).toEqual({
      inputTokens: 5,
      outputTokens: 120,
      cacheReadTokens: 50000,
      cacheCreationTokens: 800,
    });
  });

  it('isEmptyUsage is true only when every counter is 0 or missing', () => {
    expect(isEmptyUsage(undefined)).toBe(true);
    expect(isEmptyUsage({ input_tokens: 0, output_tokens: 0 })).toBe(true);
    expect(isEmptyUsage({ output_tokens: 1 })).toBe(false);
  });

  it('spawnInsight keeps only non-empty string fields', () => {
    expect(
      spawnInsight({
        description: 'Buscar usos',
        subagent_type: 'ecc:explorador',
        model: 'haiku',
        effort: 'low',
        prompt: '...',
      }),
    ).toEqual({
      agentType: 'ecc:explorador',
      description: 'Buscar usos',
      model: 'haiku',
      effort: 'low',
    });
    expect(spawnInsight({ model: '', effort: 3, prompt: 'x' })).toEqual({});
    expect(spawnInsight(null)).toEqual({});
  });
});

function testAgent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    sessionId: 'lead-session',
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    isExternal: true,
    ...overrides,
  });
}

const USAGE = {
  input_tokens: 3,
  output_tokens: 120,
  cache_read_input_tokens: 50000,
  cache_creation_input_tokens: 800,
};

function assistantLine(opts: {
  id?: string;
  model?: string;
  content: unknown[];
  usage?: unknown;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    message: {
      ...(opts.id ? { id: opts.id } : {}),
      model: opts.model ?? 'claude-opus-5-5',
      content: opts.content,
      usage: opts.usage ?? USAGE,
    },
  });
}

const SPAWN_INPUT = {
  description: 'Buscar usos',
  subagent_type: 'ecc:explorador',
  model: 'haiku',
  effort: 'low',
  prompt: '...',
};

describe('transcriptParser: cascade insight', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const feed = (line: string) =>
    processTranscriptLine(1, line, agents, waitingTimers, permissionTimers);
  const insights = (type = 'agentInsight') => messages.filter((m) => m.type === type);

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = testAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    for (const t of waitingTimers.values()) clearTimeout(t);
    waitingTimers.clear();
    for (const t of permissionTimers.values()) clearTimeout(t);
    permissionTimers.clear();
  });

  it('broadcasts the model once and not again while it stays the same', () => {
    feed(assistantLine({ id: 'msg_1', content: [{ type: 'text', text: 'a' }] }));
    feed(assistantLine({ id: 'msg_2', content: [{ type: 'text', text: 'b' }] }));
    const withModel = insights().filter((m) => m.model !== undefined);
    expect(withModel).toEqual([{ type: 'agentInsight', id: 1, model: 'claude-opus-5-5' }]);
    expect(agent.insightModel).toBe('claude-opus-5-5');
  });

  it('ignores the <synthetic> placeholder model', () => {
    feed(assistantLine({ model: '<synthetic>', content: [{ type: 'text', text: 'err' }] }));
    expect(insights().some((m) => m.model !== undefined)).toBe(false);
    expect(agent.insightModel).toBeUndefined();
  });

  it('broadcasts thinking, ignoring redacted blocks, and not twice for the same text', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'thinking', thinking: 'Plan: read the file', signature: 'sig' }],
      }),
    );
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'thinking', thinking: 'Plan: read the file', signature: 'sig' }],
      }),
    );
    feed(
      assistantLine({
        id: 'msg_2',
        content: [{ type: 'thinking', thinking: '', signature: 'EuYBCk' }],
      }),
    );
    const thinking = insights().filter((m) => m.thinking !== undefined);
    expect(thinking).toEqual([{ type: 'agentInsight', id: 1, thinking: 'Plan: read the file' }]);
  });

  it('truncates long thinking', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'thinking', thinking: 'y'.repeat(THINKING_PREVIEW_MAX_CHARS + 50) }],
      }),
    );
    const t = insights().find((m) => m.thinking !== undefined)!.thinking as string;
    expect(t).toHaveLength(THINKING_PREVIEW_MAX_CHARS + 1);
  });

  it('counts a response once across records that repeat the same message.id', () => {
    feed(assistantLine({ id: 'msg_1', content: [{ type: 'thinking', thinking: 'hm' }] }));
    feed(assistantLine({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }));
    const spends = insights().filter((m) => m.spend !== undefined);
    expect(spends).toHaveLength(1);
    expect(spends[0].spend).toEqual({
      inputTokens: 3,
      outputTokens: 120,
      cacheReadTokens: 50000,
      cacheCreationTokens: 800,
    });
  });

  it('counts twice for different message ids and accumulates', () => {
    feed(assistantLine({ id: 'msg_1', content: [{ type: 'text', text: 'a' }] }));
    feed(assistantLine({ id: 'msg_2', content: [{ type: 'text', text: 'b' }] }));
    const spends = insights().filter((m) => m.spend !== undefined);
    expect(spends).toHaveLength(2);
    expect(spends[1].spend).toEqual({
      inputTokens: 6,
      outputTokens: 240,
      cacheReadTokens: 100000,
      cacheCreationTokens: 1600,
    });
    expect(agent.lastSpendMessageId).toBe('msg_2');
  });

  it('ignores all-zero usage', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(insights().some((m) => m.spend !== undefined)).toBe(false);
    expect(agent.insightSpend).toBeUndefined();
  });

  it("a lead's sidechain record does not move its insight", () => {
    feed(assistantLine({ id: 'msg_1', content: [{ type: 'text', text: 'a' }] }));
    messages.length = 0;
    feed(
      assistantLine({
        id: 'msg_side',
        model: 'claude-haiku-5-5',
        isSidechain: true,
        content: [{ type: 'thinking', thinking: 'sub thought' }],
      }),
    );
    expect(insights()).toEqual([]);
    expect(agent.insightModel).toBe('claude-opus-5-5');
  });

  it("a teammate's sidechain-only transcript reports its own insight", () => {
    feed(
      assistantLine({
        id: 'msg_1',
        isSidechain: true,
        content: [{ type: 'text', text: 'a' }],
      }),
    );
    expect(insights().some((m) => m.model === 'claude-opus-5-5')).toBe(true);
  });

  it('turns a spawn tool_use input into a subagentInsight', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: SPAWN_INPUT }],
      }),
    );
    expect(insights('subagentInsight')).toEqual([
      {
        type: 'subagentInsight',
        id: 1,
        parentToolId: 'toolu_A',
        agentType: 'ecc:explorador',
        description: 'Buscar usos',
        model: 'haiku',
        effort: 'low',
      },
    ]);
  });

  it('emits spawn insight even when hooks are delivering', () => {
    agent.hookDelivered = true;
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: SPAWN_INPUT }],
      }),
    );
    expect(insights('subagentInsight')).toHaveLength(1);
  });

  it('does not emit spawn insight for non-spawn tools', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_R', name: 'Read', input: { model: 'x' } }],
      }),
    );
    expect(insights('subagentInsight')).toEqual([]);
  });

  const asyncResult = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_A',
            content: [{ type: 'text', text: 'Async agent launched successfully. agentId: a1b2c3' }],
          },
        ],
      },
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'a1b2c3',
        description: 'Buscar usos',
        ...extra,
      },
    });

  it('broadcasts resolvedModel on the async launch path', () => {
    feed(
      assistantLine({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: SPAWN_INPUT }],
      }),
    );
    messages.length = 0;
    feed(asyncResult({ resolvedModel: 'claude-haiku-5-5' }));
    expect(insights('subagentInsight')).toEqual([
      { type: 'subagentInsight', id: 1, parentToolId: 'toolu_A', model: 'claude-haiku-5-5' },
    ]);
  });

  it('broadcasts resolvedModel on normal completion and ignores placeholders', () => {
    const spawn = (id: string) =>
      assistantLine({
        id: `msg_${id}`,
        content: [{ type: 'tool_use', id, name: 'Agent', input: SPAWN_INPUT }],
      });
    const done = (id: string, resolvedModel: string) =>
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
        toolUseResult: { status: 'completed', resolvedModel },
      });
    feed(spawn('toolu_A'));
    feed(spawn('toolu_B'));
    messages.length = 0;
    feed(done('toolu_A', '<synthetic>'));
    expect(insights('subagentInsight')).toEqual([]);
    feed(done('toolu_B', 'claude-haiku-5-5'));
    expect(insights('subagentInsight')).toEqual([
      { type: 'subagentInsight', id: 1, parentToolId: 'toolu_B', model: 'claude-haiku-5-5' },
    ]);
  });
});

describe('SubagentWatch: shadow agentInsight', () => {
  let tmpRoot: string;
  let main: AgentStateStore;
  let watch: SubagentWatch;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-insight-'));
    setHookProvider(claudeProvider);
    main = new AgentStateStore();
    watch = new SubagentWatch(main);
  });

  afterEach(() => {
    watch.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('re-emits a shadow agentInsight as subagentInsight keyed (leadId, spawnToolUseId)', () => {
    const messages: Array<Record<string, unknown>> = [];
    main.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    const jsonl = path.join(tmpRoot, 'agent-x.jsonl');
    fs.writeFileSync(jsonl, '');
    const lead = testAgent({ id: 7 });
    main.set(7, lead);
    watch.watch(lead, 7, { jsonlPath: jsonl, toolUseId: 'toolu_A' });

    const [shadowId] = [...watch.store.keys()];
    watch.store.broadcast({
      type: 'agentInsight',
      id: shadowId,
      model: 'claude-haiku-5-5',
      thinking: 'looking',
      spend: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
    });

    expect(messages.filter((m) => m.type === 'subagentInsight')).toEqual([
      {
        type: 'subagentInsight',
        id: 7,
        parentToolId: 'toolu_A',
        model: 'claude-haiku-5-5',
        thinking: 'looking',
        spend: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
      },
    ]);
  });
});
