import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { TeamProvider } from "../../../teamProvider.js";

/**
 * Claude Code implementation of the TeamProvider interface.
 *
 * Encapsulates every Claude-specific path, field name, and tool identifier
 * for the Agent Teams feature. Adding support for a new CLI means creating a
 * sibling file; no changes to hookEventHandler.ts or fileWatcher.ts.
 */
export const claudeTeamProvider: TeamProvider = {
  providerId: "claude",

  teammateSpawnTools: new Set(["Agent"]),
  withinTurnSubagentTools: new Set(["Task"]),

  isTeammateSpawnCall(toolName, toolInput) {
    // Claude's Agent tool spawns a teammate ONLY when run_in_background is true.
    // Agent without that flag is a basic within-turn subagent (identical UX to Task).
    return toolName === "Agent" && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event) {
    const value = event.agent_type;
    return typeof value === "string" ? value : undefined;
  },

  resolveTeammateMetadataPath(teammateJsonlFile) {
    return teammateJsonlFile.replace(/\.jsonl$/, ".meta.json");
  },

  parseTeammateMetadata(metadataContents) {
    try {
      const data = JSON.parse(metadataContents) as { agentType?: unknown };
      return typeof data.agentType === "string" ? data.agentType : null;
    } catch {
      return null;
    }
  },

  resolveTeammateJsonlDir(projectDir, leadSessionId) {
    return path.join(projectDir, leadSessionId, "subagents");
  },

  getTeamMembers(teamName) {
    const configPath = path.join(
      os.homedir(),
      ".claude",
      "teams",
      teamName,
      "config.json",
    );
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch {
      return null; // config missing / unreadable -> team dissolved
    }
    try {
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        if (m && typeof m.name === "string") names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },

  extractTeamMetadataFromRecord(record) {
    const teamName = record.teamName;
    if (typeof teamName !== "string") return null;
    const agentName = record.agentName;
    return {
      teamName,
      agentName: typeof agentName === "string" ? agentName : undefined,
    };
  },
};
