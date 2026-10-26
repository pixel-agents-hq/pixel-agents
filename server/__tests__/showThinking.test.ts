import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { readConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import {
  applyShowThinking,
  isThinkingShared,
  setThinkingShared,
  shareableInsight,
} from '../src/insight.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const SPEND = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };

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

function thinkingLine(id: string, thinking: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      id,
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking, signature: 'sig' }],
      usage: { input_tokens: 3, output_tokens: 120 },
    },
  });
}

describe('Show Agent Thinking', () => {
  beforeEach(() => setThinkingShared(true));
  afterEach(() => setThinkingShared(true));

  it('is shared by default', () => {
    expect(isThinkingShared()).toBe(true);
  });

  it('shareableInsight drops only thinking, and only while sharing is off', () => {
    const fields = { model: 'm', thinking: 't', spend: SPEND };
    expect(shareableInsight(fields)).toBe(fields);
    setThinkingShared(false);
    expect(shareableInsight(fields)).toEqual({ model: 'm', spend: SPEND });
  });

  describe('transcript parser', () => {
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let agents: AgentStateStore;
    let agent: AgentState;
    let messages: Array<Record<string, unknown>>;

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

    it('neither stores nor broadcasts thinking while off; model and spend still flow', () => {
      setThinkingShared(false);
      processTranscriptLine(
        1,
        thinkingLine('msg_1', 'secret plan'),
        agents,
        waitingTimers,
        permissionTimers,
      );
      expect(agent.insightThinking).toBeUndefined();
      expect(messages.some((m) => m.thinking !== undefined)).toBe(false);
      expect(messages.some((m) => m.model === 'claude-opus-5-5')).toBe(true);
      expect(messages.some((m) => m.spend !== undefined)).toBe(true);
    });

    it('off, thinking arrives, on, then a late replay sends no thinking', () => {
      const store = new AgentStateStore();
      store.set(1, agent);
      applyShowThinking(store, false);
      processTranscriptLine(
        1,
        thinkingLine('msg_1', 'secret plan'),
        agents,
        waitingTimers,
        permissionTimers,
      );
      applyShowThinking(store, true);
      const sent: Array<Record<string, unknown>> = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent.filter((m) => m.thinking !== undefined)).toEqual([]);
    });

    it('broadcasts thinking while on', () => {
      processTranscriptLine(
        1,
        thinkingLine('msg_1', 'plan'),
        agents,
        waitingTimers,
        permissionTimers,
      );
      expect(messages).toContainEqual({ type: 'agentInsight', id: 1, thinking: 'plan' });
    });
  });

  describe('shadow translate', () => {
    let tmpRoot: string;
    let main: AgentStateStore;
    let watch: SubagentWatch;
    let messages: Array<Record<string, unknown>>;
    let shadowId: number;
    let lead: AgentState;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-showthinking-'));
      setHookProvider(claudeProvider);
      main = new AgentStateStore();
      watch = new SubagentWatch(main);
      messages = [];
      main.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
      const jsonl = path.join(tmpRoot, 'agent-x.jsonl');
      fs.writeFileSync(jsonl, '');
      lead = testAgent({ id: 7 });
      lead.backgroundAgentToolIds.add('toolu_A');
      main.set(7, lead);
      watch.watch(lead, 7, { jsonlPath: jsonl, toolUseId: 'toolu_A' });
      [shadowId] = [...watch.store.keys()];
    });

    afterEach(() => {
      watch.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('omits thinking from the broadcast while off, keeps the rest, and does not store it', () => {
      setThinkingShared(false);
      watch.store.broadcast({
        type: 'agentInsight',
        id: shadowId,
        model: 'claude-haiku-5-5',
        thinking: 'looking',
        spend: SPEND,
      });
      expect(messages.filter((m) => m.type === 'subagentInsight')).toEqual([
        {
          type: 'subagentInsight',
          id: 7,
          parentToolId: 'toolu_A',
          model: 'claude-haiku-5-5',
          spend: SPEND,
        },
      ]);
      expect(lead.insightSpawns?.get('toolu_A')?.thinking).toBeUndefined();
    });

    it('sends nothing for a change that was only thinking', () => {
      setThinkingShared(false);
      watch.store.broadcast({ type: 'agentInsight', id: shadowId, thinking: 'looking' });
      expect(messages.filter((m) => m.type === 'subagentInsight')).toEqual([]);
    });

    it('turning off clears the live spawn bubble once', () => {
      watch.store.broadcast({ type: 'agentInsight', id: shadowId, thinking: 'looking' });
      messages.length = 0;
      applyShowThinking(main, false);
      expect(messages).toEqual([
        { type: 'subagentInsight', id: 7, parentToolId: 'toolu_A', thinking: '' },
      ]);
    });
  });

  describe('replay', () => {
    it('omits thinking from the agent and the spawn replays while off', () => {
      const store = new AgentStateStore();
      store.set(
        1,
        testAgent({
          id: 1,
          insightModel: 'claude-opus-5-5',
          insightThinking: 'secret',
          insightSpend: SPEND,
          backgroundAgentToolIds: new Set(['toolu_A']),
          insightSpawns: new Map([['toolu_A', { model: 'haiku', thinking: 'secret child' }]]),
        }),
      );
      setThinkingShared(false);
      const sent: Array<Record<string, unknown>> = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent).toEqual([
        { type: 'agentInsight', id: 1, model: 'claude-opus-5-5', spend: SPEND },
        { type: 'subagentInsight', id: 1, parentToolId: 'toolu_A', model: 'haiku' },
      ]);
    });

    it('skips an agent whose only insight is thinking while off', () => {
      const store = new AgentStateStore();
      store.set(1, testAgent({ id: 1, insightThinking: 'secret' }));
      setThinkingShared(false);
      const sent: Array<Record<string, unknown>> = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent).toEqual([]);
    });
  });

  describe('applyShowThinking', () => {
    let store: AgentStateStore;
    let messages: Array<Record<string, unknown>>;

    beforeEach(() => {
      store = new AgentStateStore();
      store.set(1, testAgent({ id: 1, insightThinking: 'a' }));
      store.set(2, testAgent({ id: 2 }));
      store.set(
        3,
        testAgent({
          id: 3,
          activeToolIds: new Set(['live']),
          insightSpawns: new Map([
            ['live', { thinking: 'child' }],
            ['dead', { thinking: 'gone' }],
            ['quiet', { model: 'haiku' }],
          ]),
        }),
      );
      messages = [];
      store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    });

    it('turning off clears each agent and live spawn that has thinking, once', () => {
      applyShowThinking(store, false);
      applyShowThinking(store, false);
      expect(messages).toEqual([
        { type: 'agentInsight', id: 1, thinking: '' },
        { type: 'subagentInsight', id: 3, parentToolId: 'live', thinking: '' },
      ]);
      expect(isThinkingShared()).toBe(false);
    });

    it('forgets stored thinking, so a late replay after turning on sends none', () => {
      applyShowThinking(store, false);
      applyShowThinking(store, true);
      const sent: Array<Record<string, unknown>> = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent.filter((m) => m.thinking !== undefined)).toEqual([]);
      expect(store.get(1)?.insightThinking).toBeUndefined();
      expect(store.get(3)?.insightSpawns?.get('live')?.thinking).toBeUndefined();
    });

    it('turning on replays nothing', () => {
      applyShowThinking(store, false);
      messages.length = 0;
      applyShowThinking(store, true);
      expect(messages).toEqual([]);
      expect(isThinkingShared()).toBe(true);
    });
  });

  describe('setShowThinking message', () => {
    let tempHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;
    let store: AgentStateStore;
    let sent: Array<Record<string, unknown>>;

    beforeEach(() => {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-showthinking-'));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      store = new AgentStateStore();
      store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      sent = [];
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      store.dispose();
      fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it('defaults to on in the config and in the settings message', () => {
      expect(readConfig().standalone.showThinking).toBe(true);
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
        store,
        cache: null,
        privileged: true,
      });
      expect(sent.find((m) => m.type === 'settingsLoaded')?.showThinking).toBe(true);
    });

    it('ignores a non-boolean enabled', () => {
      const ctx = { store, cache: null, privileged: true };
      handleClientMessage({ type: 'setShowThinking', enabled: 'false' }, (m) => sent.push(m), ctx);
      handleClientMessage({ type: 'setShowThinking' }, (m) => sent.push(m), ctx);
      expect(isThinkingShared()).toBe(true);
      expect(readConfig().standalone.showThinking).toBe(true);
    });

    it('persists, flips the flag, and clears the bubbles when turned off', () => {
      store.set(1, testAgent({ id: 1, insightThinking: 'a' }));
      const broadcasts: Array<Record<string, unknown>> = [];
      store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));
      const ctx = { store, cache: null, privileged: true };

      handleClientMessage({ type: 'setShowThinking', enabled: false }, (m) => sent.push(m), ctx);
      expect(readConfig().standalone.showThinking).toBe(false);
      expect(isThinkingShared()).toBe(false);
      expect(broadcasts).toEqual([{ type: 'agentInsight', id: 1, thinking: '' }]);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      expect(sent.find((m) => m.type === 'settingsLoaded')?.showThinking).toBe(false);

      handleClientMessage({ type: 'setShowThinking', enabled: true }, (m) => sent.push(m), ctx);
      expect(readConfig().standalone.showThinking).toBe(true);
      expect(isThinkingShared()).toBe(true);
    });

    it('a read-only client changes nothing and is re-sent the real setting', () => {
      handleClientMessage({ type: 'setShowThinking', enabled: false }, (m) => sent.push(m), {
        store,
        cache: null,
        privileged: false,
      });
      expect(isThinkingShared()).toBe(true);
      expect(readConfig().standalone.showThinking).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'settingsLoaded', showThinking: true });
    });
  });
});
