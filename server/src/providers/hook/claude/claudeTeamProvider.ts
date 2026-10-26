import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';
import { CLAUDE_SUBAGENT_TOOLS } from './constants.js';

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

/** Parse a sidecar's metadata: `agentType` (required), plus `toolUseId`,
 *  `description`, and `name` when present (background agents record the first
 *  three; a NAMED teamless spawn additionally records `name`). */
function parseSidecarMeta(
  jsonlPath: string,
): { agentType: string; toolUseId?: string; description?: string; name?: string } | null {
  const metaPath = sidecarPath(jsonlPath);
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw) as {
      agentType?: unknown;
      toolUseId?: unknown;
      description?: unknown;
      name?: unknown;
    };
    if (typeof data.agentType !== 'string') return null;
    return {
      agentType: data.agentType,
      toolUseId: typeof data.toolUseId === 'string' ? data.toolUseId : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      name: typeof data.name === 'string' ? data.name : undefined,
    };
  } catch {
    return null;
  }
}

/** Claude stores teammate JSONL files at `<projectDir>/<leadSessionId>/subagents/`. */
function teammateDir(projectDir: string, leadSessionId: string): string {
  return path.join(projectDir, leadSessionId, 'subagents');
}

/** Spawn tool_result line identifying the spawned agent: `agent_id: <name>@<team>`.
 *  Newer Claude harnesses run every Agent spawn in the background and this result
 *  line is the ONLY lead-side evidence of the (implicit) team. */
const AGENT_ID_RESULT_PATTERN = /agent_id:\s*([^\s@]+)@(\S+)/;

/** The text parts of a tool_result content value (string or content-block array). */
function toolResultTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { text?: unknown }).text === 'string'
      ? [(item as { text: string }).text]
      : [],
  );
}

/** Flatten a tool_result content value to one text. */
function toolResultText(content: unknown): string {
  return toolResultTexts(content).join('\n');
}

