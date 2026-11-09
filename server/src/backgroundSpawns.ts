import * as fs from 'fs';

import type { PersistedAgent } from '../../core/src/schemas.js';
import type { SpawnNotice, TeamProvider } from '../../core/src/teamProvider.js';
import { PAUSED_SPAWN_END_MS, PAUSED_SPAWN_WRITE_SLACK_MS } from './constants.js';

/** What the notice readers need from the provider: the notices a transcript
 *  record carries, and the tool results it answers (TeamProvider). */
export type NoticeReader = Pick<TeamProvider, 'readSpawnNotices' | 'toolResultIds'> | undefined;

/**
 * A lead's live background spawns, keyed by the tool id they run under: the
 * spawn call's, or the SendMessage call's for an agent revived after a crash.
 * The value carries the agent (task) id the CLI gave the spawn, when it said
 * one — completion notices and transcript names may use it instead of the
 * tool id. A spawn is live exactly while it is in the map. `pausedAt` (ms) is
 * set while its last notice was an interim one (see readCompletionNotice);
 * never persisted — a restore re-reads it from the notices.
 */
export type BackgroundSpawns = Map<string, { taskId?: string; pausedAt?: number }>;

/** The tool id of the live spawn the CLI knows as `taskId`, if any. */
export function spawnToolIdOfTask(spawns: BackgroundSpawns, taskId: string): string | undefined {
  for (const [toolId, spawn] of spawns) {
    if (spawn.taskId === taskId) return toolId;
  }
  return undefined;
}

/**
 * Record a launched background agent under the tool id it runs by. A result
 * naming an agent (task id) that is already live starts nothing: returns
 * false and leaves the map alone.
 */
export function launchSpawn(spawns: BackgroundSpawns, toolId: string, taskId?: string): boolean {
  if (taskId && spawnToolIdOfTask(spawns, taskId)) return false;
  spawns.set(toolId, { taskId });
  return true;
}

/** How a lead's live spawn is taken once its sidecar shows up (CONTEXT.md:
 *  the name is the sole Sub-agent vs Teammate distinction). */
export function classifySpawn(
  lead: { backgroundSpawns: BackgroundSpawns; teammateSpawnToolIds?: ReadonlySet<string> },
  spawnToolId: string,
  named: boolean,
): 'wait' | 'subagent' | 'teammate' {
  const launched = lead.backgroundSpawns.has(spawnToolId);
  // A named spawn call is a Teammate-to-be, but its sidecar can land before
  // its "Async agent launched" result. Deciding now would take it for
  // in-turn work and watch it as a Sub-agent for good. Wait: the result's
  // arrival rescans.
  if (!launched && lead.teammateSpawnToolIds?.has(spawnToolId)) return 'wait';
  // Foreground spawns (Agent run_in_background:false — the tool stays open
  // for the whole run) write the same sidecar shape. They are within-turn
  // work whatever the sidecar says: watch them, never seat them. Unnamed
  // background spawns are Sub-agents too; only a named launched one is a
  // Teammate.
  return named && launched ? 'teammate' : 'subagent';
}

/** The persisted form: omitted when there is nothing live. */
export function persistBackgroundSpawns(
  spawns: BackgroundSpawns,
): PersistedAgent['backgroundSpawns'] {
  if (spawns.size === 0) return undefined;
  return [...spawns].map(([toolId, { taskId }]) => (taskId ? { toolId, taskId } : { toolId }));
}

/** Rebuild the map from what was persisted, including the bare tool-id list
 *  releases up to v1.5.x wrote. */
export function restoreBackgroundSpawns(p: PersistedAgent): BackgroundSpawns {
  const spawns: BackgroundSpawns = new Map();
  for (const toolId of p.backgroundAgentToolIds ?? []) spawns.set(toolId, {});
  for (const { toolId, taskId } of p.backgroundSpawns ?? []) spawns.set(toolId, { taskId });
  return spawns;
}

