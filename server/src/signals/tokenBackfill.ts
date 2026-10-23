/**
 * TokenBackfill: the token usage of days the meter wasn't there for, read
 * from the transcripts themselves (docs/office/DESIGN.md, phase G, "Time per
 * repo + CSV").
 *
 * The TokenMeter only counts responses it reads after the board starts, so a
 * day's file holds what the office saw, not what the machine spent. Every
 * transcript under ~/.claude/projects (sessions, and their subagents/) carries
 * the same assistant records -- `message.id`, `message.model`, `message.usage`,
 * `timestamp`, `cwd` -- so a scan rebuilds the whole picture, read-only:
 *  - a file last written before the first day asked for can't hold a record
 *    of it, and is skipped on its mtime alone;
 *  - the rest stream through readline, one line at a time (a transcript can
 *    run to tens of MB), only lines that mention usage parsed;
 *  - each response counts once, at the largest figures any of its records
 *    reported (the meter's rule), on the local day of its timestamp;
 *  - it is attributed to the basename of the record's cwd -- the name the task
 *    log gives the same work (taskLedger.ts repoOf; `unknown` when the record
 *    has none and the file never names one).
 *
 * A closed day is scanned once: its result is cached in the token dir as
 * <date>.<TOKENS_BACKFILL_SUFFIX> (the meter's file shape, repos included) and
 * never re-scanned. Today keeps moving, so its scan is redone when the last one
 * is older than TOKENS_BACKFILL_TODAY_TTL_MS -- from where the last one stopped
 * in each transcript (they are only ever appended to), so a day of hundreds of
 * MB is read once, not every few minutes. The hub folds it into the meter,
 * which is what puts the TODAY strip right (signalsHub.ts). One scan runs at a
 * time; a second ask waits for it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { repoOf } from '../tasks/taskLedger.js';
import { repoNameForCwdOnDisk } from '../transcriptCwd.js';
import {
  TOKENS_BACKFILL_MAX_DEPTH,
  TOKENS_BACKFILL_SUFFIX,
  TOKENS_BACKFILL_TODAY_TTL_MS,
  TOKENS_BACKFILL_YIELD_LINES,
} from './constants.js';
import { localDateKey, startOfLocalDay } from './localDay.js';
import {
  type CountedMessage,
  fromCounted,
  mergeTokens,
  readMessagesFile,
  toCounted,
  usageOf,
  writeMessagesFile,
} from './tokenMeter.js';

export interface TokenBackfillOptions {
  /** The transcripts' root (~/.claude/projects; tests pass a temp dir). */
  projectsDir: string;
  /** Where a closed day's scan is kept (the meter's dir); null keeps it in memory. */
  cacheDir: string | null;
  now: () => number;
}

/** Responses by message id, per date. */
export type ScannedDays = Map<string, Map<string, CountedMessage>>;

/** How far a transcript has been read: the byte after its last whole line, and
 *  the repo its first cwd named (for later records without one). */
export interface ReadMark {
  offset: number;
  fileRepo?: string;
}