/** The first capture of `pattern` in any of the texts. */
function firstMatch(texts: string[], pattern: RegExp): string | undefined {
  for (const text of texts) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

/** How an async (background) spawn's tool_result begins; it then names the
 *  agent: "agentId: <id>". */
const ASYNC_LAUNCH_PREFIX = 'Async agent launched successfully.';
const ASYNC_LAUNCH_AGENT_ID = /\bagentId: ([A-Za-z0-9_-]+)/;
/** SendMessage to a STOPPED agent revives it, and its result says which:
 *  `{"success":true,"message":"Resuming agent impl-07","resumedAgentId":"ad19…"}`.
 *  Messages to running agents carry no resumedAgentId. */
const REVIVE_TOOL = 'SendMessage';
const RESUMED_AGENT_ID = /"resumedAgentId"\s*:\s*"([A-Za-z0-9_-]+)"/;

/** A background agent that stops with background work of its own still
 *  running (a background Bash, a Monitor) gets a completion-shaped notice
 *  while it lives (Claude Code 2.1.309), with the same <status> as its final
 *  one: `<summary>Agent "…" is waiting on its own background work</summary>`
 *  and a note that "the result below may be interim". Only these tell the
 *  two apart. */
const INTERIM_NOTICE_SUMMARY = /<summary>[^<]*is waiting on its own background work\s*<\/summary>/;
const INTERIM_NOTICE_NOTE = /<note>[^<]*\bmay be interim\b[^<]*<\/note>/;

/** Claude names a sidecar-backed spawn's transcript after its agent id. */
const AGENT_TRANSCRIPT_NAME = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

/**
 * Read the first few records of a transcript and return its team tags.
 * Newer harnesses open teammate transcripts with setting records (`agent-setting`,
 * `mode`, `permission-mode`) that carry no team fields -- the tags appear on the
 * first user/assistant record -- so scanning just line 1 is not enough.
 *
 * Returns:
 *  - `{ teamName, agentName }` when a record carries team tags
 *  - `null` (definitive) when a user/assistant record appears without them
 *  - `undefined` (indeterminate) when only setting records exist so far
 */
const TEAM_METADATA_SCAN_BYTES = 16384;
function readTeamMetadata(
  jsonlPath: string,
): { teamName: string; agentName?: string } | null | undefined {
  let raw: string;
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(TEAM_METADATA_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.toString('utf-8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // partial trailing line or mid-write garbage
    }
    if (typeof record.teamName === 'string') {
      return {
        teamName: record.teamName,
        agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
      };
    }
    // A conversational record without team tags means this transcript will
    // never gain them (tags are stamped on every user/assistant record).
    if (record.type === 'user' || record.type === 'assistant') return null;
  }
  return undefined;
}

/** Transcripts confirmed to have NO team tags (first user/assistant record was
 *  untagged). Definitive -- never re-read these on subsequent discovery scans.
 *  Indeterminate files (only setting records so far) are NOT cached and get
 *  re-checked until a conversational record lands. */
const confirmedNonTeamFiles = new Set<string>();

/** Session-transcript filename: `<uuid>.jsonl`. Anything else in the project dir
 *  (sidecars, editor droppings) is not a candidate teammate transcript. */
const SESSION_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// ── Public TeamProvider implementation ──

const TEAMMATE_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent']);

export const claudeTeamProvider: TeamProvider = {
  providerId: 'claude',

  teammateSpawnTools: TEAMMATE_SPAWN_TOOLS,
  withinTurnSubagentTools: new Set(['Task']),

  isTeammateSpawnCall(toolName, toolInput) {
    // Claude's Agent tool spawns a teammate ONLY when run_in_background is true.
    // Agent without that flag is a basic within-turn subagent (identical UX to Task).
    return toolName === 'Agent' && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event) {
    const teammateName = event.teammate_name;
    if (typeof teammateName === 'string') return teammateName;
    const agentType = event.agent_type;
    return typeof agentType === 'string' ? agentType : undefined;
  },

  extractTeammateSpawnFromToolResult(toolName, resultContent) {
    if (!TEAMMATE_SPAWN_TOOLS.has(toolName)) return null;
    const match = AGENT_ID_RESULT_PATTERN.exec(toolResultText(resultContent));
    if (!match) return null;
    return { teammateName: match[1], teamName: match[2] };
  },

  extractBackgroundAgentFromToolResult(toolName, resultContent) {
    const texts = toolResultTexts(resultContent);
    if (CLAUDE_SUBAGENT_TOOLS.has(toolName)) {
      if (!texts.some((text) => text.startsWith(ASYNC_LAUNCH_PREFIX))) return null;
      return { taskId: firstMatch(texts, ASYNC_LAUNCH_AGENT_ID) };
    }
    if (toolName === REVIVE_TOOL) {
      const taskId = firstMatch(texts, RESUMED_AGENT_ID);
      return taskId ? { taskId } : null;
    }
    return null;
  },

  isInterimSpawnNotice(notice) {
    return INTERIM_NOTICE_SUMMARY.test(notice) || INTERIM_NOTICE_NOTE.test(notice);
  },

  discoverTeammates(projectDir, leadSessionId, teamName) {
    const result: Array<{
      jsonlPath: string;
      teammateName: string;
      sessionId?: string;
      toolUseId?: string;
      taskId?: string;
      description?: string;
      name?: string;
    }> = [];

    // Old-style: sidecar-tagged transcripts under <projectDir>/<leadSessionId>/subagents/.
    const dir = teammateDir(projectDir, leadSessionId);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // directory missing -> no old-style teammates
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dir, entry);
      const meta = parseSidecarMeta(jsonlPath);
      if (meta) {
        result.push({
          jsonlPath,
          teammateName: meta.agentType,
          toolUseId: meta.toolUseId,
          taskId: AGENT_TRANSCRIPT_NAME.exec(entry)?.[1],
          description: meta.description,
          name: meta.name,
        });
      }
    }

    // New-style (implicit teams): teammates are independent TOP-LEVEL sessions in the
    // same project dir, every user/assistant record tagged teamName/agentName. Only
    // scannable once the lead's team is known.
    if (teamName) {
      let topLevel: string[] = [];
      try {
        topLevel = fs.readdirSync(projectDir);
      } catch {
        return result;
      }
      for (const entry of topLevel) {
        if (!SESSION_FILE_PATTERN.test(entry)) continue;
        const jsonlPath = path.join(projectDir, entry);
        if (confirmedNonTeamFiles.has(jsonlPath)) continue;
        if (jsonlPath === path.join(projectDir, `${leadSessionId}.jsonl`)) continue;
        const meta = readTeamMetadata(jsonlPath);
        if (meta === null) {
          confirmedNonTeamFiles.add(jsonlPath);
          continue;
        }
        if (meta === undefined) continue; // only setting records so far -- recheck next scan
        if (meta.teamName !== teamName || !meta.agentName) continue;
        result.push({
          jsonlPath,
          teammateName: meta.agentName,
          sessionId: entry.slice(0, -'.jsonl'.length),
        });
      }
    }

    return result;
  },

  getTeamMetadataForSession(jsonlPath) {
    // Scan the first few records: newer harnesses open transcripts with setting
    // records that carry no team fields, so line 1 alone is not sufficient.
    return readTeamMetadata(jsonlPath) ?? null;
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
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown; isActive?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        // isActive:false = the CLI marked this one-shot teammate finished (newer
        // harnesses keep finished members listed). Missing isActive = active
        // (older configs never write the field).
        if (m && typeof m.name === 'string' && m.isActive !== false) names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },
};
