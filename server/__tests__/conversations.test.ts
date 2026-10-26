import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Directory } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CONVERSATION_TITLE_SCAN_BYTES } from '../src/constants.js';
import {
  conversationLook,
  listConversations,
  liveSessions,
  recordConversationLooks,
  resumeRequest,
} from '../src/conversations.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
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

  it('lists the running ones, then the newest five past ones, leaving out untitled past ones', () => {
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
      'Chat 2',
      'New conversation',
    ]);
    expect(listed.conversations[0]).toMatchObject({ sessionId: uuid(8), updatedAt: 8 * 60_000 });
    expect(listed.conversations[0].agentId).toBeUndefined();
    expect(listed.conversations[5]).toMatchObject({ agentId: 3, palette: 4, repeat: 0 });
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