export class TokenBackfill {
  /** Closed days read so far (from a scan or the cache file). */
  private readonly closed = new Map<string, Map<string, CountedMessage>>();
  private today: {
    date: string;
    at: number;
    messages: Map<string, CountedMessage>;
    /** Per transcript, how far today's scans have read it. */
    marks: Map<string, ReadMark>;
  } | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: TokenBackfillOptions) {}

  /**
   * The responses of each date asked for: closed days from the cache, scanned
   * once when missing; today scanned afresh past the TTL. Dates with nothing
   * are left out. Never rejects: a scan that fails answers with what it has.
   */
  async usageFor(dates: readonly string[]): Promise<ScannedDays> {
    // One scan at a time: whoever asked first may already be reading our days.
    while (this.running) await this.running;
    const wanted = new Set(dates);
    const needed = [...wanted].filter((date) => !this.have(date));
    if (needed.length > 0 && !this.disposed) {
      this.running = this.scan(needed).finally(() => {
        this.running = null;
      });
      await this.running;
    }
    const result: ScannedDays = new Map();
    for (const date of wanted) {
      const messages = date === this.todayKey() ? this.today?.messages : this.closed.get(date);
      if (messages && messages.size > 0) result.set(date, messages);
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
  }

  // ── What is known ──────────────────────────────────────────

  private todayKey(): string {
    return localDateKey(this.options.now());
  }

  /** Is this date's answer already in hand (or in its cache file)? */
  private have(date: string): boolean {
    if (date === this.todayKey()) {
      return (
        this.today?.date === date &&
        this.options.now() - this.today.at < TOKENS_BACKFILL_TODAY_TTL_MS
      );
    }
    if (date > this.todayKey()) return true; // nothing to read for a day to come
    if (this.closed.has(date)) return true;
    if (this.options.cacheDir === null) return false;
    const file = this.cacheFile(this.options.cacheDir, date);
    if (!fs.existsSync(file)) return false;
    this.closed.set(date, readMessagesFile(file));
    return true;
  }

  private cacheFile(dir: string, date: string): string {
    return path.join(dir, `${date}.${TOKENS_BACKFILL_SUFFIX}`);
  }

  // ── The scan ───────────────────────────────────────────────

  /** Read every transcript that may hold one of these days, then keep the results. */
  private async scan(dates: string[]): Promise<void> {
    const wanted = new Set(dates);
    const found: ScannedDays = new Map();
    const today = this.todayKey();
    if (this.today?.date !== today) {
      this.today = { date: today, at: 0, messages: new Map(), marks: new Map() };
    }
    const state = this.today;
    // Today's responses merge into what earlier scans found (by message id, at
    // the largest figures, so reading a record twice changes nothing).
    if (wanted.has(today)) found.set(today, state.messages);
    // A scan that includes a closed day reads each file from its start anyway;
    // one for today alone resumes each file where the last one stopped.
    const resume = dates.every((date) => date >= today);
    const earliest = startOfLocalDay(dateMs(dates.reduce((a, b) => (a < b ? a : b))));
    try {
      for (const { file, size } of await this.transcriptsSince(earliest)) {
        if (this.disposed) return;
        const mark = resume ? state.marks.get(file) : undefined;
        if (mark && mark.offset === size) continue; // nothing new
        // A file shorter than its mark was replaced: read it again from the top.
        const from = mark && mark.offset < size ? mark : { offset: 0 };
        state.marks.set(file, await scanTranscript(file, wanted, found, from));
      }
    } catch (err) {
      console.warn('[Pixel Agents] Token backfill: reading the transcripts failed:', err);
    }
    for (const date of dates) {
      const messages = found.get(date) ?? new Map<string, CountedMessage>();
      if (date === today) {
        state.at = this.options.now();
      } else if (date < today) {
        this.closed.set(date, messages);
        if (this.options.cacheDir !== null) {
          writeMessagesFile(this.cacheFile(this.options.cacheDir, date), date, messages);
        }
      }
    }
  }

  /** Every .jsonl under the projects dir (sessions and their subagents/) last
   *  written at or after `since`, with its size. */
  private async transcriptsSince(since: number): Promise<{ file: string; size: number }[]> {
    const files: { file: string; size: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // no projects dir yet, or one we may not read
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < TOKENS_BACKFILL_MAX_DEPTH) await walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = await fs.promises.stat(full);
            if (stat.mtimeMs >= since) files.push({ file: full, size: stat.size });
          } catch {
            /* gone between readdir and stat */
          }
        }
      }
    };
    await walk(this.options.projectsDir, 0);
    return files;
  }
}

// ── One transcript ───────────────────────────────────────────

/** Epoch ms of a 'YYYY-MM-DD' at local midnight. */
function dateMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Stream one transcript from `from.offset`, folding each assistant record's
 * usage on a wanted day into `found`. A record's repo is its cwd's repo
 * (repoNameForCwdOnDisk); one without a cwd takes the first the file named, else
 * `unknown`. Malformed lines are skipped. Returns where the next read should
 * start: after the last whole line, so a record still being written at the
 * tail is read whole next time instead of half now.
 */
export async function scanTranscript(
  file: string,
  wanted: ReadonlySet<string>,
  found: ScannedDays,
  from: ReadMark = { offset: 0 },
): Promise<ReadMark> {
  let fileRepo = from.fileRepo;
  let offset = from.offset;
  let lineCount = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf-8', start: from.offset });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // readline also hands over a last line with no newline after it: a record
      // mid-write. Count only lines whose newline the stream has read.
      const end = offset + Buffer.byteLength(line, 'utf-8') + 1;
      if (end > from.offset + stream.bytesRead) break;
      offset = end;
      // Let the board answer between stretches of a long day's transcript.
      if (++lineCount % TOKENS_BACKFILL_YIELD_LINES === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!line.includes('"usage"')) continue;
      let record: { timestamp?: unknown; cwd?: unknown };
      try {
        record = JSON.parse(line) as { timestamp?: unknown; cwd?: unknown };
      } catch {
        continue;
      }
      if (typeof record?.cwd === 'string' && record.cwd) {
        fileRepo ??= repoOf({ directoryName: repoNameForCwdOnDisk(record.cwd) });
      }
      const usage = usageOf(record);
      if (!usage) continue;
      const at = Date.parse(String(record.timestamp ?? ''));
      if (!Number.isFinite(at)) continue;
      const date = localDateKey(at);
      if (!wanted.has(date)) continue;
      const repo =
        typeof record.cwd === 'string' && record.cwd
          ? repoOf({ directoryName: repoNameForCwdOnDisk(record.cwd) })
          : (fileRepo ?? repoOf({}));
      let day = found.get(date);
      if (!day) found.set(date, (day = new Map()));
      const previous = day.get(usage.id);
      day.set(
        usage.id,
        previous
          ? toCounted(
              usage.model,
              mergeTokens(fromCounted(previous).tokens, usage.tokens),
              fromCounted(previous).repo ?? repo,
            )
          : toCounted(usage.model, usage.tokens, repo),
      );
    }
  } catch (err) {
    console.warn(`[Pixel Agents] Token backfill: skipping unreadable transcript ${file}:`, err);
  } finally {
    lines.close();
    stream.destroy();
  }
  return { offset, fileRepo };
}
