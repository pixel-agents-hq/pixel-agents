import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Directory } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CONVERSATIONS_LIMIT_MAX } from '../src/constants.js';
import {
  conversationLimitsFrom,
  conversationLook,
  conversationQueryFrom,
  listConversations,
  liveSessions,
  recordConversationLooks,
  resumeRequest,
  searchConversations,
} from '../src/conversations.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CONVERSATION_TITLE_SCAN_BYTES } from '../src/providers/hook/claude/constants.js';
import { conversationTitle } from '../src/providers/hook/claude/conversationTitle.js';

/**
 * The sidebar's recent conversations: Claude's own titles read off the
 * transcripts, each Directory's newest five, and the look an agent wore kept
 * per session so a resume brings the same character back.
 */

const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('conversations', () => {
  let dir: string;
  let projectDir: string;
  const provider: HookProvider = { ...claudeProvider, getSessionDirs: () => [projectDir] };
  const directory: Directory = { name: 'Web', path: '/work/web', source: 'user' };

  function transcript(sessionId: string, body: string, mtime: number): string {
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-conversations-'));
    projectDir = path.join(dir, 'sessions');
    fs.mkdirSync(projectDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('conversationTitle', () => {
    it('takes the newest generated title, and a rename over it', () => {
      const file = transcript(
        uuid(1),
        line({ type: 'ai-title', aiTitle: 'First guess' }) +
          line({ type: 'user' }) +
          line({ type: 'ai-title', aiTitle: 'Fix the login bug' }),
        1,
      );
      expect(conversationTitle(file)).toBe('Fix the login bug');
      fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'Login' }));
      expect(conversationTitle(file)).toBe('Login');
    });

    it('falls back to the last prompt, and finds an early title past a long tail', () => {
      const short = transcript(uuid(2), line({ type: 'last-prompt', lastPrompt: 'hi\nthere' }), 1);
      expect(conversationTitle(short)).toBe('hi there');

      const long = transcript(
        uuid(3),
        line({ type: 'ai-title', aiTitle: 'Early' }) +
          line({ type: 'user', text: 'x'.repeat(CONVERSATION_TITLE_SCAN_BYTES * 2) }),
        1,
      );
      expect(conversationTitle(long)).toBe('Early');
    });

    it('takes a rename in the tail over one in the head, and reads the head for one otherwise', () => {
      const filler = line({ type: 'user', text: 'x'.repeat(CONVERSATION_TITLE_SCAN_BYTES * 2) });
      const renamedTwice = transcript(
        uuid(5),
        line({ type: 'custom-title', customTitle: 'Old name' }) +
          filler +
          line({ type: 'custom-title', customTitle: 'New name' }),
        1,
      );
      expect(conversationTitle(renamedTwice)).toBe('New name');

      const renamedEarly = transcript(
        uuid(6),
        line({ type: 'custom-title', customTitle: 'Renamed' }) +
          filler +
          line({ type: 'ai-title', aiTitle: 'Generated' }),
        1,
      );
      expect(conversationTitle(renamedEarly)).toBe('Renamed');
    });

    it('has none for a session never prompted, or a missing file', () => {
      expect(conversationTitle(transcript(uuid(4), line({ type: 'user' }), 1))).toBeUndefined();
      expect(conversationTitle(path.join(dir, 'missing.jsonl'))).toBeUndefined();
    });
  });

  it('lists the newest five, running ones included, leaving out untitled past ones', () => {
    for (let i = 1; i <= 8; i++) {
      transcript(uuid(i), line({ type: 'ai-title', aiTitle: `Chat ${i}` }), i * 60_000);
    }
    transcript(uuid(9), line({ type: 'user' }), 9 * 60_000);

    // Agent 3 runs Chat 2 and agent 4 a session too new to have a title.
    transcript(uuid(10), line({ type: 'user' }), 60_000 / 2);
    const live = new Map([
      [uuid(2), { agentId: 3, palette: 4, repeat: 0 }],
      [uuid(10), { agentId: 4, palette: 1, repeat: 1 }],
    ]);
    const [listed] = listConversations([directory], provider, live);
    expect(listed.name).toBe('Web');
    expect(listed.conversations.map((c) => c.title)).toEqual([
      'Chat 8',
      'Chat 7',
      'Chat 6',
      'Chat 5',
      'Chat 4',
    ]);
    expect(listed.more).toBe(true);
    expect(listed.conversations[0]).toMatchObject({ sessionId: uuid(8), updatedAt: 8 * 60_000 });
    expect(listed.conversations[0].agentId).toBeUndefined();
    // Asked for all: the running ones with their agents, the untitled
    // running one as "New conversation".
    const all = listConversations(
      [directory],
      provider,
      live,
      conversationLimitsFrom([{ directoryPath: '/work/web', count: 20 }]),
    )[0];
    expect(all.conversations.map((c) => c.title).slice(-3)).toEqual([
      'Chat 2',
      'Chat 1',
      'New conversation',
    ]);
    expect(all.conversations.at(-3)).toMatchObject({ agentId: 3, palette: 4, repeat: 0 });
    expect(all.more).toBeUndefined();
  });

  it('lists as many past ones as a Directory asks for, and says whether older ones exist', () => {
    for (let i = 1; i <= 8; i++) {
      transcript(uuid(i), line({ type: 'ai-title', aiTitle: `Chat ${i}` }), i * 60_000);
    }
    // Untitled and the oldest: no "more" for it alone.
    transcript(uuid(9), line({ type: 'user' }), 1);
    const list = (count?: number) =>
      listConversations(
        [directory],
        provider,
        new Map(),
        count === undefined
          ? undefined
          : conversationLimitsFrom([{ directoryPath: '/work/web', count }]),
      )[0];
    expect(list().conversations).toHaveLength(5);
    expect(list().more).toBe(true);
    expect(
      list(7)
        .conversations.map((c) => c.title)
        .at(-1),
    ).toBe('Chat 2');
    expect(list(7).more).toBe(true);
    expect(list(8).conversations).toHaveLength(8);
    expect(list(8).more).toBeUndefined();
  });

  it('reads limits defensively', () => {
    expect(conversationLimitsFrom('nope').size).toBe(0);
    const limits = conversationLimitsFrom([
      { directoryPath: '/a', count: 10 },
      { directoryPath: '/b', count: 1.5 },
      { directoryPath: 3, count: 10 },
      { directoryPath: '/c', count: 0 },
      { directoryPath: '/d', count: 1e9 },
    ]);
    expect([...limits]).toEqual([
      ['/a', 10],
      ['/c', 1],
      ['/d', CONVERSATIONS_LIMIT_MAX],
    ]);
  });

  describe('searchConversations', () => {
    const other: Directory = { name: 'Api', path: '/work/api', source: 'user' };
    let otherDir: string;
    const twoDirs: HookProvider = {
      ...claudeProvider,
      getSessionDirs: (p) => [p === '/work/api' ? otherDir : projectDir],
    };

    beforeEach(() => {
      otherDir = path.join(dir, 'api-sessions');
      fs.mkdirSync(otherDir);
      transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Fix the Login bug' }), 60_000);
      transcript(uuid(2), line({ type: 'ai-title', aiTitle: 'Write docs' }), 120_000);
      transcript(uuid(3), line({ type: 'user' }), 180_000);
      const file = path.join(otherDir, `${uuid(4)}.jsonl`);
      fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Login endpoint' }));
      fs.utimesSync(file, 240, 240);
    });

    const search = (query: string, limit = 50, directoryPath?: string) =>
      searchConversations([directory, other], twoDirs, new Map(), {
        query,
        limit,
        ...(directoryPath ? { directoryPath } : {}),
      });

    it('finds titles holding every word, any case, newest first, across Directories', () => {
      const { results, more } = search('login');
      expect(results.map((r) => [r.directoryName, r.conversation.title])).toEqual([
        ['Api', 'Login endpoint'],
        ['Web', 'Fix the Login bug'],
      ]);
      expect(more).toBe(false);
      expect(search('LOGIN bug').results).toHaveLength(1);
      expect(search('login nope').results).toHaveLength(0);
    });

    it('lists every titled one for an empty query, a page at a time', () => {
      expect(search('').results.map((r) => r.conversation.title)).toEqual([
        'Login endpoint',
        'Write docs',
        'Fix the Login bug',
      ]);
      const page = search('', 2);
      expect(page.results).toHaveLength(2);
      expect(page.more).toBe(true);
    });

    it('keeps to one Directory when asked', () => {
      expect(search('', 50, '/work/web').results.map((r) => r.directoryPath)).toEqual([
        '/work/web',
        '/work/web',
      ]);
    });

    it('checks the request', () => {
      expect(conversationQueryFrom({ query: 'x', limit: 10 })).toEqual({ query: 'x', limit: 10 });
      expect(conversationQueryFrom({ query: 'x', limit: 0 })).toEqual({ query: 'x', limit: 1 });
      expect(conversationQueryFrom({ query: 3, limit: 10 })).toBeNull();
      expect(conversationQueryFrom({ query: 'x', limit: 2.5 })).toBeNull();
      expect(conversationQueryFrom({ query: 'x', limit: 1, directoryPath: 4 })).toBeNull();
    });
  });

  it('remembers what an agent wore and where it sat, under its session', () => {
    const store = new AgentStateStore();
    store.set(
      4,
      createAgentState({
        id: 4,
        sessionId: uuid(1),
        projectDir,
        jsonlFile: path.join(projectDir, `${uuid(1)}.jsonl`),
        isExternal: false,
        palette: 2,
        repeat: 1,
      }),
    );
    recordConversationLooks(store, { '4': { seatId: 'chair-3' }, '99': { seatId: 'x' } });
    expect(conversationLook(uuid(1))).toMatchObject({ palette: 2, repeat: 1, seatId: 'chair-3' });

    transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Seated' }), 1);
    const [listed] = listConversations([directory], provider, new Map());
    expect(listed.conversations[0]).toMatchObject({ palette: 2, repeat: 1 });
  });

  describe('title cache', () => {
    function countingProvider(): { provider: HookProvider; reads: () => number } {
      let reads = 0;
      return {
        provider: {
          ...provider,
          conversationTitle: (file: string) => {
            reads++;
            return conversationTitle(file);
          },
        },
        reads: () => reads,
      };
    }
    const titles = (p: HookProvider) =>
      listConversations([directory], p, new Map())[0].conversations.map((c) => c.title);

    it('reads an unchanged transcript once, untitled ones included', () => {
      const { provider: counting, reads } = countingProvider();
      transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Cached' }), 60_000);
      transcript(uuid(2), line({ type: 'user' }), 120_000);
      expect(titles(counting)).toEqual(['Cached']);
      expect(reads()).toBe(2);
      expect(titles(counting)).toEqual(['Cached']);
      expect(reads()).toBe(2);
    });

    it('reads a transcript again once it was written to', () => {
      const { provider: counting, reads } = countingProvider();
      const file = transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Before' }), 60_000);
      expect(titles(counting)).toEqual(['Before']);

      // An append changes the size.
      fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'After' }));
      fs.utimesSync(file, 60, 60);
      expect(titles(counting)).toEqual(['After']);
      expect(reads()).toBe(2);

      // A same-size rewrite still changes the mtime.
      fs.writeFileSync(
        file,
        line({ type: 'ai-title', aiTitle: 'Before' }) +
          line({ type: 'custom-title', customTitle: 'Later' }),
      );
      fs.utimesSync(file, 61, 61);
      expect(titles(counting)).toEqual(['Later']);
      expect(reads()).toBe(3);
    });

    it('forgets transcripts a listing no longer looked at', () => {
      const { provider: counting, reads } = countingProvider();
      transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Kept' }), 60_000);
      titles(counting);
      listConversations([], counting, new Map());
      titles(counting);
      expect(reads()).toBe(2);
    });
  });

  describe('resumeRequest', () => {
    const agent = (id: number, sessionId: string, spawnToolUseId?: string) =>
      createAgentState({
        id,
        sessionId,
        projectDir,
        jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
        isExternal: false,
        palette: id,
        repeat: 0,
        spawnToolUseId,
      });

    it('resumes an existing transcript wearing its remembered look', () => {
      const store = new AgentStateStore();
      store.set(4, agent(4, uuid(1)));
      recordConversationLooks(store, { '4': { seatId: 'chair-3' } });
      store.delete(4);
      const file = transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Back' }), 1);
      expect(resumeRequest(store, provider, { sessionId: uuid(1), directoryPath: '/w' })).toEqual({
        sessionId: uuid(1),
        directoryPath: '/w',
        transcript: file,
        look: expect.objectContaining({ palette: 4, repeat: 0, seatId: 'chair-3' }),
      });
    });

    it('refuses a non-UUID id, a missing Directory or transcript, and a session already running', () => {
      const store = new AgentStateStore();
      transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Here' }), 1);
      expect(
        resumeRequest(store, provider, { sessionId: '--help', directoryPath: '/w' }),
      ).toBeNull();
      expect(resumeRequest(store, provider, { sessionId: uuid(1) })).toBeNull();
      expect(
        resumeRequest(store, provider, { sessionId: uuid(2), directoryPath: '/w' }),
      ).toBeNull();
      // A background child counts too: its session is in the office.
      store.set(7, agent(7, uuid(1), 'toolu_1'));
      expect(
        resumeRequest(store, provider, { sessionId: uuid(1), directoryPath: '/w' }),
      ).toBeNull();
    });

    it('refuses for a provider that lists no conversations (it is never asked to resume)', () => {
      transcript(uuid(1), line({ type: 'ai-title', aiTitle: 'Here' }), 1);
      const untitled: HookProvider = { ...provider, conversationTitle: undefined };
      expect(
        resumeRequest(new AgentStateStore(), untitled, { sessionId: uuid(1), directoryPath: '/w' }),
      ).toBeNull();
    });
  });

  it('maps each session to the agent running it, leaving background children out', () => {
    const store = new AgentStateStore();
    store.set(
      3,
      createAgentState({
        id: 3,
        sessionId: uuid(1),
        projectDir,
        jsonlFile: 'a',
        isExternal: false,
        palette: 2,
        repeat: 1,
      }),
    );
    store.set(
      8,
      createAgentState({
        id: 8,
        sessionId: uuid(1),
        projectDir,
        jsonlFile: 'a',
        isExternal: false,
        spawnToolUseId: 'toolu_1',
      }),
    );
    expect([...liveSessions(store)]).toEqual([[uuid(1), { agentId: 3, palette: 2, repeat: 1 }]]);
  });
});
