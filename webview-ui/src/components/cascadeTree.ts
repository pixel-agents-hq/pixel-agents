import {
  formatTierBadge,
  type ModelTier,
  modelTier,
  TIER_LABELS,
  totalTokens,
} from '../office/modelTier.js';
import type { Character, ToolActivity } from '../office/types.js';

/** What the cascade tree reads off a Character (a subset, so tests stay small). */
export type CascadeCharacter = Pick<
  Character,
  'id' | 'isSubagent' | 'parentAgentId' | 'isActive' | 'bubbleType'
> &
  Partial<
    Pick<
      Character,
      | 'model'
      | 'agentType'
      | 'description'
      | 'effort'
      | 'spend'
      | 'agentName'
      | 'waitingAwaitingInput'
    >
  >;

export type CascadeStatus = 'active' | 'waiting' | 'permission' | 'idle';

export interface CascadeRow {
  id: number;
  /** 0 for a top-level agent, 1 for a sub-agent under it. */
  depth: number;
  /** Name of the parent row for a nested sub-agent, else null. */
  parentName: string | null;
  name: string;
  tier: ModelTier;
  badge: string | null;
  status: CascadeStatus;
  statusLine: string;
  tokens: number;
}

export interface TierTotal {
  tier: Exclude<ModelTier, 'unknown'>;
  label: string;
  tokens: number;
}

/** Tiers in the order the panel lists them. */
const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable', 'codex'] as const;

const SUBAGENT_FALLBACK_NAME = 'Subtask';
const IDLE_TEXT = 'Idle';
const APPROVAL_TEXT = 'Needs approval';
const AWAITING_INPUT_TEXT = 'Waiting for input';

/** The card bar titles an agent "Agent <id>"; a named teammate shows its name. */
function nameOf(c: CascadeCharacter): string {
  if (c.isSubagent) return c.description || c.agentType || SUBAGENT_FALLBACK_NAME;
  return c.agentName || `Agent ${c.id}`;
}

function statusOf(c: CascadeCharacter, tools: ToolActivity[] | undefined): CascadeStatus {
  if (c.bubbleType === 'permission' || tools?.some((t) => t.permissionWait && !t.done)) {
    return 'permission';
  }
  if (c.bubbleType === 'waiting') return 'waiting';
  return c.isActive ? 'active' : 'idle';
}

/** Same precedence as the overlay label: approval, awaiting input, the latest
 *  open tool, the last tool while mid-turn, else idle. */
function statusLineOf(
  c: CascadeCharacter,
  status: CascadeStatus,
  tools: ToolActivity[] | undefined,
): string {
  if (status === 'permission') return APPROVAL_TEXT;
  if (c.bubbleType === 'waiting' && c.waitingAwaitingInput) return AWAITING_INPUT_TEXT;
  if (tools && tools.length > 0) {
    const open = [...tools].reverse().find((t) => !t.done);
    if (open) return open.status;
    if (c.isActive) return tools[tools.length - 1].status;
  }
  return IDLE_TEXT;
}

/**
 * The cascade as a flat, ordered list: each top-level agent, then its
 * sub-agents (creation order: ids count down from -1). A sub-agent whose
 * parent is not in the list is shown at the top level instead of vanishing.
 */
export function buildCascadeRows(
  characters: Iterable<CascadeCharacter>,
  toolsFor: (c: CascadeCharacter) => ToolActivity[] | undefined,
): CascadeRow[] {
  const all = [...characters];
  const ids = new Set(all.map((c) => c.id));
  const subIds = new Set(all.filter((c) => c.isSubagent).map((c) => c.id));
  // One nesting level only: a sub-agent whose parent is gone, or is itself a
  // sub-agent, is listed at the top level instead of vanishing.
  const isNested = (c: CascadeCharacter) =>
    c.isSubagent &&
    c.parentAgentId !== null &&
    ids.has(c.parentAgentId) &&
    !subIds.has(c.parentAgentId);

  const subsByParent = new Map<number, CascadeCharacter[]>();
  for (const c of all) {
    if (!isNested(c)) continue;
    const list = subsByParent.get(c.parentAgentId as number) ?? [];
    list.push(c);
    subsByParent.set(c.parentAgentId as number, list);
  }

  const toRow = (c: CascadeCharacter, depth: number, parentName: string | null): CascadeRow => {
    const tools = toolsFor(c);
    const status = statusOf(c, tools);
    return {
      id: c.id,
      depth,
      parentName,
      name: nameOf(c),
      tier: modelTier(c),
      badge: formatTierBadge(c),
      status,
      statusLine: statusLineOf(c, status, tools),
      tokens: totalTokens(c.spend),
    };
  };

  const rows: CascadeRow[] = [];
  // Agents by id, then any orphaned sub-agents in creation order.
  const creationOrder = (c: CascadeCharacter) => (c.isSubagent ? -c.id : c.id);
  const tops = all
    .filter((c) => !isNested(c))
    .sort(
      (a, b) => Number(a.isSubagent) - Number(b.isSubagent) || creationOrder(a) - creationOrder(b),
    );
  for (const top of tops) {
    const topRow = toRow(top, 0, null);
    rows.push(topRow);
    const subs = (subsByParent.get(top.id) ?? []).sort((a, b) => b.id - a.id);
    for (const s of subs) rows.push(toRow(s, 1, topRow.name));
  }
  return rows;
}

/** Tokens per tier across every character, in cascade order, zero tiers
 *  skipped. Characters with an unknown tier are left out of these totals (only
 *  the five named tiers are listed) but still show their own tokens in the tree. */
export function cascadeTierTotals(characters: Iterable<CascadeCharacter>): TierTotal[] {
  const sums = new Map<ModelTier, number>();
  for (const c of characters) {
    const tokens = totalTokens(c.spend);
    if (tokens === 0) continue;
    const tier = modelTier(c);
    sums.set(tier, (sums.get(tier) ?? 0) + tokens);
  }
  return TIER_ORDER.filter((tier) => sums.has(tier)).map((tier) => ({
    tier,
    label: TIER_LABELS[tier],
    tokens: sums.get(tier) as number,
  }));
}
