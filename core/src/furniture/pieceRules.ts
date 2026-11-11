/**
 * The ONE rules function over the furniture contract (interactive.ts): for a piece's
 * declared block and the facts the office holds about that piece, which state it
 * shows, what its Furniture label says, and whether it offers a click and what the
 * click resolves to. The renderer, the hover, the click and the server all ask it.
 * It knows no furniture by name: only the block's parts and the facts.
 *
 * Pure: no DOM, no office state.
 */

import type { FurnitureCondition, FurnitureInteractive, FurniturePanel } from './interactive.js';
import { LABEL_PLACEHOLDERS } from './interactive.js';

/** What the office knows about one piece right now. */
export interface PieceFacts {
  /** The agent working at the piece (sitting at its workstation seat, working), or null. */
  agentAtWork: { id: number; name: string } | null;
  /** The piece's panel is in use (a PC: a live PC shell), naming what it holds, or null. */
  panelInUse: { name: string } | null;
  /** The office is read-only: it offers no click. */
  readOnly: boolean;
}

/** Where a click on a piece leads. */
export type PieceClick =
  /** The piece's panel already in use (a PC: its live PC shell). */
  | { kind: 'openPanel'; panel: FurniturePanel }
  /** The terminal of the agent working at it (a `terminal` panel with no shell of its own). */
  | { kind: 'agentTerminal'; agentId: number }
  /** A new panel for the piece (a PC: start a PC shell). */
  | { kind: 'newPanel'; panel: FurniturePanel };

export interface PieceView {
  /** The declared state to show, or null for the piece's usual sprite. */
  state: string | null;
  /** The Furniture label, or null when the furniture declares none. */
  label: { name: string; lines: string[] } | null;
  /** Where a click leads, or null when the piece offers no click. */
  click: PieceClick | null;
}

const NOTHING: PieceView = { state: null, label: null, click: null };

function holds(condition: FurnitureCondition, facts: PieceFacts): boolean {
  switch (condition) {
    case 'agentWorking':
      return facts.agentAtWork !== null;
    case 'panelInUse':
      return facts.panelInUse !== null;
    case 'free':
      return facts.agentAtWork === null && facts.panelInUse === null;
  }
}

const anyHolds = (when: readonly FurnitureCondition[], facts: PieceFacts): boolean =>
  when.some((c) => holds(c, facts));

function fill(text: string, facts: PieceFacts): string {
  // The validator only lets a placeholder into a line shown on its own fact, so the
  // fact is there whenever the line is.
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name === 'agent' && facts.agentAtWork) return facts.agentAtWork.name;
    if (name === 'panel' && facts.panelInUse) return facts.panelInUse.name;
    return Object.hasOwn(LABEL_PLACEHOLDERS, name) ? '' : whole;
  });
}

function clickOf(panel: FurniturePanel | undefined, facts: PieceFacts): PieceClick | null {
  if (!panel || facts.readOnly) return null;
  if (facts.panelInUse) return { kind: 'openPanel', panel };
  // An agent's terminal stands in only for a terminal: another panel opens itself.
  if (panel === 'terminal' && facts.agentAtWork) {
    return { kind: 'agentTerminal', agentId: facts.agentAtWork.id };
  }
  return { kind: 'newPanel', panel };
}

/** A piece's state, label and click under the office's facts about it. */
export function pieceView(
  interactive: FurnitureInteractive | undefined,
  facts: PieceFacts,
): PieceView {
  if (!interactive) return NOTHING;
  const rule = interactive.states?.find((r) => anyHolds(r.when, facts));
  const spec = interactive.label;
  return {
    state: rule?.state ?? null,
    label: spec
      ? {
          name: spec.name,
          lines: (spec.lines ?? [])
            .filter((line) => anyHolds(line.when, facts))
            .map((line) => fill(line.text, facts)),
        }
      : null,
    click: clickOf(interactive.panel, facts),
  };
}
