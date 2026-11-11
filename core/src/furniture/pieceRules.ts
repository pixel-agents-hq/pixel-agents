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
  /**
   * Where a new panel may open, by name (a PC: the Directories mapped to the Area it
   * stands in, piecePlaces.ts). Several = the user chooses; one = there; none = the
   * panel's default place (a PC shell: the home folder).
   */
  places: readonly string[];
  /** The office is read-only: it offers no click. */
  readOnly: boolean;
}

/** Where a click on a piece leads. */
export type PieceClick =
  /** The piece's panel already in use (a PC: its live PC shell). */
  | { kind: 'openPanel'; panel: FurniturePanel }
  /** The terminal of the agent working at it (a `terminal` panel with no shell of its own). */
  | { kind: 'agentTerminal'; agentId: number }
  /** A new panel for the piece, now (a PC: start a PC shell), in `place` (null = its default). */
  | { kind: 'newPanel'; panel: FurniturePanel; place: string | null }
  /** A new panel, once the user picks one of `places` (a PC: the Directory selector). */
  | { kind: 'choosePlace'; panel: FurniturePanel; places: string[] };

export interface PieceView {
  /** The declared state to show, or null for the piece's usual sprite. */
  state: string | null;
  /**
   * The Furniture label, or null when the furniture declares none: its name and the
   * first of its lines whose condition holds (null when none does), filled in.
   */
  label: { name: string; line: string | null } | null;
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
  if (facts.places.length > 1) return { kind: 'choosePlace', panel, places: [...facts.places] };
  return { kind: 'newPanel', panel, place: facts.places[0] ?? null };
}

/** A piece's state, label and click under the office's facts about it. */
export function pieceView(
  interactive: FurnitureInteractive | undefined,
  facts: PieceFacts,
): PieceView {
  if (!interactive) return NOTHING;
  const rule = interactive.states?.find((r) => anyHolds(r.when, facts));
  const spec = interactive.label;
  // Like the state rules, the first line that holds: a label says one thing, and a
  // manifest that lists its lines in its click's order says what a click opens.
  const line = spec?.lines?.find((l) => anyHolds(l.when, facts));
  return {
    state: rule?.state ?? null,
    label: spec ? { name: spec.name, line: line ? fill(line.text, facts) : null } : null,
    click: clickOf(interactive.panel, facts),
  };
}
