import type { TokenSpend } from '../../core/src/messages.js';
import { THINKING_PREVIEW_MAX_CHARS } from './constants.js';

/**
 * Pure helpers behind the cascade insight (`agentInsight` / `subagentInsight`):
 * which model an agent runs on, its latest reasoning, and what it has spent.
 * The transcript parser feeds them; nothing here touches agent state.
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
