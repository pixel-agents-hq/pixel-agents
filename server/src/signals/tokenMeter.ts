/**
 * TokenMeter: today's token usage, summed from the `message.usage` of transcript
 * assistant records, per model, with a list-price estimate (pricing.ts).
 *
 * One API response is written as several records (one per content block), each
 * carrying the response's usage, so records are keyed by `message.id` and a
 * response counts once -- at the largest figures any of its records reported
 * (a streamed record may carry partial output). The per-response figures are
 * what gets persisted, in ~/.pixel-agents/tokens/<YYYY-MM-DD>.json, so a
 * restart that re-reads a transcript can't count anything twice. Records from
 * another local day, synthetic records and all-zero usage are skipped.
 *
 * Each response also keeps the repo of the agent whose transcript it came from
 * (the office's name for its directory, as the task log uses it), so the time
 * report (tasks/timeReport.ts) can split a day's tokens by repo. Files written
 * before that (version 1) have no repo: they still read, and their responses
 * count as unattributed. usageFor(date) hands either kind to the report.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DailyTokens, ModelTokens } from '../../../core/src/messages.js';
import { TOKENS_SAVE_DEBOUNCE_MS } from './constants.js';
import { localDateKey } from './localDay.js';
import { hasPrice, messageCostUsd, type MessageTokens } from './pricing.js';

export interface TokenMeterOptions {
  /** Where the per-day files live; null keeps everything in memory. */
  dir: string | null;
  now: () => number;
  /** Called with the new totals whenever they change. */
  onChange: (message: DailyTokens) => void;
}

/** One response as counted: model, its token figures, then (version 2) its repo. */
export type CountedMessage = [
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  fast: number,
  repo?: string,
];

interface TokensFile {
  /** 1: no repo per message; 2: a repo ('' when unknown) after the figures. */
  version: 1 | 2;
  date: string;
  /** message id -> [model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, fast(0|1), repo] */
  messages: Record<string, CountedMessage>;
}

/** One response as the time report sees it: the repo it was attributed to, if any. */
export interface UsageEntry {
  repo?: string;
  model: string;
  tokens: MessageTokens;
}

interface UsageRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: Record<string, unknown>;
  };
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

/** The token figures an assistant record reports, or null when it reports none. */
export function usageOf(
  record: unknown,
): { id: string; model: string; tokens: MessageTokens } | null {
  const r = record as UsageRecord | null;
  if (!r || r.type !== 'assistant') return null;
  const message = r.message;
  const usage = message?.usage;
  if (!message || !usage || typeof usage !== 'object') return null;
  if (typeof message.id !== 'string' || !message.id) return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (!model || model.startsWith('<')) return null; // "<synthetic>": no API call
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation as Record<string, unknown> | undefined;
  const write1h = Math.min(cacheWrite, num(breakdown?.ephemeral_1h_input_tokens));
  const tokens: MessageTokens = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: cacheWrite - write1h,
    cacheWrite1h: write1h,
    fast: usage.speed === 'fast',
  };
  const total =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  return total > 0 ? { id: message.id, model, tokens } : null;
}

/** A response at the largest figures either report gave (a streamed record may
 *  carry partial output), fast if either said so. */
export function mergeTokens(before: MessageTokens, next: MessageTokens): MessageTokens {
  return {
    input: Math.max(before.input, next.input),
    output: Math.max(before.output, next.output),
    cacheRead: Math.max(before.cacheRead, next.cacheRead),
    cacheWrite5m: Math.max(before.cacheWrite5m, next.cacheWrite5m),
    cacheWrite1h: Math.max(before.cacheWrite1h, next.cacheWrite1h),
    fast: before.fast || next.fast,
  };
}

/** Two counts of the same response (the meter's and a scan's) as one: the
 *  largest figures, and whichever repo is known. */
export function mergeCounted(a: CountedMessage, b: CountedMessage): CountedMessage {
  const ea = fromCounted(a);
  const eb = fromCounted(b);
  return toCounted(ea.model, mergeTokens(ea.tokens, eb.tokens), ea.repo ?? eb.repo);
}

