/**
 * The Manager's report into Notion: one page per repo under a "Daily status"
 * page, each day's work on top of the days before (newest first).
 *
 * It goes through the user's claude.ai Notion connector -- no integration
 * token. Claude Code headless runs see the connectors of the account they are
 * logged in with, so each change is handed to
 *
 *   claude -p --tools "" --allowedTools <create-pages,update-page,fetch> ...
 *
 * (no built-in tools, only those Notion tools) with the exact tool arguments
 * to pass. The run is a courier: the content is built here.
 *
 * Configured by ~/.pixel-agents/notion.json:
 *
 *   { "pageUrl": "<the Daily status page>",
 *     "repos": { "<repo, lower case>": { "pageId": "…", "dates": ["2026-10-19", …] } } }
 *
 * For each repo in a day's details (one `## <repo>` section each):
 *  - no page yet: a page titled with the repo is created under pageUrl;
 *  - a new day: its section is inserted at the top of the repo's page;
 *  - a day already there (the report was written again): that day's section
 *    is found and replaced.
 * One run per repo, so one failure costs one repo. PIXEL_AGENTS_NOTION=off
 * or PIXEL_AGENTS_MANAGER=off: nothing runs. Failures are logged and
 * swallowed: the dashboard's report never depends on Notion.
 */

import * as fs from 'fs';

import {
  LOCAL_SESSIONS_OFF_VALUES,
  MANAGER_ENABLED_ENV,
  NOTION_CONNECTOR_TIMEOUT_MS,
  NOTION_CONNECTOR_TOOLS,
  NOTION_ENABLED_ENV,
} from '../constants.js';
import type { ClaudeRunner } from './managerReports.js';

/** One day's report as the publisher sends it. */
export interface PublishedReport {
  date: string;
  /** The day's heading in each repo page, e.g. `Monday, 19 October 2026`. */
  title: string;
  /** The day's details: one `## <repo>` section per repo. */
  details: string;
  /** The day's repo names, to tell a repo heading from anything else. */
  repos: string[];
}

/** Sends a report somewhere and resolves with its URL (undefined: not sent). */
export interface ReportPublisher {
  publish(report: PublishedReport): Promise<string | undefined>;
}

export interface RepoPage {
  pageId: string;
  dates: string[];
}

export interface NotionConfig {
  /** The page the repo pages go under. */
  homePageId: string;
  repos: Record<string, RepoPage>;
}

export interface NotionPublisherDeps {
  runClaude: ClaudeRunner;
  claudeBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function isOff(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && (LOCAL_SESSIONS_OFF_VALUES as readonly string[]).includes(v);
}

/** A Notion id from a bare id (dashed or not) or any Notion link to it. */
export function notionIdOf(value: string): string | undefined {
  const hex = value
    .trim()
    .replace(/[?#].*$/, '')
    .match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})$/i)?.[1];
  if (!hex) return undefined;
  const h = hex.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function notionUrl(id: string): string {
  return `https://app.notion.com/p/${id.replace(/-/g, '')}`;
}

/** notion.json, or undefined when it names no page. */
export function readNotionConfig(file: string): NotionConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { pageUrl, repos } = raw as Record<string, unknown>;
  const home = typeof pageUrl === 'string' ? notionIdOf(pageUrl) : undefined;
  if (!home) return undefined;
  const kept: Record<string, RepoPage> = {};
  if (typeof repos === 'object' && repos !== null) {
    for (const [key, entry] of Object.entries(repos as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { pageId, dates } = entry as Record<string, unknown>;
      const id = typeof pageId === 'string' ? notionIdOf(pageId) : undefined;
      if (!id) continue;
      kept[key] = {
        pageId: id,
        dates: Array.isArray(dates) ? dates.filter((d): d is string => typeof d === 'string') : [],
      };
    }
  }
  return { homePageId: home, repos: kept };
}

/** Record (or forget, with undefined) a repo's page, keeping the rest of the file. */
function saveRepo(file: string, key: string, page: RepoPage | undefined): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const repos = { ...((raw.repos as Record<string, unknown> | undefined) ?? {}) };
    if (page) repos[key] = page;
    else delete repos[key];
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...raw, repos }, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[Pixel Agents] Manager: could not record the Notion page:', err);
  }
}

// ── Content ──────────────────────────────────────────────────

/**
 * The details split into one section per repo: each `## <heading>` starts
 * one, named after the day's repo it matches (else the heading itself), its
 * heading line left out. Text before the first heading is dropped.
 */
