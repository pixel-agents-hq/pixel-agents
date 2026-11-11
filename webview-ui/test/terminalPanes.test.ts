import { describe, expect, it } from 'vitest';

import { agentPaneIds, openedAgentPane, type Pane } from '../src/hooks/terminalPanes.js';

const agent = (id: number): Pane => ({ kind: 'agent', id });
const shell = (id: number): Pane => ({ kind: 'pcShell', id });

describe('openedAgentPane (the drawer opens on, and a launch is answered by, this)', () => {
  it('is the newest agent pane not seen before', () => {
    expect(openedAgentPane([], [agent(1)])).toBe(1);
    expect(openedAgentPane([1], [agent(1), agent(2), agent(3)])).toBe(3);
    expect(openedAgentPane([1, 2], [agent(1), agent(2)])).toBeNull();
  });

  it("never a PC shell's: one opened on any device takes no office's pane or launch", () => {
    expect(openedAgentPane([1], [agent(1), shell(1_000_000_001)])).toBeNull();
    // A reload lists the shells after the agents: the agent still answers.
    expect(openedAgentPane([], [agent(1), shell(1_000_000_001)])).toBe(1);
  });

  it('the known list is the agent panes', () => {
    expect(agentPaneIds([agent(1), shell(1_000_000_001), agent(2)])).toEqual([1, 2]);
  });
});