function sameTokens(a: MessageTokens, b: MessageTokens): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite5m === b.cacheWrite5m &&
    a.cacheWrite1h === b.cacheWrite1h &&
    (a.fast ?? false) === (b.fast ?? false)
  );
}

export function toCounted(
  model: string,
  t: MessageTokens,
  repo: string | undefined,
): CountedMessage {
  return [
    model,
    t.input,
    t.output,
    t.cacheRead,
    t.cacheWrite5m,
    t.cacheWrite1h,
    t.fast ? 1 : 0,
    repo ?? '',
  ];
}

export function fromCounted(c: CountedMessage): UsageEntry {
  const [
    model,
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite5m = 0,
    cacheWrite1h = 0,
    fast = 0,
    repo = '',
  ] = c;
  return {
    ...(repo ? { repo } : {}),
    model,
    tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, fast: fast === 1 },
  };
}

interface Day {
  date: string;
  messages: Map<string, CountedMessage>;
}

export class TokenMeter {
  private day: Day | undefined;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Inside batch(): onChange is held back, and this says whether to fire it after. */
  private batching: { changed: boolean } | null = null;

  constructor(private readonly options: TokenMeterOptions) {}

  /** Many records at once (the transcript backfill): one onChange at the end
   *  instead of one per record. */
  batch(fn: () => void): void {
    if (this.batching) {
      fn();
      return;
    }
    this.batching = { changed: false };
    try {
      fn();
    } finally {
      const { changed } = this.batching;
      this.batching = null;
      if (changed && !this.disposed) this.options.onChange(this.message());
    }
  }

  /** Fold one transcript record in, attributed to `repo` (the agent's, when
   *  known); true when today's totals changed. */
  record(record: unknown, repo?: string): boolean {
    if (this.disposed) return false;
    const usage = usageOf(record);
    if (!usage) return false;
    const now = this.options.now();
    const at = Date.parse(String((record as UsageRecord).timestamp ?? ''));
    const day = this.today(now);
    // A record from another day (a transcript re-read after midnight, or an old
    // session's tail) is not today's spend.
    if (Number.isFinite(at) && localDateKey(at) !== day.date) return false;
    return this.fold(day, usage.id, usage.model, usage.tokens, repo);
  }

  /** A response of today's the transcript backfill read (tokenBackfill.ts),
   *  folded in like record() -- the scan already bucketed it by local day. */
  absorb(id: string, entry: UsageEntry): boolean {
    if (this.disposed) return false;
    const day = this.today(this.options.now());
    return this.fold(day, id, entry.model, entry.tokens, entry.repo);
  }

  /** A day's responses by message id: today's from memory, another day's from
   *  its file. A missing or unreadable day, or an in-memory meter asked about
   *  another day, is empty. */
  messagesFor(date: string): ReadonlyMap<string, CountedMessage> {
    const today = this.today(this.options.now());
    return date === today.date ? today.messages : this.readDay(date);
  }

  /** A day's responses for the time report (messagesFor, without the ids). */
  usageFor(date: string): UsageEntry[] {
    return [...this.messagesFor(date).values()].map(fromCounted);
  }

  /** One response into the day, at the largest figures seen; true when anything changed. */
  private fold(
    day: Day,
    id: string,
    model: string,
    tokens: MessageTokens,
    repo: string | undefined,
  ): boolean {
    const previous = day.messages.get(id);
    let next = tokens;
    if (previous) {
      const { repo: knownRepo, tokens: before } = fromCounted(previous);
      // A response keeps its repo once it has one (a re-read after an upgrade
      // may add it to a response counted without).
      repo ??= knownRepo;
      next = mergeTokens(before, next);
      if (sameTokens(next, before) && repo === knownRepo) return false;
    }
    day.messages.set(id, toCounted(model, next, repo));
    this.changed();
    return true;
  }

