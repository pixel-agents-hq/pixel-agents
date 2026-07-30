import fs from 'fs';
import path from 'path';

function claudeProjectDirName(workspaceDir: string): string {
  return workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function getClaudeProjectDir(tmpHome: string, workspaceDir: string): string {
  return path.join(tmpHome, '.claude', 'projects', claudeProjectDirName(workspaceDir));
}

export function createClaudeTranscript(
  tmpHome: string,
  workspaceDir: string,
  sessionId: string,
): { projectDir: string; transcriptPath: string } {
  const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
  fs.mkdirSync(projectDir, { recursive: true });

  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }

  return { projectDir, transcriptPath };
}

export function appendJsonlRecord(jsonlPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
}

export function buildTeamMetadataRecord(
  teamName: string,
  agentName?: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: 'system',
    teamName,
  };
  if (agentName) {
    record['agentName'] = agentName;
  }
  return record;
}

export function appendTeamMetadata(jsonlPath: string, teamName: string, agentName?: string): void {
  appendJsonlRecord(jsonlPath, buildTeamMetadataRecord(teamName, agentName));
}

export function buildAssistantToolUseRecord(
  toolId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildAssistantToolUseBatchRecord([{ toolId, toolName, input }]);
}

export function buildAssistantToolUseBatchRecord(
  tools: Array<{
    toolId: string;
    toolName: string;
    input?: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: tools.map(({ toolId, toolName, input }) => ({
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: input ?? {},
      })),
    },
  };
}

export function appendAssistantToolUse(
  jsonlPath: string,
  toolId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): void {
  appendJsonlRecord(jsonlPath, buildAssistantToolUseRecord(toolId, toolName, input));
}

export function buildUserToolResultRecord(
  toolUseId: string,
  content: unknown = 'ok',
): Record<string, unknown> {
  return buildUserToolResultBatchRecord([{ toolUseId, content }]);
}

export function buildUserToolResultBatchRecord(
  results: Array<{
    toolUseId: string;
    content?: unknown;
  }>,
): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: results.map(({ toolUseId, content }) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: content ?? 'ok',
      })),
    },
  };
}

/** Agent tool_result as newer harnesses write it: the spawn resolves in seconds
 *  with the spawned agent's identity (`agent_id: <name>@<team>`) while the agent
 *  runs on as an independent top-level session. This result line is the only
 *  lead-side team signal — the lead's own records carry no team tags. */
export function buildTeammateSpawnResultRecord(
  toolUseId: string,
  teammateName: string,
  teamName: string,
): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [
    {
      type: 'text',
      text: `Spawned successfully.\nagent_id: ${teammateName}@${teamName}\nname: ${teammateName}`,
    },
  ]);
}

/** Setting record that opens new-harness teammate transcripts. Carries no team
 *  tags — those appear only on later user/assistant records. */
export function buildAgentSettingRecord(agentType = 'general-purpose'): Record<string, unknown> {
  return { type: 'agent-setting', agentSetting: agentType };
}

export function buildAsyncAgentLaunchResultRecord(toolUseId: string): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [
    {
      type: 'text',
      text: 'Async agent launched successfully.',
    },
  ]);
}

export function buildBackgroundAgentDoneRecord(toolUseId: string): Record<string, unknown> {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<tool-use-id>${toolUseId}</tool-use-id>`,
  };
}

/**
 * Assistant record that carries only token usage — the signal behind the
 * context gauge. Real turns put almost the whole context in the cache
 * counters (`input_tokens` is single digits once caching kicks in), so the
 * cache read alone is the context size, which keeps expected percentages exact.
 */
export function buildAssistantUsageRecord(cacheReadTokens: number): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'still working' }],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheReadTokens,
        output_tokens: 0,
      },
    },
  };
}

export function buildTurnDurationRecord(): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'turn_duration',
  };
}

export function buildClearCommandRecord(): Record<string, unknown> {
  return {
    type: 'user',
    content: '/clear</command-name>',
  };
}

export function buildTeamConfig(members: string[]): { members: Array<{ name: string }> } {
  return {
    members: members.map((name) => ({ name })),
  };
}

export function seedTeamConfig(tmpHome: string, teamName: string, members: string[]): string {
  const teamDir = path.join(tmpHome, '.claude', 'teams', teamName);
  fs.mkdirSync(teamDir, { recursive: true });

  const configPath = path.join(teamDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig(members), null, 2));

  return configPath;
}

export function createTeammateTranscript(
  projectDir: string,
  leadSessionId: string,
  teammateSlug: string,
  teamName: string,
  agentName: string,
): string {
  const subagentsDir = path.join(projectDir, leadSessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const transcriptPath = path.join(subagentsDir, `${teammateSlug}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  appendTeamMetadata(transcriptPath, teamName, agentName);

  fs.writeFileSync(
    transcriptPath.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: agentName }, null, 2),
  );

  return transcriptPath;
}
