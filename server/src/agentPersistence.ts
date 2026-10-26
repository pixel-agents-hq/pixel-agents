import * as path from 'path';

import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AgentStateInit } from './agentState.js';
import {
  persistBackgroundSpawns,
  restoreBackgroundSpawns,
  stillRunningSpawns,
} from './backgroundSpawns.js';
import { getHookProvider } from './transcriptParser.js';
import type { AgentState } from './types.js';

/**
 * The two halves of agent persistence, shared by every surface: what of an
 * agent survives a reload, and what a restored agent starts from. Adding a
 * persisted field is an edit here and in core's PersistedAgent, nowhere else.
 */

/** The persisted form of an agent, or null for a background-spawn child:
 *  derived state the 1 s scan re-materializes from sidecars after a restore.
 *  Persisting one would resurrect an immortal character whose completion
 *  signal never comes. */
export function toPersistedAgent(agent: AgentState): PersistedAgent | null {
  if (agent.spawnToolUseId) return null;
  return {
    id: agent.id,
    sessionId: agent.sessionId,
    terminalName: agent.terminalRef?.name ?? '',
    isExternal: agent.isExternal || undefined,
    jsonlFile: agent.jsonlFile,
    projectDir: agent.projectDir,
    directoryName: agent.directoryName,
    teamName: agent.teamName,
    agentName: agent.agentName,
    isTeamLead: agent.isTeamLead,
    leadAgentId: agent.leadAgentId,
    teamUsesTmux: agent.teamUsesTmux,
    backgroundSpawns: persistBackgroundSpawns(agent.backgroundSpawns),
    palette: agent.palette,
    repeat: agent.repeat,
  };
}

/** Whether a persisted entry is a background-spawn child (a leadAgentId but no
 *  teamName). Never restored directly; this also skips stale entries written by
 *  older builds that persisted them. */
export function isPersistedSpawnChild(p: PersistedAgent): boolean {
  return p.leadAgentId !== undefined && !p.teamName;
}

/** What a restored agent starts from. The caller adds how it runs
 *  (`isExternal`, and the terminal it was rebound to). */
export function restoredAgentInit(p: PersistedAgent): Omit<AgentStateInit, 'isExternal'> {
  return {
    id: p.id,
    sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
    projectDir: p.projectDir,
    jsonlFile: p.jsonlFile,
    // Live spawns survive the reload so the 1 s scan can re-adopt their
    // transcripts and the completion queue-operation still matches. Ones
    // whose completion is already in the transcript are dropped: the save on
    // completion can't cover a notice written while no server was running.
    backgroundSpawns: stillRunningSpawns(
      restoreBackgroundSpawns(p),
      p.jsonlFile,
      getHookProvider()?.team,
    ),
    directoryName: p.directoryName ?? p.folderName,
    teamName: p.teamName,
    agentName: p.agentName,
    // A named agent is a teammate; never restore it as a lead (guards against
    // state persisted before linkTeammates stopped promoting teammates).
    isTeamLead: p.agentName ? undefined : p.isTeamLead,
    leadAgentId: p.leadAgentId,
    teamUsesTmux: p.teamUsesTmux,
    palette: p.palette,
    repeat: p.repeat ?? legacyRepeat(p.clothesHue ?? p.hueShift),
  };
}

/** An older save's look, in degrees, as a repeat: which colour it was can't
 *  be told apart any more, only that it was a repeat. */
function legacyRepeat(degrees: number | undefined): number | undefined {
  if (degrees === undefined) return undefined;
  return degrees === 0 ? 0 : 1;
}
