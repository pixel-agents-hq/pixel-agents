import { describe, expect, it } from 'vitest';

import type { NoticeItem } from '../../core/src/messages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { NOTICE_BOARD_MAX_ITEMS } from '../src/signals/constants.js';
import { filterItems, NoticeBoard, parseSearch } from '../src/signals/noticeBoard.js';

/**
 * The notice board's `gh` polling, with a fake runner: no real `gh`, no network.
 */

const pr = (repo: string, title = 'Fix it', n = 1) => ({
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  repository: { name: repo.split('/')[1], nameWithOwner: repo },
});

function fakeGh(
  answers: { auth?: boolean; login?: string; prs?: unknown[]; issues?: unknown[] },
  calls: string[][] = [],
) {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'auth') {
      if (answers.auth === false) throw new Error('not logged in');
      return 'Logged in';
    }
    if (args[0] === 'api') return `${answers.login ?? 'me'}\n`;
    if (args[0] === 'search' && args[1] === 'prs') return JSON.stringify(answers.prs ?? []);
    if (args[0] === 'search' && args[1] === 'issues') return JSON.stringify(answers.issues ?? []);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

describe('parseSearch / filterItems', () => {
  it('keeps titles, repos and https urls only', () => {
    const json = JSON.stringify([
      pr('me/app', 'A'),
      { title: 'no repo', url: 'https://x' },
      { ...pr('me/app', 'bad url'), url: 'javascript:alert(1)' },
      { ...pr('me/app', 'extra'), body: 'secret body' },
    ]);
    const items = parseSearch('pr', json);
    expect(items).toEqual([
      { kind: 'pr', title: 'A', repo: 'me/app', url: 'https://github.com/me/app/pull/1' },
      { kind: 'pr', title: 'extra', repo: 'me/app', url: 'https://github.com/me/app/pull/1' },
    ]);
    expect(parseSearch('pr', 'not json')).toEqual([]);
  });

  it("keeps repos seen today or the user's own", () => {
    const items: NoticeItem[] = [
      { kind: 'pr', title: 'mine', repo: 'Me/tool', url: 'https://a' },
      { kind: 'pr', title: 'seen', repo: 'acme/hobbyfi-web', url: 'https://b' },
      { kind: 'issue', title: 'other', repo: 'acme/elsewhere', url: 'https://c' },
    ];
    expect(filterItems(items, new Set(['Hobbyfi-Web']), 'me').map((i) => i.title)).toEqual([
      'mine',
      'seen',
    ]);
  });
});

describe('NoticeBoard', () => {
  it('stays empty and stops after `gh auth status` fails', async () => {
    const calls: string[][] = [];
    const changes: NoticeItem[][] = [];
    const board = new NoticeBoard({
      run: fakeGh({ auth: false, prs: [pr('me/app')] }, calls),
      seenRepos: () => new Set(),
      onChange: (items) => changes.push(items),
    });
    await board.poll();
    expect(calls).toEqual([['auth', 'status']]);
    expect(board.current()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('asks gh for open authored PRs and assigned issues, with args (no shell)', async () => {
    const calls: string[][] = [];
    const changes: NoticeItem[][] = [];
    const board = new NoticeBoard({
      run: fakeGh(
        { login: 'me', prs: [pr('me/app', 'Ship')], issues: [pr('acme/web', 'Bug', 2)] },
        calls,
      ),
      seenRepos: () => new Set(['web']),
      onChange: (items) => changes.push(items),
    });
    await board.poll();
    expect(calls).toContainEqual([
      'search',
      'prs',
      '--author=@me',
      '--state=open',
      '--json',
      'title,url,repository',
      '--limit',
      '30',
    ]);
    expect(calls).toContainEqual(expect.arrayContaining(['search', 'issues', '--assignee=@me']));
    expect(changes).toHaveLength(1);
    expect(board.current().map((i) => [i.kind, i.title, i.repo])).toEqual([
      ['pr', 'Ship', 'me/app'],
      ['issue', 'Bug', 'acme/web'],
    ]);
    // Same answer again: no change sent.
    await board.poll();
    expect(changes).toHaveLength(1);
  });

  it('caps the list', async () => {
    const many = Array.from({ length: 40 }, (_, i) => pr('me/app', `PR ${i}`, i));
    const board = new NoticeBoard({
      run: fakeGh({ prs: many }),
      seenRepos: () => new Set(),
      onChange: () => {},
    });
    await board.poll();
    expect(board.current()).toHaveLength(NOTICE_BOARD_MAX_ITEMS);
  });
});

describe('notice board wiring', () => {
  it('broadcasts noticeBoard and limits repos to the ones seen today', async () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null },
      signals: {
        tokensDir: null,
        noticeBoard: {
          run: fakeGh({
            login: 'someone-else',
            prs: [pr('acme/hobbyfi-web', 'Seen'), pr('acme/unrelated', 'Hidden')],
          }),
        },
      },
    });
    try {
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: 's1',
          projectDir: '/w',
          jsonlFile: '',
          isExternal: true,
          directoryName: 'hobbyfi-web',
        }),
      );
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (m) => broadcasts.push(m));
      await runtime.signals.pollNoticeBoard();
      expect(broadcasts.filter((m) => m.type === 'noticeBoard')).toEqual([
        {
          type: 'noticeBoard',
          items: [
            {
              kind: 'pr',
              title: 'Seen',
              repo: 'acme/hobbyfi-web',
              url: 'https://github.com/acme/hobbyfi-web/pull/1',
            },
          ],
        },
      ]);
    } finally {
      runtime.dispose();
    }
  });
});
