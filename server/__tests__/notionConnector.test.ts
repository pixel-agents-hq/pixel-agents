import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeRun } from '../src/tasks/managerReports.js';
import {
  daySection,
  notionIdOf,
  NotionPublisher,
  type PublishedReport,
  readNotionConfig,
  repoSections,
  toNotionMarkdown,
} from '../src/tasks/notionConnector.js';

/**
 * The report into Notion through the claude.ai connector: a page per repo,
 * newest day on top. Each change is a `claude -p` run with only the Notion
 * tools, handed the exact arguments. The runner is injected: nothing runs
 * claude, nothing leaves the machine.
 */

const HOME = '3ff808175634816e8065d82665d9dc87';
const HOME_ID = '3ff80817-5634-816e-8065-d82665d9dc87';
const PAGE_URL = 'https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee';
const PAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const DETAILS = [
  '## dispatch',
  '',
  '_4 h 1 min · 35 commits · this PC_',
  '',
  '- **Phase 1** — Done · 4 h',
  '  - Brand kits from a website',
  '',
  '## pixel-agents — the board',
  '',
  '- **Approvals** — Done · 47 min',
].join('\n');
const DISPATCH_ONLY = DETAILS.split('## pixel-agents')[0];

const REPORT: PublishedReport = {
  date: '2026-10-19',
  title: 'Monday, 19 October 2026',
  details: DETAILS,
  repos: ['dispatch', 'pixel-agents'],
};

describe('content', () => {
  it('reads ids from links', () => {
    expect(notionIdOf(`https://app.notion.com/p/${HOME}?pvs=204`)).toBe(HOME_ID);
    expect(notionIdOf('nope')).toBeUndefined();
  });

  it("splits the details by repo, matching headings to the day's repos", () => {
    expect(repoSections(DETAILS, REPORT.repos)).toEqual([
      {
        repo: 'dispatch',
        body: '_4 h 1 min · 35 commits · this PC_\n\n- **Phase 1** — Done · 4 h\n  - Brand kits from a website',
      },
      { repo: 'pixel-agents', body: '- **Approvals** — Done · 47 min' },
    ]);
    expect(repoSections('intro\n## Something new\n- x', [])).toEqual([
      { repo: 'Something new', body: '- x' },
    ]);
  });

  it('writes Notion markdown: tabs for nesting, *italic*, escapes outside code, no blank lines', () => {
    expect(toNotionMarkdown('_4 h · this PC_\n\n- a\n  - b\n    - c')).toBe(
      '*4 h · this PC*\n- a\n\t- b\n\t\t- c',
    );
    expect(toNotionMarkdown('- costs $5 <b> {x} a|b ~ ^ `keep <this> $`')).toBe(
      '- costs \\$5 \\<b\\> \\{x\\} a\\|b \\~ \\^ `keep <this> $`',
    );
    expect(toNotionMarkdown('- [PR](https://x.y/1)')).toBe('- [PR](https://x.y/1)');
    expect(daySection('Monday, 19 October 2026', '- a')).toBe(
      '## Monday, 19 October 2026\n- a\n---',
    );
  });
});

describe('NotionPublisher', () => {
  let dir: string;
  let file: string;
  let runs: ClaudeRun[];
  let replies: string[];

  const publisher = (env: NodeJS.ProcessEnv = {}) =>
    new NotionPublisher(file, {
      runClaude: async (run) => {
        runs.push(run);
        return replies.shift() ?? '';
      },
      claudeBinary: 'claude',
      cwd: dir,
      env,
    });
  const config = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const argsOf = (run: ClaudeRun) =>
    JSON.parse(run.input.split('\n').find((l) => l.startsWith('{'))!);
  const withRepo = (dates: string[]) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ pageUrl: HOME, repos: { dispatch: { pageId: PAGE_ID, dates } } }),
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-notion-'));
    file = path.join(dir, 'notion.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ pageUrl: `https://app.notion.com/p/${HOME}`, keep: 1 }),
    );
    runs = [];
    replies = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads notion.json', () => {
    expect(readNotionConfig(file)).toEqual({ homePageId: HOME_ID, repos: {} });
    fs.writeFileSync(file, '{}');
    expect(readNotionConfig(file)).toBeUndefined();
  });

  it('creates a page per new repo under the home page, with only the Notion tools', async () => {
    replies = [`${PAGE_URL}?pvs=204`, 'https://app.notion.com/p/bbbbbbbbccccddddeeeeffffffffffff'];
    expect(await publisher().publish(REPORT)).toBe(`https://app.notion.com/p/${HOME}`);

    expect(runs).toHaveLength(2);
    expect(runs[0].args).toEqual([
      '-p',
      '--tools',
      '',
      '--allowedTools',
      'mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-update-page,mcp__claude_ai_Notion__notion-fetch',
      '--no-session-persistence',
      '--output-format',
      'text',
    ]);
    const args = argsOf(runs[0]);
    expect(args.parent).toEqual({ type: 'page_id', page_id: HOME_ID });
    expect(args.pages[0].properties).toEqual({ title: 'dispatch' });
    expect(args.pages[0].content).toBe(
      daySection(REPORT.title, repoSections(DETAILS, REPORT.repos)[0].body),
    );
    expect(config()).toMatchObject({
      keep: 1,
      repos: {
        dispatch: { pageId: PAGE_ID, dates: ['2026-10-19'] },
        'pixel-agents': { dates: ['2026-10-19'] },
      },
    });
  });

  it('puts a new day at the top of an existing repo page', async () => {
    withRepo(['2026-10-18']);
    replies = ['DONE'];
    await publisher().publish({ ...REPORT, details: DISPATCH_ONLY });
    expect(argsOf(runs[0])).toMatchObject({
      page_id: PAGE_ID,
      command: 'insert_content',
      position: { type: 'start' },
    });
    expect(config().repos.dispatch.dates).toEqual(['2026-10-18', '2026-10-19']);
  });

  it('replaces a day that is already there instead of adding it twice', async () => {
    withRepo(['2026-10-19']);
    replies = ['DONE'];
    await publisher().publish({ ...REPORT, details: DISPATCH_ONLY });
    expect(runs[0].input).toContain('"## Monday, 19 October 2026"');
    expect(runs[0].input).toContain('"update_content"');
    expect(runs[0].input).not.toContain('insert_content');
    expect(config().repos.dispatch.dates).toEqual(['2026-10-19']);
  });

  it('forgets a repo page Notion no longer has, and resolves undefined when nothing was sent', async () => {
    withRepo(['2026-10-18']);
    replies = ['FAILED: page not found'];
    expect(await publisher().publish({ ...REPORT, details: DISPATCH_ONLY })).toBeUndefined();
    expect(config().repos.dispatch).toBeUndefined();
  });

  it('runs nothing when switched off or unconfigured', async () => {
    expect(await publisher({ PIXEL_AGENTS_NOTION: 'off' }).publish(REPORT)).toBeUndefined();
    expect(await publisher({ PIXEL_AGENTS_MANAGER: 'off' }).publish(REPORT)).toBeUndefined();
    fs.rmSync(file);
    expect(await publisher().publish(REPORT)).toBeUndefined();
    expect(runs).toEqual([]);
  });
});
