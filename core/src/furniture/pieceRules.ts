/**
 * The ONE set of rules over the furniture contract (interactive.ts): for a piece's
 * declared block and the facts the office holds about that piece, which state it
 * shows (pieceState — the renderer, every frame), what its Furniture label says
 * (pieceLabel) and whether it offers a click and what the click resolves to
 * (pieceClick); pieceView composes the three for the hover and the click. The
 * server asks only whether a piece opens a panel (opensPanel: a PC shell's open).
 * It knows no furniture by name: only the block's parts and the facts.
 *
 * Pure: no DOM, no office state.
 */

import type { FurnitureCondition, FurnitureInteractive, FurniturePanel } from './interactive.js';
import { LABEL_PLACEHOLDER, type LabelPlaceholder } from './interactive.js';

/** Who and what is using a piece right now: all its state and its label read. */
export interface PieceUse {
  /** The agent working at the piece (sitting at its workstation seat, working), or null. */
  agentAtWork: { id: number; name: string } | null;
  /**
   * The agent whose seat is the piece's workstation seat, working or idle (the one
   * at work when there is one), or null: whose desk this is.
   */
  agentSeated: { id: number; name: string } | null;
  /**
   * The piece's panel is in use (a PC: a live PC shell), naming what it holds, or
   * null. A null `name` = in use, but this office is not told by what (a view-only
   * office): its label reads PANEL_IN_USE_UNNAMED.
   */
  panelInUse: { name: string | null } | null;
}

/** What the office knows about one piece right now: its use, and what its click needs. */
export interface PieceFacts extends PieceUse {
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

/** What a label says of a panel in use that this office is not told the holder of. */
export const PANEL_IN_USE_UNNAMED = 'Busy';

function holds(condition: FurnitureCondition, facts: PieceUse): boolean {
  switch (condition) {
    case 'agentWorking':
      return facts.agentAtWork !== null;
    case 'agentSeated':
      return facts.agentSeated !== null || facts.agentAtWork !== null;
    case 'panelInUse':
      return facts.panelInUse !== null;
    case 'free':
      return facts.agentAtWork === null && facts.agentSeated === null && facts.panelInUse === null;
  }
}

const anyHolds = (when: readonly FurnitureCondition[], facts: PieceUse): boolean =>
  when.some((c) => holds(c, facts));

function fill(text: string, facts: PieceUse): string {
  // The validator only lets a known placeholder into a line shown on its own fact,
  // so the fact is there whenever the line is.
  const values: Record<LabelPlaceholder, string | undefined> = {
    agent: (facts.agentAtWork ?? facts.agentSeated)?.name,
    panel: facts.panelInUse?.name ?? undefined,
  };
  return text.replace(LABEL_PLACEHOLDER, (_, name: LabelPlaceholder) => values[name] ?? '');
}

/** Whether a piece's furniture opens `panel` (the server: does this piece open a PC shell?). */
export function opensPanel(
  interactive: FurnitureInteractive | undefined,
  panel: FurniturePanel,
): boolean {
  return interactive?.panel === panel;
}

/** The declared state a piece shows under its use, or null for its usual sprite. */
export function pieceState(
  interactive: FurnitureInteractive | undefined,
  use: PieceUse,
): string | null {
  return interactive?.states?.find((r) => anyHolds(r.when, use))?.state ?? null;
}

/**
 * A piece's Furniture label under its use, or null when the furniture declares none:
 * its name and, like the state rules, the first line that holds (a label says one
 * thing, and a manifest that lists its lines in its click's order says what a click
 * opens), filled in — or "Busy" for a line naming a panel's holder this office is
 * not told.
 */
export function pieceLabel(
  interactive: FurnitureInteractive | undefined,
  use: PieceUse,
): PieceView['label'] {
  const spec = interactive?.label;
  if (!spec) return null;
  const line = spec.lines?.find((l) => anyHolds(l.when, use));
  if (!line) return { name: spec.name, line: null };
  // A line that names what the panel holds, in an office that isn't told: "Busy".
  const unnamed = use.panelInUse?.name === null && line.text.includes('{panel}');
  return { name: spec.name, line: unnamed ? PANEL_IN_USE_UNNAMED : fill(line.text, use) };
}

/** Where a click on a piece leads under the office's facts, or null when it offers none. */
export function pieceClick(
  interactive: FurnitureInteractive | undefined,
  facts: PieceFacts,
): PieceClick | null {
  const panel = interactive?.panel;
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
  return {
    state: pieceState(interactive, facts),
    label: pieceLabel(interactive, facts),
    click: pieceClick(interactive, facts),
  };
}
