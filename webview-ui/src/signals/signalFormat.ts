/**
 * Text for the signals UI, as pure rules (DOM-free, Node-tested): the TODAY
 * strip's token meter, the timeline card's rows and the notice board's lines.
 */

import type {
  DailyTokens,
  NoticeItem,
  TimelineEntry,
  TimelineKind,
} from '../../../core/src/messages.js';
import { TILE_SIZE } from '../constants.js';

/** 950 → "950", 1234 → "1.2k", 1_234_567 → "1.2M", 3.4e9 → "3.4B". */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (v >= size) {
      const scaled = v / size;
      const text = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1);
      return `${text.replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(v);
}

/** "$3.40", "<$0.01", "$1,234". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

/** Every token today: input, output, cache reads and cache writes. */
export function totalTokens(t: DailyTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/**
 * The TODAY strip's meter: "🔤 1.2M tok · ~$3.40 est.". The figure is always
 * labelled an estimate (API list prices; a subscription isn't billed per token);
 * "+" when some model had no price. Without any priced model, tokens only.
 */
export function tokenMeterText(t: DailyTokens): string {
  const tokens = `🔤 ${formatTokenCount(totalTokens(t))} tok`;
  if (t.estimatedUsd === undefined) return tokens;
  return `${tokens} · ~${formatUsd(t.estimatedUsd)}${t.partialEstimate ? '+' : ''} est.`;
}

/** The meter's tooltip: the split, and each model's share. */
export function tokenMeterTitle(t: DailyTokens): string {
  const lines = [
    `Today: ${formatTokenCount(t.input)} in, ${formatTokenCount(t.output)} out, ` +
      `${formatTokenCount(t.cacheRead)} cache read, ${formatTokenCount(t.cacheWrite)} cache write`,
  ];
  const models = Object.entries(t.byModel).sort(
    ([, a], [, b]) =>
      b.input +
      b.output +
      b.cacheRead +
      b.cacheWrite -
      (a.input + a.output + a.cacheRead + a.cacheWrite),
  );
  for (const [model, m] of models) {
    const usd = m.estimatedUsd !== undefined ? ` · ~${formatUsd(m.estimatedUsd)}` : ' · no price';
    lines.push(
      `${model}: ${formatTokenCount(m.input + m.output + m.cacheRead + m.cacheWrite)} tok${usd}`,
    );
  }
  lines.push('Estimated at API list prices; a subscription is not billed per token.');
  return lines.join('\n');
}

const KIND_ICONS: Record<TimelineKind, string> = {
  tool: '🔧',
  status: '•',
  ship: '🚢',
  pr: '🏆',
  push: '📦',
};

/** A timeline row's icon: ❌ for a failed tool. */
export function timelineIcon(entry: TimelineEntry): string {
  return entry.failed ? '❌' : KIND_ICONS[entry.kind];
}

/** Local wall-clock time of an entry, HH:MM. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "45m", "2h 05m": time worked today. */
export function formatWorked(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Newest first, the card shows at most `max` rows. */
export function timelineRows(entries: readonly TimelineEntry[], max: number): TimelineEntry[] {
  return [...entries].reverse().slice(0, max);
}

/** The notice board sprite's lines: "PR web: Fix login", "# app: Crash". */
export function noticeLines(items: readonly NoticeItem[], max: number): string[] {
  return items.slice(0, max).map((item) => {
    const repo = item.repo.split('/').pop() ?? item.repo;
    return `${item.kind === 'pr' ? 'PR' : '#'} ${repo}: ${item.title}`;
  });
}

/**
 * The extra label line an agent's signals add: "🚨 stuck?" at the alarm (three
 * failures in a row), "🌀 going in circles?" while it loops; undefined for none.
 */
export function signalLabel(
  trouble: { level: 'fire' | 'alarm' } | undefined,
  looping: boolean,
  texts: { stuck: string; loop: string },
): string | undefined {
  const parts: string[] = [];
  if (trouble?.level === 'alarm') parts.push(texts.stuck);
  if (looping) parts.push(texts.loop);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Where the desktop timeline card goes: beside the character (right, or left
 * when the right would run off the office), its top a little above the
 * character's feet -- below the status label -- and kept inside the office with
 * a small margin. CSS px within the office region.
 */
export function timelineCardPosition(p: {
  charX: number;
  charY: number;
  containerW: number;
  containerH: number;
  cardW: number;
  cardH: number;
  gap: number;
  /** How far above the feet (charY) the card's top sits. */
  above?: number;
  margin?: number;
}): { left: number; top: number } {
  const margin = p.margin ?? 8;
  let left = p.charX + p.gap;
  if (left + p.cardW > p.containerW - margin) left = p.charX - p.gap - p.cardW;
  left = Math.max(margin, Math.min(left, p.containerW - p.cardW - margin));
  const top = Math.max(
    margin,
    Math.min(p.charY - (p.above ?? 16), p.containerH - p.cardH - margin),
  );
  return { left, top };
}

/** World-px rectangles (sprite top-left, size) of every notice board on the layout. */
export function noticeBoardRects(
  furniture: ReadonlyArray<{ uid: string; type: string; col: number; row: number }>,
  type: string,
  size: { w: number; h: number } = { w: 32, h: 32 },
): Array<{ uid: string; x: number; y: number; w: number; h: number }> {
  return furniture
    .filter((f) => f.type === type)
    .map((f) => ({ uid: f.uid, x: f.col * TILE_SIZE, y: f.row * TILE_SIZE, w: size.w, h: size.h }));
}
