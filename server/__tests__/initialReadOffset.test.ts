/**
 * Where reading starts when an agent is attached to a transcript.
 *
 * A resumed session (--resume or /resume) reopens its EXISTING transcript.
 * Reading it from byte 0 replayed the whole history on every resume: past
 * tools flashed by, and background spawns whose completion the harness never
 * wrote came back as Sub-agent characters that never left.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_SCAN_INTERVAL_MS } from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  initialReadOffset,
  reassignAgentToFile,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { setHookProvider } from '../src/transcriptParser.js';

describe('initialReadOffset', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-offset-'));
    file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n{"type":"assistant"}\n');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file that just came to life (a /clear transcript) from the start', () => {
    expect(initialReadOffset(file)).toBe(0);
  });

  it('reads an older file (a resumed session) from its end', () => {
    vi.useFakeTimers({ now: Date.now() + EXTERNAL_SCAN_INTERVAL_MS * 2 + 60_000 });
    expect(initialReadOffset(file)).toBe(fs.statSync(file).size);
  });

  it('reads a file that does not exist yet from the start', () => {
    expect(initialReadOffset(path.join(dir, 'missing.jsonl'))).toBe(0);
  });
});

describe('resuming a session', () => {
  it('attaches to the resumed transcript at its end, replaying none of its past', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-resume-'));
    const fileWatchers = new Map<number, fs.FSWatcher>();
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
    try {
      setHookProvider(claudeProvider);
      setFileWatcherHookProvider(claudeProvider);
      setDismissalTracker(new DismissalTracker());
      // The resumed session's history: a background spawn whose completion
      // never got written (the process died with it).
      const resumed = path.join(dir, 'resumed-session.jsonl');
      const spawn = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_dead_spawn',
              name: 'Agent',
              input: { description: 'impl-03', subagent_type: 'general-purpose' },
            },
          ],
        },
      };
      const launched = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_dead_spawn',
              content: [
                { type: 'text', text: 'Async agent launched successfully.\nagentId: adead' },
              ],
            },
          ],
        },
      };
      fs.writeFileSync(resumed, `${JSON.stringify(spawn)}\n${JSON.stringify(launched)}\n`);
      vi.useFakeTimers({ now: Date.now() + EXTERNAL_SCAN_INTERVAL_MS * 2 + 60_000 });

      const agents = new AgentStateStore();
      const messages: Array<Record<string, unknown>> = [];
      agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
      const agent = createAgentState({
        id: 1,
        sessionId: 'launched-session',
        isExternal: false,
        projectDir: dir,
        jsonlFile: path.join(dir, 'launched-session.jsonl'),
      });
      agents.set(1, agent);

      reassignAgentToFile(
        1,
        resumed,
        agents,
        fileWatchers,
        pollingTimers,
        new Map(),
        new Map(),
        () => {},
      );

      expect(agent.fileOffset).toBe(fs.statSync(resumed).size);
      expect(agent.backgroundSpawns.size).toBe(0);
      expect(messages.some((m) => m.type === 'agentToolStart')).toBe(false);
    } finally {
      for (const w of fileWatchers.values()) w.close();
      for (const t of pollingTimers.values()) clearInterval(t);
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clearing a session', () => {
  it('reads the fresh /clear transcript as an empty context, a real 0 sent to the office', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-clear-'));
    const fileWatchers = new Map<number, fs.FSWatcher>();
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
    try {
      setHookProvider(claudeProvider);
      setFileWatcherHookProvider(claudeProvider);
      setDismissalTracker(new DismissalTracker());
      const cleared = path.join(dir, 'cleared-session.jsonl');
      fs.writeFileSync(
        cleared,
        `${JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })}\n`,
      );

      const agents = new AgentStateStore();
      const messages: Array<Record<string, unknown>> = [];
      agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
      const agent = createAgentState({
        id: 1,
        sessionId: 'old-session',
        isExternal: false,
        projectDir: dir,
        jsonlFile: path.join(dir, 'old-session.jsonl'),
      });
      agent.contextTokens = 150_000;
      agent.maxContextTokens = 1_000_000;
      agent.contextReported = true;
      agents.set(1, agent);

      reassignAgentToFile(
        1,
        cleared,
        agents,
        fileWatchers,
        pollingTimers,
        new Map(),
        new Map(),
        () => {},
      );

      expect(agent.contextTokens).toBe(0);
      expect(messages.filter((m) => m.type === 'agentContextUsage')).toEqual([
        { type: 'agentContextUsage', id: 1, contextTokens: 0, maxContextTokens: 1_000_000 },
      ]);
    } finally {
      for (const w of fileWatchers.values()) w.close();
      for (const t of pollingTimers.values()) clearInterval(t);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
