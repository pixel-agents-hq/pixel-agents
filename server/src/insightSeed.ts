import type { AgentStateStore } from './agentStateStore.js';
import { readTranscriptTail } from './contextUsage.js';
import { isRealModelId, recordEffort } from './insight.js';

interface ModelRecord {
  isSidechain?: unknown;
  message?: { model?: unknown };
}

/**
 * Seed model and effort from a transcript's tail when watching starts.
 *
 * An agent adopted or restored mid-session starts at end-of-file, so without
 * this its tier would stay unknown until its next turn. Main chain wins;
 * sidechain is the fallback for teammate transcripts (sidechain top to
 * bottom), the same rule the context gauge seeds by. Thinking and spend are
 * not seeded: both describe activity since watching started.
 */
export function seedInsight(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.insightModel || !agent.jsonlFile) return;

  const lines = readTranscriptTail(agent.jsonlFile);
  if (!lines) return;

  let sidechain: ModelRecord | null = null;
  let chosen: ModelRecord | null = null;
  for (let i = lines.length - 1; i >= 0 && !chosen; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: ModelRecord;
    try {
      record = JSON.parse(line) as ModelRecord;
    } catch {
      continue;
    }
    if (!isRealModelId(record?.message?.model)) continue;
    if (record.isSidechain === true) sidechain ??= record;
    else chosen = record;
  }
  chosen ??= sidechain;
  if (!chosen) return;

  const model = chosen.message?.model as string;
  const effort = recordEffort(chosen);
  agent.insightModel = model;
  if (effort) agent.insightEffort = effort;
  agents.broadcast({ type: 'agentInsight', id: agentId, model, ...(effort ? { effort } : {}) });
}
