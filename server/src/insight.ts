import type { TokenSpend } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { THINKING_PREVIEW_MAX_CHARS } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Pure helpers behind the cascade insight (`agentInsight` / `subagentInsight`):
 * which model an agent runs on, its latest reasoning, and what it has spent.
 * The transcript parser feeds them; nothing here changes agent state.
 */

/** Claude Code writes placeholder ids like `<synthetic>` on locally generated
 *  records (API errors, interrupts); only a real id names a model. */
export function isRealModelId(model: unknown): model is string {
  return typeof model === 'string' && model.length > 0 && !model.startsWith('<');
}

/** Text of the LAST non-empty `thinking` block. Redacted blocks carry
 *  `thinking: ""` plus a signature and are skipped. Long text is cut with `…`. */
export function latestThinking(blocks: unknown[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as { type?: unknown; thinking?: unknown } | null;
    if (block?.type !== 'thinking' || typeof block.thinking !== 'string') continue;
    const text = block.thinking.trim();
    if (!text) continue;
    return text.length > THINKING_PREVIEW_MAX_CHARS
      ? text.slice(0, THINKING_PREVIEW_MAX_CHARS) + '…'
      : text;
  }
  return undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageCounters(usage: unknown): TokenSpend {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  return {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheCreationTokens: count(u.cache_creation_input_tokens),
  };
}

/** Running total plus one response's usage; missing or non-numeric counters are 0. */
export function addUsage(spend: TokenSpend | undefined, usage: unknown): TokenSpend {
  const add = usageCounters(usage);
  return {
    inputTokens: (spend?.inputTokens ?? 0) + add.inputTokens,
    outputTokens: (spend?.outputTokens ?? 0) + add.outputTokens,
    cacheReadTokens: (spend?.cacheReadTokens ?? 0) + add.cacheReadTokens,
    cacheCreationTokens: (spend?.cacheCreationTokens ?? 0) + add.cacheCreationTokens,
  };
}

/** All four counters 0 or missing: synthetic records report zeros and mean "no news". */
export function isEmptyUsage(usage: unknown): boolean {
  const c = usageCounters(usage);
  return (
    c.inputTokens === 0 &&
    c.outputTokens === 0 &&
    c.cacheReadTokens === 0 &&
    c.cacheCreationTokens === 0
  );
}

export interface SpawnInsight {
  agentType?: string;
  description?: string;
  model?: string;
  effort?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The effort a record ran at. Claude Code stamps `effort` on every turn. */
export function recordEffort(record: unknown): string | undefined {
  return nonEmpty((record as { effort?: unknown } | null)?.effort);
}

export interface AgentInsightFields {
  model?: string;
  effort?: string;
  thinking?: string;
  spend?: TokenSpend;
}

type InsightState = Pick<
  AgentState,
  'insightModel' | 'insightEffort' | 'insightThinking' | 'insightSpend'
>;

/** Everything the agent has gathered so far, for a client that connects later.
 *  Empty when there is nothing yet. */
export function insightSnapshot(agent: InsightState): AgentInsightFields {
  const out: AgentInsightFields = {};
  if (agent.insightModel) out.model = agent.insightModel;
  if (agent.insightEffort) out.effort = agent.insightEffort;
  if (agent.insightThinking) out.thinking = agent.insightThinking;
  if (agent.insightSpend) out.spend = agent.insightSpend;
  return out;
}

/** A spawn is live while its tool runs in the foreground or in the background. */
export function isLiveSpawn(
  agent: Pick<AgentState, 'activeToolIds' | 'backgroundAgentToolIds'>,
  toolId: string,
): boolean {
  return agent.activeToolIds.has(toolId) || agent.backgroundAgentToolIds.has(toolId);
}

/** Everything known about one sub-agent: what its spawn call said, the model
 *  it resolved to, and its own reasoning and spend while it runs. */
export type SubagentInsightFields = SpawnInsight & { thinking?: string; spend?: TokenSpend };

/** What a sub-agent spawn call says about its child, keeping non-empty strings only. */
export function spawnInsight(input: unknown): SpawnInsight {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: SpawnInsight = {};
  const agentType = nonEmpty(i.subagent_type);
  const description = nonEmpty(i.description);
  const model = nonEmpty(i.model);
  const effort = nonEmpty(i.effort);
  if (agentType) out.agentType = agentType;
  if (description) out.description = description;
  if (model) out.model = model;
  if (effort) out.effort = effort;
  return out;
}

// -- Sharing thinking -------------------------------------------------------
// The "Show Agent Thinking" setting is a privacy switch for a shared office, so
// it is enforced where the messages are made: while off, `thinking` never
// leaves the server. The agent still records it (`insightThinking`), so nothing
// is lost; turning the setting back on shows only what comes next.

let thinkingShared = true;

/** Set whether thinking text may be broadcast. Prefer `applyShowThinking` when
 *  the change comes from the user, since turning it off must also clear. */
export function setThinkingShared(enabled: boolean): void {
  thinkingShared = enabled;
}

export function isThinkingShared(): boolean {
  return thinkingShared;
}

/** `fields` without `thinking` while sharing is off; unchanged otherwise. */
export function shareableInsight<T extends { thinking?: string }>(fields: T): T {
  if (thinkingShared) return fields;
  const { thinking: _withheld, ...rest } = fields;
  return rest as T;
}

/** Apply the setting. Turning it off tells every client to drop the bubbles it
 *  shows (an empty `thinking` means no bubble) -- once per agent, and once per
 *  live spawn, that has thinking -- and forgets the stored thinking, so a later
 *  replay (after turning it back on) cannot show it as new. Turning it on
 *  replays nothing. */
export function applyShowThinking(store: AgentStateStore, enabled: boolean): void {
  const wasShared = thinkingShared;
  thinkingShared = enabled;
  if (enabled || !wasShared) return;
  for (const [id, agent] of store) {
    if (agent.insightThinking) {
      agent.insightThinking = undefined;
      store.broadcast({ type: 'agentInsight', id, thinking: '' });
    }
    for (const [parentToolId, fields] of agent.insightSpawns ?? []) {
      if (!fields.thinking) continue;
      delete fields.thinking;
      if (isLiveSpawn(agent, parentToolId)) {
        store.broadcast({ type: 'subagentInsight', id, parentToolId, thinking: '' });
      }
    }
  }
}
