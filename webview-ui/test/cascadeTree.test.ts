import { describe, expect, it } from 'vitest';

import {
  buildCascadeRows,
  type CascadeCharacter,
  cascadeTierTotals,
} from '../src/components/cascadeTree.js';
import type { ToolActivity } from '../src/office/types.js';

const spend = (n: number) => ({
  inputTokens: n,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

function agent(id: number, extra: Partial<CascadeCharacter> = {}): CascadeCharacter {
  return {
    id,
    isSubagent: false,
    parentAgentId: null,
    isActive: false,
    bubbleType: null,
    ...extra,
  };
}

function sub(id: number, parent: number, extra: Partial<CascadeCharacter> = {}): CascadeCharacter {
  return agent(id, { isSubagent: true, parentAgentId: parent, ...extra });
}

const noTools = () => undefined;

describe('buildCascadeRows', () => {
  it('nests sub-agents under their parent, in creation order', () => {
    const rows = buildCascadeRows(
      [sub(-2, 2), agent(2), sub(-1, 1), agent(1), sub(-3, 1)],
      noTools,
    );
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      [1, 0],
      [-1, 1],
      [-3, 1],
      [2, 0],
      [-2, 1],
    ]);
  });

  it('lifts a sub-agent whose parent is gone to the top level', () => {
    const rows = buildCascadeRows([agent(1), sub(-1, 99)], noTools);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      [1, 0],
      [-1, 0],
    ]);
  });

  it('lists a sub-agent of a sub-agent at the top level instead of dropping it', () => {
    const rows = buildCascadeRows([agent(1), sub(-1, 1), sub(-2, -1)], noTools);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      [1, 0],
      [-1, 1],
      [-2, 0],
    ]);
  });

  it('exposes the parent name on sub-agent rows only', () => {
    const rows = buildCascadeRows([agent(1, { agentName: 'lead' }), sub(-1, 1)], noTools);
    expect(rows.map((r) => r.parentName)).toEqual([null, 'lead']);
  });

  it('names agents like the card and sub-agents by description or type', () => {
    const rows = buildCascadeRows(
      [
        agent(1),
        agent(2, { agentName: 'reviewer' }),
        sub(-1, 1, { description: 'Scan the repo', agentType: 'ecc:explorador' }),
        sub(-2, 1, { agentType: 'ecc:mecanico' }),
        sub(-3, 1),
      ],
      noTools,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Agent 1',
      'Scan the repo',
      'ecc:mecanico',
      'Subtask',
      'reviewer',
    ]);
  });

  it('carries tier, badge text and total tokens', () => {
    const [row] = buildCascadeRows(
      [
        agent(1, {
          model: 'sonnet',
          agentType: 'ecc:constructor',
          effort: 'high',
          spend: spend(5),
        }),
      ],
      noTools,
    );
    expect(row).toMatchObject({
      tier: 'sonnet',
      badge: 'Sonnet · ecc:constructor · high',
      tokens: 5,
    });
    const [bare] = buildCascadeRows([agent(2)], noTools);
    expect(bare).toMatchObject({ tier: 'unknown', badge: null, tokens: 0 });
  });

  it('derives status: permission > waiting > active > idle', () => {
    const status = (c: CascadeCharacter, tools?: ToolActivity[]) =>
      buildCascadeRows([c], () => tools)[0].status;
    expect(status(agent(1, { bubbleType: 'permission', isActive: true }))).toBe('permission');
    expect(
      status(agent(1), [
        { toolId: 't', status: 'Running Bash', done: false, permissionWait: true },
      ]),
    ).toBe('permission');
    expect(status(agent(1, { bubbleType: 'waiting', isActive: true }))).toBe('waiting');
    expect(status(agent(1, { isActive: true }))).toBe('active');
    expect(status(agent(1))).toBe('idle');
  });

  it('picks the status line: approval, awaiting input, latest open tool, idle', () => {
    const line = (c: CascadeCharacter, tools?: ToolActivity[]) =>
      buildCascadeRows([c], () => tools)[0].statusLine;
    const open: ToolActivity[] = [
      { toolId: 'a', status: 'Reading a.ts', done: true },
      { toolId: 'b', status: 'Editing b.ts', done: false },
    ];
    expect(line(agent(1, { bubbleType: 'permission' }), open)).toBe('Needs approval');
    expect(line(agent(1, { bubbleType: 'waiting', waitingAwaitingInput: true }), open)).toBe(
      'Waiting for input',
    );
    expect(line(agent(1, { isActive: true }), open)).toBe('Editing b.ts');
    expect(line(agent(1, { isActive: true }), [open[0]])).toBe('Reading a.ts');
    expect(line(agent(1), [open[0]])).toBe('Idle');
    expect(line(agent(1))).toBe('Idle');
  });
});

describe('cascadeTierTotals', () => {
  it('sums tokens per tier in cascade order and skips zero tiers', () => {
    const totals = cascadeTierTotals([
      agent(1, { model: 'opus', spend: spend(100) }),
      sub(-1, 1, { model: 'haiku', spend: spend(10) }),
      sub(-2, 1, { model: 'haiku', spend: spend(5) }),
      agent(2, { model: 'sonnet' }),
      agent(3, { agentType: 'codex', spend: spend(7) }),
      agent(4, { spend: spend(999) }),
    ]);
    expect(totals).toEqual([
      { tier: 'haiku', label: 'Haiku', tokens: 15 },
      { tier: 'opus', label: 'Opus', tokens: 100 },
      { tier: 'codex', label: 'Codex', tokens: 7 },
    ]);
  });

  it('is empty without any spend', () => {
    expect(cascadeTierTotals([agent(1, { model: 'opus' })])).toEqual([]);
  });
});
