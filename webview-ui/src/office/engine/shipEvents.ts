/**
 * Living office, phase B (docs/office/DESIGN.md "B. Celebrations"): what is
 * new in a `dailyStats` — a PR opened, a push landed — and who shipped it.
 *
 * The server only says THAT a push or PR happened (per repo), not which agent
 * did it, so the client attributes it: the agent that just ran a matching
 * ship command (`git push`, `gh pr create`), else an agent in that repo, else
 * the most recently active one. Pure and DOM-free (Node-tested).
 */

import type { DailyPr, DailyStats } from '../../../../core/src/messages.js';
import { SHIP_ATTRIBUTION_WINDOW_MS } from '../../constants.js';

export type ShipKind = 'pr' | 'push';

/** One thing to celebrate. */
export interface ShipEvent {
  kind: ShipKind;
  repo: string;
  /** PR title (kind 'pr'). */
  title?: string;
  /** Pushes this event stands for (kind 'push'; a repo's count can jump by several). */
  count: number;
}

/** What a day's stats already showed: the baseline new events are measured against. */
export interface ShipTally {
  date: string;
  /** Every identity of every PR seen (url and title+time), so a PR re-sent with
   *  its url filled in later still counts as seen. */
  prKeys: Set<string>;
  /** Distinct PRs seen. */
  prCount: number;
  /** Push count per repo. */
  pushes: Map<string, number>;
  /** Pushes across all repos. */
  pushCount: number;
}

/** A PR's identities: its url when known, and title + time. */
export function prKeys(pr: DailyPr): string[] {
  const keys = [`t:${pr.repo}\u0000${pr.title}\u0000${pr.at}`];
  if (pr.url) keys.push(`u:${pr.url}`);
  return keys;
}

/** The PRs in `prs` not already seen (by any identity), deduplicated among themselves. */
function freshPrs(prs: readonly DailyPr[], seen: Set<string>): DailyPr[] {
  const fresh: DailyPr[] = [];
  for (const pr of prs) {
    const keys = prKeys(pr);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    fresh.push(pr);
  }
  return fresh;
}

function pushCountOf(count: unknown): number {
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** The tally a day's stats show. */
export function tallyOf(stats: DailyStats): ShipTally {
  const prKeySet = new Set<string>();
  const prCount = freshPrs(stats.prs, prKeySet).length;
  const pushes = new Map<string, number>();
  let pushCount = 0;
  for (const p of stats.pushes) {
    const n = pushCountOf(p.count);
    if (n === 0) continue;
    pushes.set(p.repo, (pushes.get(p.repo) ?? 0) + n);
    pushCount += n;
  }
  return { date: stats.date, prKeys: prKeySet, prCount, pushes, pushCount };
}

/**
 * What `stats` adds over the last tally. No baseline yet (the first stats
 * after a load) means nothing is new — a reload must not replay the day's
 * celebrations. A new date (midnight) is measured against an empty day.
 */
export function newShipEvents(prev: ShipTally | null, stats: DailyStats): ShipEvent[] {
  if (!prev) return [];
  const sameDay = prev.date === stats.date;
  const events: ShipEvent[] = [];
  const seen = new Set(sameDay ? prev.prKeys : []);
  for (const pr of freshPrs(stats.prs, seen)) {
    events.push({ kind: 'pr', repo: pr.repo, title: pr.title, count: 1 });
  }
  const next = tallyOf(stats).pushes;
  for (const [repo, count] of next) {
    const before = sameDay ? (prev.pushes.get(repo) ?? 0) : 0;
    if (count > before) events.push({ kind: 'push', repo, count: count - before });
  }
  return events;
}

const GIT_PUSH_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+(?:create|new)\b/;

/** Which ship commands a tool's status line runs ("Running: git push -u origin x"). */
export function classifyShipCommand(status: string): { push: boolean; pr: boolean } {
  return { push: GIT_PUSH_RE.test(status), pr: GH_PR_CREATE_RE.test(status) };
}

/** Per agent: when it last started a tool, and its last ship command. */
export interface ShipSignal {
  lastToolAt: number;
  ship?: { push: boolean; pr: boolean; at: number };
}

/** Record a tool start into an agent's signal (returns the updated signal). */
export function noteShipTool(
  prev: ShipSignal | undefined,
  status: string,
  nowMs: number,
): ShipSignal {
  const kinds = classifyShipCommand(status);
  const next: ShipSignal = { lastToolAt: nowMs, ship: prev?.ship };
  if (kinds.push || kinds.pr) next.ship = { ...kinds, at: nowMs };
  return next;
}

/** An agent a ship event can be attributed to. */
export interface ShipCandidate {
  id: number;
  /** Its repo (the Directory name the server also files pushes under). */
  repo?: string;
}

function repoName(repo: string): string {
  const parts = repo.trim().toLowerCase().split('/');
  return parts[parts.length - 1] ?? '';
}

/** Same repo? PR repos may come as `owner/repo`; agents carry the bare folder name. */
export function sameRepo(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = repoName(a);
  return x !== '' && x === repoName(b);
}

/**
 * Who shipped `event`: the agent whose latest ship command (within
 * SHIP_ATTRIBUTION_WINDOW_MS) matches it — same repo first, then the most
 * recent — else the most recently active agent in that repo, else the most
 * recently active agent at all. null when there is nobody to credit.
 */
export function attributeShip(
  event: ShipEvent,
  candidates: readonly ShipCandidate[],
  signals: ReadonlyMap<number, ShipSignal>,
  nowMs: number,
): number | null {
  let best: { id: number; repo: boolean; at: number } | null = null;
  for (const c of candidates) {
    const ship = signals.get(c.id)?.ship;
    if (!ship || !ship[event.kind] || nowMs - ship.at > SHIP_ATTRIBUTION_WINDOW_MS) continue;
    const repo = sameRepo(event.repo, c.repo);
    if (!best || (repo && !best.repo) || (repo === best.repo && ship.at > best.at)) {
      best = { id: c.id, repo, at: ship.at };
    }
  }
  if (best) return best.id;

  const mostRecent = (list: readonly ShipCandidate[]): number | null => {
    let pick: { id: number; at: number } | null = null;
    for (const c of list) {
      const at = signals.get(c.id)?.lastToolAt ?? -Infinity;
      if (!pick || at > pick.at) pick = { id: c.id, at };
    }
    return pick ? pick.id : null;
  };
  const inRepo = candidates.filter((c) => sameRepo(event.repo, c.repo));
  if (inRepo.length > 0) return mostRecent(inRepo);
  return mostRecent(candidates.filter((c) => signals.has(c.id)));
}