/** The live spawns completion notices (TeamProvider.readSpawnNotices) name,
 *  by spawn tool id or by task (agent) id, split by what they say of them:
 *  `ended`, or only `paused` — an interim notice, whose agent stopped to wait
 *  on background work of its own and may resume. Ids they name that aren't
 *  live are ignored. */
export function readCompletionNotices(
  spawns: BackgroundSpawns,
  notices: readonly SpawnNotice[],
): { ended: Set<string>; paused: Set<string> } {
  const ended = new Set<string>();
  const paused = new Set<string>();
  // Each notice on its own: an interim one spares only its own agent.
  for (const notice of notices) {
    const named = notice.interim ? paused : ended;
    for (const toolId of notice.toolIds) if (spawns.has(toolId)) named.add(toolId);
    for (const taskId of notice.taskIds) {
      const toolId = spawnToolIdOfTask(spawns, taskId);
      if (toolId) named.add(toolId);
    }
  }
  for (const toolId of ended) paused.delete(toolId);
  return { ended, paused };
}

/**
 * A paused spawn (see readCompletionNotice), judged by its own transcript's
 * last write: `resumed` when it was written after the notice (it will notify
 * again when it stops), `ended` when it has stayed quiet for
 * PAUSED_SPAWN_END_MS — the CLI may call every stop interim and never
 * notify again — else still `paused`. No transcript counts as quiet.
 */
export function pausedSpawnFate(
  pausedAt: number,
  transcriptWrittenAt: number | undefined,
  now: number,
): 'resumed' | 'paused' | 'ended' {
  if (
    transcriptWrittenAt !== undefined &&
    transcriptWrittenAt > pausedAt + PAUSED_SPAWN_WRITE_SLACK_MS
  )
    return 'resumed';
  return now - pausedAt >= PAUSED_SPAWN_END_MS ? 'ended' : 'paused';
}

/**
 * The persisted spawns that are still live: those whose completion notice is
 * not in the lead's transcript (both read through the provider, `team`). A spawn's completion is handled in memory as
 * it lands, but a restart before the next save brings the spawn back, and the
 * restored agent reads its transcript from the end, past the notice, so the
 * spawn would never finish. A notice only counts after the spawn's launch: an
 * agent revived later reuses its task id, and an older notice is not its end.
 * An interim notice (see readCompletionNotice) ends nothing: it leaves the
 * spawn paused since the notice, for pausedSpawnFate to judge. An unreadable
 * transcript, or a provider that reads no notices, keeps every spawn.
 */
export function stillRunningSpawns(
  spawns: BackgroundSpawns,
  jsonlFile: string,
  team?: NoticeReader,
): BackgroundSpawns {
  if (spawns.size === 0 || !team?.readSpawnNotices || !team.toolResultIds) return spawns;
  let text: string;
  try {
    text = fs.readFileSync(jsonlFile, 'utf-8');
  } catch {
    return spawns;
  }
  const live: BackgroundSpawns = new Map();
  const launched = new Set<string>();
  // Only a record naming one of the spawns can launch or end it: skip the
  // rest unparsed (a transcript runs to many MB).
  const ids = [...spawns].flatMap(([toolId, { taskId }]) => (taskId ? [toolId, taskId] : [toolId]));
  for (const line of text.split('\n')) {
    if (!ids.some((id) => line.includes(id))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const read = team.readSpawnNotices(record);
    if (read) {
      const { ended, paused } = readCompletionNotices(live, read.notices);
      for (const toolId of ended) live.delete(toolId);
      const pausedAt = read.at ?? Date.now();
      for (const toolId of paused) live.set(toolId, { ...live.get(toolId), pausedAt });
      continue;
    }
    for (const toolId of team.toolResultIds(record)) {
      const spawn = spawns.get(toolId);
      if (spawn && !launched.has(toolId)) {
        launched.add(toolId);
        live.set(toolId, { taskId: spawn.taskId });
      }
    }
  }
  // A spawn whose launch isn't in this transcript: nothing here can end it.
  for (const [toolId, spawn] of spawns) if (!launched.has(toolId)) live.set(toolId, spawn);
  return live;
}
