/**
 * Notice board: the user's open PRs (authored) and issues (assigned) on GitHub,
 * for the repos seen in the office today or the user's own. Read with the `gh`
 * CLI through execFile (no shell), every NOTICE_BOARD_POLL_MS, and only while
 * `gh auth status` succeeds. Titles, repos and urls only.
 */

import { execFile } from 'child_process';

import type { NoticeItem, NoticeKind } from '../../../core/src/messages.js';
import {
  NOTICE_BOARD_GH_TIMEOUT_MS,
  NOTICE_BOARD_MAX_ITEMS,
  NOTICE_BOARD_POLL_MS,
  NOTICE_BOARD_SEARCH_LIMIT,
  NOTICE_BOARD_TITLE_MAX_CHARS,
} from './constants.js';

/** Runs `gh <args>`; resolves stdout, rejects on a non-zero exit or timeout. */
export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: NOTICE_BOARD_GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

const SEARCH_FIELDS = 'title,url,repository';

/** gh search's JSON rows, reduced to notice items; malformed rows dropped. */
export function parseSearch(kind: NoticeKind, json: string): NoticeItem[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const items: NoticeItem[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { title, url, repository } = row as Record<string, unknown>;
    const repo = (repository as Record<string, unknown> | null)?.nameWithOwner;
    if (typeof title !== 'string' || typeof url !== 'string' || typeof repo !== 'string') continue;
    if (!url.startsWith('https://')) continue;
    const clipped =
      title.length > NOTICE_BOARD_TITLE_MAX_CHARS
        ? `${title.slice(0, NOTICE_BOARD_TITLE_MAX_CHARS - 1)}…`
        : title;
    items.push({ kind, title: clipped, repo, url });
  }
  return items;
}

/** Keep the items whose repo was seen today (by name) or belongs to `login`. */
export function filterItems(
  items: NoticeItem[],
  seenRepos: ReadonlySet<string>,
  login: string | undefined,
): NoticeItem[] {
  const seen = new Set([...seenRepos].map((r) => r.toLowerCase()));
  const owner = login?.toLowerCase();
  return items
    .filter((item) => {
      const [itemOwner = '', name = ''] = item.repo.toLowerCase().split('/');
      return seen.has(name) || (owner !== undefined && itemOwner === owner);
    })
    .slice(0, NOTICE_BOARD_MAX_ITEMS);
}

export interface NoticeBoardOptions {
  run?: GhRunner;
  /** Repo names (directory names) the office has seen today. */
  seenRepos: () => ReadonlySet<string>;
  onChange: (items: NoticeItem[]) => void;
}

export class NoticeBoard {
  private items: NoticeItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private readonly run: GhRunner;

  constructor(private readonly options: NoticeBoardOptions) {
    this.run = options.run ?? runGh;
  }

  current(): NoticeItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), NOTICE_BOARD_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One refresh. Never throws: without `gh`, or signed out, the board stays as it is. */
  poll(): Promise<void> {
    this.polling ??= this.refresh().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async refresh(): Promise<void> {
    try {
      await this.run(['auth', 'status']);
    } catch {
      return; // no gh, or not signed in: nothing to show
    }
    try {
      const [login, prs, issues] = await Promise.all([
        this.run(['api', 'user', '--jq', '.login']).then((s) => s.trim() || undefined),
        this.run([
          'search',
          'prs',
          '--author=@me',
          '--state=open',
          '--json',
          SEARCH_FIELDS,
          '--limit',
          String(NOTICE_BOARD_SEARCH_LIMIT),
        ]),
        this.run([
          'search',
          'issues',
          '--assignee=@me',
          '--state=open',
          '--json',
          SEARCH_FIELDS,
          '--limit',
          String(NOTICE_BOARD_SEARCH_LIMIT),
        ]),
      ]);
      const items = filterItems(
        [...parseSearch('pr', prs), ...parseSearch('issue', issues)],
        this.options.seenRepos(),
        login,
      );
      if (JSON.stringify(items) === JSON.stringify(this.items)) return;
      this.items = items;
      this.options.onChange(this.current());
    } catch (err) {
      console.warn('[Pixel Agents] Notice board: gh search failed:', (err as Error).message);
    }
  }
}
