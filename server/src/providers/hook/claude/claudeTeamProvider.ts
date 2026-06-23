import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';

/**
 * Claude Code implementation of the TeamProvider interface.
 *
 * Encapsulates every Claude-specific path, field name, and tool identifier
 * for the Agent Teams feature. Adding support for a new CLI means creating a
 * sibling file; no changes to hookEventHandler.ts or fileWatcher.ts.
 */

// ── Internal helpers (not exposed on the public TeamProvider interface) ──

/** Claude stores teammate metadata in a sidecar `<file>.meta.json`. */
function sidecarPath(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

/** Parse a sidecar's `agentType` field, if present. */
function parseSidecarAgentType(jsonlPath: string): string | null {
  const metaPath = sidecarPath(jsonlPath);
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw) as { agentType?: unknown };
    return typeof data.agentType === 'string' ? data.agentType : null;
  } catch {
    return null;
  }
}

/** Claude stores teammate JSONL files at `<projectDir>/<leadSessionId>/subagents/`. */
function teammateDir(projectDir: string, leadSessionId: string): string {
  return path.join(projectDir, leadSessionId, 'subagents');
}

// ── Public TeamProvider implementation ──

export const claudeTeamProvider: TeamProvider = {
  providerId: 'claude',

  teammateSpawnTools: new Set(['Agent']),
  withinTurnSubagentTools: new Set(['Task']),

  isTeammateSpawnCall(toolName, toolInput) {
    // Claude's Agent tool spawns a teammate ONLY when run_in_background is true.
    // Agent without that flag is a basic within-turn subagent (identical UX to Task).
    return toolName === 'Agent' && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event) {
    const value = event.agent_type;
    return typeof value === 'string' ? value : undefined;
  },

  discoverTeammates(projectDir, leadSessionId) {
    const dir = teammateDir(projectDir, leadSessionId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return []; // directory missing -> no teammates yet
    }
    const result: Array<{ jsonlPath: string; teammateName: string }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dir, entry);
      const teammateName = parseSidecarAgentType(jsonlPath);
      if (teammateName) {
        result.push({ jsonlPath, teammateName });
      }
    }
    return result;
  },

  getTeamMetadataForSession(jsonlPath) {
    // Claude: read the first JSONL line; team fields live in the first assistant/system record.
    // The caller (fileWatcher) already knows the path, so this is the straightforward lookup.
    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return null;
    }
    const firstNewline = raw.indexOf('\n');
    const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
    if (!firstLine.trim()) return null;
    try {
      const record = JSON.parse(firstLine) as Record<string, unknown>;
      const teamName = record.teamName;
      if (typeof teamName !== 'string') return null;
      const agentName = record.agentName;
      return {
        teamName,
        agentName: typeof agentName === 'string' ? agentName : undefined,
      };
    } catch {
      return null;
    }
  },

  extractTeamMetadataFromRecord(record) {
    const teamName = record.teamName;
    if (typeof teamName !== 'string') return null;
    const agentName = record.agentName;
    return {
      teamName,
      agentName: typeof agentName === 'string' ? agentName : undefined,
    };
  },

  getTeamMembers(teamName) {
    const configPath = path.join(os.homedir(), '.claude', 'teams', teamName, 'config.json');
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch {
      return null; // config missing / unreadable -> team dissolved
    }
    try {
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        if (m && typeof m.name === 'string') names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },
};