  /** Today's totals, as sent to clients. */
  message(): DailyTokens {
    const day = this.today(this.options.now());
    const byModel: Record<string, ModelTokens> = {};
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let usd = 0;
    let priced = false;
    let unpriced = false;
    for (const counted of day.messages.values()) {
      const { model, tokens } = fromCounted(counted);
      const entry = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const cacheWrite = tokens.cacheWrite5m + tokens.cacheWrite1h;
      entry.input += tokens.input;
      entry.output += tokens.output;
      entry.cacheRead += tokens.cacheRead;
      entry.cacheWrite += cacheWrite;
      totals.input += tokens.input;
      totals.output += tokens.output;
      totals.cacheRead += tokens.cacheRead;
      totals.cacheWrite += cacheWrite;
      const cost = messageCostUsd(model, tokens);
      if (cost === undefined) {
        unpriced = true;
        continue;
      }
      priced = true;
      usd += cost;
      entry.estimatedUsd = (entry.estimatedUsd ?? 0) + cost;
    }
    for (const [model, entry] of Object.entries(byModel)) {
      if (!hasPrice(model)) delete entry.estimatedUsd;
      else if (entry.estimatedUsd !== undefined) entry.estimatedUsd = round4(entry.estimatedUsd);
    }
    return {
      type: 'dailyTokens',
      date: day.date,
      ...totals,
      byModel,
      ...(priced ? { estimatedUsd: round4(usd) } : {}),
      ...(priced && unpriced ? { partialEstimate: true } : {}),
    };
  }

  /** Write any unsaved figures and stop. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private today(now: number): Day {
    const date = localDateKey(now);
    if (this.day?.date === date) return this.day;
    const rollover = this.day !== undefined;
    if (rollover) this.flush();
    this.day = { date, messages: this.readDay(date) };
    if (rollover) this.options.onChange(this.message());
    return this.day;
  }

  private changed(): void {
    if (this.batching) this.batching.changed = true;
    else this.options.onChange(this.message());
    this.dirty = true;
    if (this.options.dir === null || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, TOKENS_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.day || this.options.dir === null) return;
    this.dirty = !this.writeDay(this.options.dir, this.day);
  }

  private fileFor(dir: string, date: string): string {
    return path.join(dir, `${date}.json`);
  }

  private readDay(date: string): Map<string, CountedMessage> {
    if (this.options.dir === null) return new Map();
    return readMessagesFile(this.fileFor(this.options.dir, date));
  }

  private writeDay(dir: string, day: Day): boolean {
    return writeMessagesFile(this.fileFor(dir, day.date), day.date, day.messages);
  }
}

// ── Files ────────────────────────────────────────────────────

/**
 * A per-day messages file (the meter's own, or a backfill cache): message id
 * -> counted response. Version 1 entries have no repo. A missing file is
 * empty; an unreadable one is logged and empty.
 */
export function readMessagesFile(file: string): Map<string, CountedMessage> {
  const messages = new Map<string, CountedMessage>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TokensFile>;
    const stored = raw && typeof raw.messages === 'object' && raw.messages ? raw.messages : {};
    for (const [id, entry] of Object.entries(stored)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      // Six figures, then (version 2) the repo; a version 1 entry ends at the figures.
      const [input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, fast = 0] =
        entry.slice(1, 7).map(num);
      const repo = typeof entry[7] === 'string' ? entry[7] : '';
      messages.set(id, [
        entry[0],
        input,
        output,
        cacheRead,
        cacheWrite5m,
        cacheWrite1h,
        fast,
        repo,
      ]);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[Pixel Agents] Ignoring unreadable token totals ${file}:`, err);
    }
  }
  return messages;
}

/** Atomic write (tmp + rename). Returns false, logged, on failure. */
export function writeMessagesFile(
  file: string,
  date: string,
  messages: ReadonlyMap<string, CountedMessage>,
): boolean {
  const data: TokensFile = { version: 2, date, messages: Object.fromEntries(messages) };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Failed to write token totals ${file}:`, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
