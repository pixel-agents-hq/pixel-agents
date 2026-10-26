import * as fs from 'fs';

import type { PersistedAgent } from '../../core/src/schemas.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';

/** What the notice readers need from the provider: whether a notice says its
 *  agent is still alive (TeamProvider.isInterimSpawnNotice). */
export type NoticeReader = Pick<TeamProvider, 'isInterimSpawnNotice'> | undefined;

/**
 * A lead's live background spawns, keyed by the tool id they run under: the
 * spawn call's, or the SendMessage call's for an agent revived after a crash.
 * The value carries the agent (task) id the CLI gave the spawn, when it said
 * one — completion notices and transcript names may use it instead of the
 * tool id. A spawn is live exactly while it is in the map.
 */
export type BackgroundSpawns = Map<string, { taskId?: string }>;

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

/** A completion notice's content: an enqueue queue-operation whose string
 *  content names the finished spawns (see completedSpawnToolIds). Anything
 *  else is not a notice. */
export function completionNotice(record: {
  type?: unknown;
  operation?: unknown;
  content?: unknown;
}): string | null {
  if (record.type !== 'queue-operation' || record.operation !== 'enqueue') return null;
  return typeof record.content === 'string' ? record.content : null;
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

/** The live spawns a completion notice (a queue-operation's content) names,
 *  by spawn tool id or by task (agent) id. Ids it names that aren't live are
 *  ignored, and so is a notice the provider calls interim: its agent stopped
 *  to wait on background work of its own and is still alive. The
 *  `<task-notification>` / `<tool-use-id>` / `<task-id>` tags are Claude
 *  Code's notice format (like the file-fallback parser around it). */
export function completedSpawnToolIds(
  spawns: BackgroundSpawns,
  content: string,
  team?: NoticeReader,
): Set<string> {
  const done = new Set<string>();
  // Each notification on its own: an interim one spares only its own agent.
  for (const notice of content.split('<task-notification>')) {
    if (team?.isInterimSpawnNotice?.(notice)) continue;
    for (const m of notice.matchAll(/<tool-use-id>(.*?)<\/tool-use-id>/g)) {
      if (spawns.has(m[1])) done.add(m[1]);
    }
    for (const m of notice.matchAll(/<task-id>(.*?)<\/task-id>/g)) {
      const toolId = spawnToolIdOfTask(spawns, m[1]);
      if (toolId) done.add(toolId);
    }
  }
  return done;
}

/**
 * The persisted spawns that are still live: those whose completion notice is
 * not in the lead's transcript. A spawn's completion is handled in memory as
 * it lands, but a restart before the next save brings the spawn back, and the
 * restored agent reads its transcript from the end, past the notice, so the
 * spawn would never finish. A notice only counts after the spawn's launch: an
 * agent revived later reuses its task id, and an older notice is not its end.
 * An interim notice (see completedSpawnToolIds) ends nothing. An unreadable
 * transcript keeps every spawn.
 */
export function stillRunningSpawns(
  spawns: BackgroundSpawns,
  jsonlFile: string,
  team?: NoticeReader,
): BackgroundSpawns {
  if (spawns.size === 0) return spawns;
  let text: string;
  try {
    text = fs.readFileSync(jsonlFile, 'utf-8');
  } catch {
    return spawns;
  }
  const live: BackgroundSpawns = new Map();
  const launched = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.includes('"queue-operation"')) {
      let notice: string | null;
      try {
        notice = completionNotice(JSON.parse(line) as Parameters<typeof completionNotice>[0]);
      } catch {
        continue;
      }
      if (notice === null) continue;
      for (const toolId of completedSpawnToolIds(live, notice, team)) live.delete(toolId);
      continue;
    }
    for (const [toolId, spawn] of spawns) {
      if (!launched.has(toolId) && line.includes(`"tool_use_id":"${toolId}"`)) {
        launched.add(toolId);
        live.set(toolId, spawn);
      }
    }
  }
  // A spawn whose launch isn't in this transcript: nothing here can end it.
  for (const [toolId, spawn] of spawns) if (!launched.has(toolId)) live.set(toolId, spawn);
  return live;
}
