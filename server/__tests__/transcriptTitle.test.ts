import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  TASK_TITLE_MAX_LENGTH,
  TITLE_SEED_HEAD_BYTES,
  TITLE_SEED_TAIL_BYTES,
} from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { startFileWatching } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import { aiTitleOf, readLatestAiTitle } from '../src/transcriptTitle.js';
import type { AgentState } from '../src/types.js';

/**
 * Task titles: Claude Code writes `ai-title` records into a session's
 * transcript (many per file, the newest wins). The server reads the latest one
 * when it adopts or restores an agent -- from the transcript's tail, never the
 * whole file -- and follows new ones while it watches the transcript.
 */

type Message = Record<string, unknown>;

function aiTitle(title: string): Record<string, unknown> {
  return { type: 'ai-title', aiTitle: title, sessionId: 's1' };
}

function filler(size: number): Record<string, unknown> {
  return { type: 'user', message: { content: 'x'.repeat(size) } };
}

describe('aiTitleOf', () => {
  it('reads the title of an ai-title record', () => {
    expect(aiTitleOf(aiTitle('Draft review by email'))).toBe('Draft review by email');
  });

  it('ignores other records and unusable titles', () => {
    expect(aiTitleOf({ type: 'user', aiTitle: 'not a title record' })).toBeUndefined();
    expect(aiTitleOf({ type: 'ai-title' })).toBeUndefined();
    expect(aiTitleOf({ type: 'ai-title', aiTitle: 42 })).toBeUndefined();
    expect(aiTitleOf({ type: 'ai-title', aiTitle: '   ' })).toBeUndefined();
    expect(aiTitleOf(null)).toBeUndefined();
    expect(aiTitleOf('ai-title')).toBeUndefined();
  });

  it('collapses whitespace, drops control characters and caps the length', () => {
    expect(aiTitleOf(aiTitle('  Fix\nthe\t build \u0007 '))).toBe('Fix the build');
    const long = aiTitleOf(aiTitle('word '.repeat(60)))!;
    expect(long.length).toBeLessThanOrEqual(TASK_TITLE_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('readLatestAiTitle', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-title-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, records: Array<Record<string, unknown>>): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  it('returns the newest title', () => {
    const file = write('s.jsonl', [
      aiTitle('First guess'),
      filler(100),
      aiTitle('Draft review by email'),
      filler(100),
    ]);
    expect(readLatestAiTitle(file)).toBe('Draft review by email');
  });

  it('prefers a title in the tail of a large file over older ones', () => {
    const count = Math.ceil(TITLE_SEED_TAIL_BYTES / 4_000) + 10;
    const file = write('big.jsonl', [
      aiTitle('Old title'),
      ...Array.from({ length: count }, () => filler(4_000)),
      aiTitle('New title'),
      filler(100),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(TITLE_SEED_TAIL_BYTES);
    expect(readLatestAiTitle(file)).toBe('New title');
  });

  it('falls back to the head when the tail of a large file has no title', () => {
    const count = Math.ceil(TITLE_SEED_TAIL_BYTES / 4_000) + 10;
    const file = write('head-only.jsonl', [
      aiTitle('Early title'),
      aiTitle('Later early title'),
      ...Array.from({ length: count }, () => filler(4_000)),
    ]);
    expect(readLatestAiTitle(file)).toBe('Later early title');
  });

  it('never reads the whole file', () => {
    const count = Math.ceil(TITLE_SEED_TAIL_BYTES / 4_000) * 4;
    const file = write(
      'huge.jsonl',
      Array.from({ length: count }, () => filler(4_000)),
    );
    // The module namespace can't be spied on; the CJS object behind it can.
    const fsCjs = createRequire(import.meta.url)('fs') as typeof fs;
    const readFileSync = vi.spyOn(fsCjs, 'readFileSync');
    const readSync = vi.spyOn(fsCjs, 'readSync');
    syncBuiltinESMExports();
    try {
      expect(readLatestAiTitle(file)).toBeUndefined();
      expect(readFileSync).not.toHaveBeenCalled();
      expect(readSync).toHaveBeenCalled();
      // readSync(fd, buffer, offset, length, position): the length asked for.
      const bytes = readSync.mock.calls.reduce(
        (sum, call) => sum + Number((call as unknown[])[3]),
        0,
      );
      expect(bytes).toBeLessThanOrEqual(TITLE_SEED_TAIL_BYTES + TITLE_SEED_HEAD_BYTES);
      expect(bytes).toBeLessThan(fs.statSync(file).size);
    } finally {
      readFileSync.mockRestore();
      readSync.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('answers nothing for a transcript without titles, an empty one, or a missing one', () => {
    expect(readLatestAiTitle(write('none.jsonl', [filler(10)]))).toBeUndefined();
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    expect(readLatestAiTitle(empty)).toBeUndefined();
    expect(readLatestAiTitle(path.join(dir, 'gone.jsonl'))).toBeUndefined();
    expect(readLatestAiTitle('')).toBeUndefined();
  });

  it('skips malformed lines', () => {
    const file = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify(aiTitle('Good title'))}\n{"type":"ai-title","aiTitle":"broken\n`,
    );
    expect(readLatestAiTitle(file)).toBe('Good title');
  });
});

describe('ai-title records while a transcript is watched', () => {
  let store: AgentStateStore;
  let agent: AgentState;
  let messages: Message[];
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    store = new AgentStateStore();
    agent = createAgentState({
      id: 1,
      sessionId: 's1',
      isExternal: true,
      projectDir: '/work',
      jsonlFile: '/work/s1.jsonl',
    });
    store.set(1, agent);
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  function line(record: Record<string, unknown>): void {
    processTranscriptLine(1, JSON.stringify(record), store, waitingTimers, permissionTimers);
  }

  it('sets the title and broadcasts agentTitle when it changes, only then', () => {
    line(aiTitle('Draft review by email'));
    line(aiTitle('Draft review by email'));
    line(aiTitle('Ship the review email'));

    expect(agent.title).toBe('Ship the review email');
    expect(messages.filter((m) => m.type === 'agentTitle')).toEqual([
      { type: 'agentTitle', id: 1, title: 'Draft review by email' },
      { type: 'agentTitle', id: 1, title: 'Ship the review email' },
    ]);
  });

  it('ignores an ai-title record without a usable title', () => {
    line({ type: 'ai-title', aiTitle: '' });
    expect(agent.title).toBeUndefined();
    expect(messages).toEqual([]);
  });
});

describe('titles on adoption and restore', () => {
  let home: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;
  let messages: Message[];
  let added: Array<{ id: number; title?: string }>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-title-adopt-'));
    store = new AgentStateStore();
    messages = [];
    added = [];
    store.on('broadcast', (m) => messages.push(m));
    store.on('agentAdded', (id, a) => added.push({ id, title: a.title }));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function transcript(name: string, records: Array<Record<string, unknown>>): string {
    const dir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  it('a session adopted from the session list arrives with its title', async () => {
    const cwd = path.join(home, 'work', 'hobbyfi-blog');
    transcript('sess-titled.jsonl', [aiTitle('Old'), filler(50), aiTitle('Draft review by email')]);
    runtime = new AgentRuntime(store, claudeProvider, {
      localSessions: {
        listSessions: async () => [
          { sessionId: 'sess-titled', cwd, status: 'idle', kind: 'interactive' },
        ],
        homedir: () => home,
      },
    });

    await runtime.localSessions.poll();

    const agent = [...store.values()].find((a) => a.sessionId === 'sess-titled')!;
    expect(agent.title).toBe('Draft review by email');
    // Known before the agent was announced, so agentCreated can carry it.
    expect(added).toEqual([{ id: agent.id, title: 'Draft review by email' }]);
  });

  it('a session adopted through its hooks arrives with its title', () => {
    const file = transcript('sess-hook.jsonl', [aiTitle('Fix the flaky test')]);
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-hook',
      transcript_path: file,
      cwd: path.join(home, 'work', 'api'),
      source: 'startup',
    });
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-hook' });

    expect(added).toHaveLength(1);
    expect(added[0].title).toBe('Fix the flaky test');
  });

  it('a restored agent gets its title back', () => {
    const file = transcript('sess-restored.jsonl', [aiTitle('Refactor the parser')]);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      store.getAdapter()!.saveAgents([
        {
          id: 4,
          sessionId: 'sess-restored',
          terminalName: '',
          isExternal: true,
          jsonlFile: file,
          projectDir: path.dirname(file),
        },
      ]);
      runtime = new AgentRuntime(store, claudeProvider, { progress: { dailyDir: null } });

      runtime.restoreExternalAgents();

      expect(store.get(4)?.title).toBe('Refactor the parser');
      expect(added).toEqual([{ id: 4, title: 'Refactor the parser' }]);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('a watched agent without a title yet is seeded from its transcript', () => {
    const file = transcript('sess-watched.jsonl', [aiTitle('Write the changelog')]);
    const agent = createAgentState({
      id: 9,
      sessionId: 'sess-watched',
      isExternal: false,
      projectDir: path.dirname(file),
      jsonlFile: file,
    });
    store.set(9, agent);
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();

    startFileWatching(9, file, store, new Map(), pollingTimers, new Map(), new Map());
    for (const timer of pollingTimers.values()) clearInterval(timer);

    expect(agent.title).toBe('Write the changelog');
    expect(messages).toContainEqual({ type: 'agentTitle', id: 9, title: 'Write the changelog' });
  });

  it('a remote agent has no transcript here and no title', () => {
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'laptop:s1',
      cwd: '/home/user/web',
      pixel_source: { id: 'laptop', label: 'Laptop', kind: 'computer' },
    });
    const agent = [...store.values()][0];
    expect(agent.remoteSource).toBeDefined();
    expect(agent.title).toBeUndefined();
    expect(messages.some((m) => m.type === 'agentTitle')).toBe(false);
  });
});
