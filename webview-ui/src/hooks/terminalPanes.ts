/**
 * The terminal panes this office shows (standalone), by kind: agents' and PC
 * shells' (CONTEXT.md → PC shell). DOM-free, so the rules run on the Node runner.
 */

/** A terminal pane: an agent's, or a PC shell's. */
export interface Pane {
  kind: 'agent' | 'pcShell';
  id: number;
}

/**
 * The agent pane that appeared since `known` (the agent panes seen before),
 * the newest of them, or null: what the drawer opens on and what answers a
 * launch this office made (`expectLaunch`). A PC shell's pane never counts:
 * a shell opened on any device appears in every office, and only the office
 * that opened it shows it, on its own answer (`pcShellReady`).
 */
export function openedAgentPane(known: readonly number[], panes: readonly Pane[]): number | null {
  const added = agentPaneIds(panes).filter((id) => !known.includes(id));
  return added.length > 0 ? added[added.length - 1] : null;
}

/** The agents' panes' ids, in order. */
export function agentPaneIds(panes: readonly Pane[]): number[] {
  return panes.filter((pane) => pane.kind === 'agent').map((pane) => pane.id);
}