export function repoSections(
  details: string,
  repos: readonly string[],
): Array<{ repo: string; body: string }> {
  const sections: Array<{ repo: string; lines: string[] }> = [];
  for (const line of details.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const text = heading[1].replace(/[*_`]/g, '').trim();
      const lower = text.toLowerCase();
      const repo =
        repos.find((r) => r.toLowerCase() === lower) ??
        repos.find((r) => lower.startsWith(r.toLowerCase())) ??
        text;
      sections.push({ repo, lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections
    .map((s) => ({ repo: s.repo, body: s.lines.join('\n').trim() }))
    .filter((s) => s.body !== '');
}

// Notion-flavored Markdown treats these as syntax outside code spans.
const SPECIAL = /[$<>{}|^~\\]/g;

/**
 * Report Markdown as Notion-flavored Markdown: list nesting by tabs (two
 * spaces per level), `_italic_` as `*italic*`, special characters escaped
 * outside code spans, blank lines dropped (Notion spaces blocks itself).
 */
export function toNotionMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? '';
      const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
      const body = line
        .slice(indent.length)
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part
                .replace(SPECIAL, (c) => `\\${c}`)
                .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1*$2*'),
        )
        .join('');
      return '\t'.repeat(depth) + body;
    })
    .join('\n');
}

/** One day in a repo's page: its heading, its work, a divider below. */
export function daySection(title: string, body: string): string {
  return [`## ${title}`, toNotionMarkdown(body), '---'].join('\n');
}

// ── The courier ──────────────────────────────────────────────

const TOOL = (name: string) => `mcp__claude_ai_Notion__notion-${name}`;

function courierPrompt(steps: string[], reply: string): string {
  return [
    'You are a courier for an automated daily report. Do the Notion steps below in order. Pass every JSON argument EXACTLY as given -- change, shorten or reformat nothing; string values go through as they are.',
    'If a step fails, stop and reply with "FAILED: " and the reason in one line.',
    `Otherwise ${reply}`,
    '',
    ...steps.map((step, i) => `Step ${i + 1}: ${step}`),
  ].join('\n');
}

function call(tool: string, args: unknown): string {
  return `call ${TOOL(tool)} with\n${JSON.stringify(args)}\n`;
}

function pageUrlOf(text: string): string | undefined {
  return text.match(/https:\/\/(?:app\.notion\.com|www\.notion\.so|notion\.so)\/[^\s)>\]"']+/)?.[0];
}

const succeeded = (out: string) => !/FAILED/i.test(out) && /DONE/.test(out);

export class NotionPublisher implements ReportPublisher {
  constructor(
    private readonly configFile: string,
    private readonly deps: NotionPublisherDeps,
  ) {}

  /** Each repo's section of the day onto its page. Resolves with the home page's URL
   *  when at least one repo page took it. */
  async publish(report: PublishedReport): Promise<string | undefined> {
    if (isOff(this.deps.env[NOTION_ENABLED_ENV]) || isOff(this.deps.env[MANAGER_ENABLED_ENV])) {
      return undefined;
    }
    const config = readNotionConfig(this.configFile);
    if (!config) return undefined;
    let sent = 0;
    for (const { repo, body } of repoSections(report.details, report.repos)) {
      try {
        if (await this.publishRepo(config, report, repo, body)) sent++;
      } catch (err) {
        console.warn(
          `[Pixel Agents] Manager: the Notion run for ${repo} failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`,
        );
      }
    }
    if (sent > 0) {
      console.log(`[Pixel Agents] Manager: ${report.date} report sent to Notion (${sent} repos).`);
    }
    return sent > 0 ? notionUrl(config.homePageId) : undefined;
  }

  private async publishRepo(
    config: NotionConfig,
    report: PublishedReport,
    repo: string,
    body: string,
  ): Promise<boolean> {
    const key = repo.toLowerCase();
    const section = daySection(report.title, body);
    const page = config.repos[key];
    const warn = (what: string, out: string) =>
      console.warn(
        `[Pixel Agents] Manager: ${what} for ${repo} failed (${out.trim().slice(0, 200)}).`,
      );

    if (page && page.dates.includes(report.date)) {
      const out = await this.run(
        courierPrompt(
          [
            call('fetch', { id: page.pageId }),
            `In the fetched content, find the section that starts at the line "## ${report.title}" and runs up to and including the first line after it that is exactly "---". Copy it exactly as fetched.`,
            `call ${TOOL('update-page')} with page_id "${page.pageId}", command "update_content" and content_updates [{"old_str": <the section you copied>, "new_str": <the string below>}]. The new_str is this JSON string, decoded:\n${JSON.stringify(section)}\n`,
          ],
          'reply with only the word DONE.',
        ),
      );
      if (succeeded(out)) return true;
      warn('replacing the day', out);
      return false;
    }

    if (page) {
      const out = await this.run(
        courierPrompt(
          [
            call('update-page', {
              page_id: page.pageId,
              command: 'insert_content',
              position: { type: 'start' },
              content: section,
              allow_async: false,
            }),
          ],
          'reply with only the word DONE.',
        ),
      );
      if (succeeded(out)) {
        saveRepo(this.configFile, key, { ...page, dates: [...page.dates, report.date] });
        return true;
      }
      warn('adding the day', out);
      // The page may be gone (deleted in Notion): start it again next time.
      if (/not found|no longer|archived|deleted|does not exist/i.test(out)) {
        saveRepo(this.configFile, key, undefined);
      }
      return false;
    }

    const out = await this.run(
      courierPrompt(
        [
          call('create-pages', {
            parent: { type: 'page_id', page_id: config.homePageId },
            allow_async: false,
            pages: [{ icon: '📁', properties: { title: repo }, content: section }],
          }),
        ],
        'reply with only the URL of the page it created.',
      ),
    );
    const url = pageUrlOf(out);
    const pageId = url ? notionIdOf(url) : undefined;
    if (!pageId || /FAILED/i.test(out)) {
      warn('creating the page', out);
      return false;
    }
    saveRepo(this.configFile, key, { pageId, dates: [report.date] });
    return true;
  }

  private run(prompt: string): Promise<string> {
    return this.deps.runClaude({
      file: this.deps.claudeBinary,
      args: [
        '-p',
        '--tools',
        '',
        '--allowedTools',
        NOTION_CONNECTOR_TOOLS.map(TOOL).join(','),
        '--no-session-persistence',
        '--output-format',
        'text',
      ],
      input: prompt,
      cwd: this.deps.cwd,
      timeout: NOTION_CONNECTOR_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  }
}
