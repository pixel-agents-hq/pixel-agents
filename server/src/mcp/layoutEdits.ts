/**
 * Agents' layout edits as the office keeps them: the ONE place an edit_layout
 * batch is committed, undone, or refused because a person is editing.
 *
 * - **Commit**: a batch (layoutEditOps.ts) that applied is saved once through
 *   the office's layout persistence (and the Directory ↔ Area mappings, when
 *   it changed them), read back to prove it landed, and broadcast to every
 *   office as `layoutLoaded` (and `areaMappingsLoaded`) like any save.
 * - **Editing lock**: each office reports whether its layout editor holds
 *   unsaved changes (`layoutEditing {dirty}`, keyed by its socket, dropped
 *   when the socket goes). While any does, edits and undo are refused: an
 *   agent never overwrites a person's work.
 * - **Undo**: the last LAYOUT_UNDO_DEPTH agent edits, each with the layout
 *   (and mappings) it replaced. Undo restores the newest only while the
 *   office still holds exactly what that edit wrote; anything since — an
 *   editor save, another agent's edit undone out of order — refuses it.
 *   undo_layout_edit and the editor's "Undo <agent>'s edit" button
 *   (`undoAgentLayoutEdit`) are this same operation; every office is told
 *   what an undo would revert (`agentLayoutEditStatus`).
 */

import {
  type FurnitureCatalog,
  layoutFromJson,
  type OfficeLayout,
} from '../../../core/src/layout/index.js';
import type {
  AgentLayoutEditStatus,
  AreaMappingsLoaded,
  LayoutLoaded,
} from '../../../core/src/messages.js';
import { LAYOUT_UNDO_DEPTH } from '../constants.js';
import { canonicalJson } from './canonicalJson.js';
import { applyLayoutOps, type AreaMappings, type LayoutOp, sameMappings } from './layoutEditOps.js';

export interface LayoutEditsDeps {
  /** The saved layout (or the default one), as JSON. */
  readLayout(): Record<string, unknown> | null;
  /** Save a layout (the office's layout persistence: atomic, watchers marked). */
  writeLayout(layout: Record<string, unknown>): void;
  catalog(): FurnitureCatalog | null;
  /** How many floor patterns, wall sets, carpets and pets are loaded. */
  assets(): { floorPatterns: number; wallSets: number; carpets: number; pets: number };
  /** The office's Directory names. */
  directories(): readonly string[];
  readAreaMappings(): AreaMappings;
  writeAreaMappings(mappings: AreaMappings): void;
  /** Send a message to every open office. */
  broadcast(message: Record<string, unknown>): void;
  /** How the office names an agent ("Undo <name>'s edit"): agentLabel.ts. */
  agentName(agentId: number): string;
  newId(): string;
}

/** An edit_layout call's outcome, in the tool's terms. */
export type LayoutEditOutcome =
  | {
      ok: true;
      changed: boolean;
      grid: { cols: number; rows: number };
      placed: Array<{ op: number; uid: string; type: string }>;
      notes: string[];
    }
  | { ok: false; reason: string; index?: number };

export type LayoutUndoOutcome =
  | { ok: true; agentId: number; grid: { cols: number; rows: number } }
  | { ok: false; reason: string };

/** Who an edit's broadcast is from, and where it happens: the Buildout
 *  (`layoutLoaded.buildout`). No origin (the edit named no tile) = no Buildout. */
export interface AgentEditSource {
  agentId: number;
  origin: { col: number; row: number } | null;
}

/** How far a change moved the grid's tiles (`layoutLoaded.shift`). */
type GridShift = { col: number; row: number };

export interface LayoutEdits {
  /** Apply an agent's batch: all or none, saved once, broadcast. */
  edit(agentId: number, ops: readonly LayoutOp[]): LayoutEditOutcome;
  /** Restore the layout before the newest agent edit, if nothing changed since. */
  undo(): LayoutUndoOutcome;
  /** An office reports whether its editor has unsaved changes. */
  setEditing(client: object, dirty: boolean): void;
  /** An office's socket went: its report goes with it. */
  clientGone(client: object): void;
  /** What an undo would revert now (agentLayoutEditStatus), for the connect snapshot. */
  statusMessage(): AgentLayoutEditStatus;
  /** An office saved the layout: what an undo would revert may have changed. */
  layoutSaved(): void;
}

export const LAYOUT_EDITING_REASON =
  'Someone has unsaved changes in the office layout editor, so the layout is locked. ' +
  'Try again once they save, reset or close the editor (or ask the user to).';

interface UndoEntry {
  agentId: number;
  /** The agent's name when it edited (it may have left since). */
  agentName: string;
  /** What the edit wrote and what it replaced (canonical JSON, compared and restored). */
  written: string;
  previous: string;
  /** The mappings before and after, when the edit changed them. */
  mappings?: { before: AreaMappings; after: AreaMappings };
  /** How far the edit's resizes moved the tiles (undo moves them back). */
  shift: { col: number; row: number };
}

export function createLayoutEdits(deps: LayoutEditsDeps): LayoutEdits {
  const dirtyClients = new Set<object>();
  const history: UndoEntry[] = [];
  let lastStatus = '';

  /** The office's current layout, canonical (migrated, keys sorted), or null. */
  function currentCanonical(): string | null {
    const layout = layoutFromJson(deps.readLayout());
    return layout ? canonical(layout) : null;
  }

  function undoable(): UndoEntry | null {
    const top = history[history.length - 1];
    if (!top || currentCanonical() !== top.written) return null;
    if (top.mappings && !sameMappings(deps.readAreaMappings(), top.mappings.after)) return null;
    return top;
  }

  function statusMessage(): AgentLayoutEditStatus {
    const top = undoable();
    return top
      ? {
          type: 'agentLayoutEditStatus',
          agentId: top.agentId,
          agentName: top.agentName,
        }
      : { type: 'agentLayoutEditStatus' };
  }

  /** Tell every office what an undo would revert, when that changed. */
  function announceStatus(): void {
    const message = statusMessage();
    const key = JSON.stringify(message);
    if (key === lastStatus) return;
    lastStatus = key;
    deps.broadcast({ ...message });
  }

  /** Save `layout`, prove it landed, and show it in every office. */
  function saveAndShow(
    layout: OfficeLayout,
    source: AgentEditSource | null,
    shift: GridShift,
  ): boolean {
    const json = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
    deps.writeLayout(json);
    if (currentCanonical() !== canonical(layout)) return false;
    // An agent's edit builds into every open office (the Buildout); undo,
    // and an edit that names no tile, just appear. Either way a resize that
    // moved the tiles says so, for the characters standing on them.
    const loaded: LayoutLoaded = {
      type: 'layoutLoaded',
      layout: json,
      ...(source?.origin ? { buildout: { agentId: source.agentId, origin: source.origin } } : {}),
      ...(shift.col !== 0 || shift.row !== 0 ? { shift } : {}),
    };
    deps.broadcast({ ...loaded });
    return true;
  }

  function saveMappings(mappings: AreaMappings): void {
    deps.writeAreaMappings(mappings);
    const loaded: AreaMappingsLoaded = { type: 'areaMappingsLoaded', mappings };
    deps.broadcast({ ...loaded });
  }

  return {
    edit(agentId, ops) {
      if (dirtyClients.size > 0) return { ok: false, reason: LAYOUT_EDITING_REASON };
      const start = layoutFromJson(deps.readLayout());
      if (!start) return { ok: false, reason: 'This office has no layout to edit.' };
      const assets = deps.assets();
      const startMappings = deps.readAreaMappings();
      const result = applyLayoutOps(
        {
          layout: start,
          mappings: startMappings,
          catalog: deps.catalog(),
          ...assets,
          directories: deps.directories(),
          newId: deps.newId,
        },
        ops,
      );
      if (!result.ok) return { ok: false, index: result.index, reason: result.reason };

      const grid = { cols: result.layout.cols, rows: result.layout.rows };
      const { placed, notes } = result;
      if (!result.layoutChanged && !result.mappingsChanged) {
        return { ok: true, changed: false, grid, placed, notes };
      }

      const previous = canonical(start);
      if (result.layoutChanged) {
        if (!saveAndShow(result.layout, { agentId, origin: result.origin }, result.shift)) {
          return {
            ok: false,
            reason: 'The layout could not be saved; nothing changed. Try again.',
          };
        }
      }
      if (result.mappingsChanged) saveMappings(result.mappings);

      history.push({
        agentId,
        agentName: deps.agentName(agentId),
        written: canonical(result.layout),
        previous,
        shift: result.shift,
        ...(result.mappingsChanged
          ? { mappings: { before: startMappings, after: result.mappings } }
          : {}),
      });
      if (history.length > LAYOUT_UNDO_DEPTH) history.shift();
      announceStatus();
      return { ok: true, changed: true, grid, placed, notes };
    },

    undo() {
      if (dirtyClients.size > 0) return { ok: false, reason: LAYOUT_EDITING_REASON };
      const top = history[history.length - 1];
      if (!top) return { ok: false, reason: 'There is no agent layout edit to undo.' };
      if (!undoable()) {
        return {
          ok: false,
          reason:
            'The layout changed since the last agent edit (someone saved over it), so undo would ' +
            'discard newer work; nothing was undone.',
        };
      }
      const previous = layoutFromJson(JSON.parse(top.previous))!;
      if (
        top.written !== top.previous &&
        !saveAndShow(previous, null, { col: -top.shift.col, row: -top.shift.row })
      ) {
        return {
          ok: false,
          reason: 'The layout could not be saved; nothing was undone. Try again.',
        };
      }
      if (top.mappings) saveMappings(top.mappings.before);
      history.pop();
      announceStatus();
      return { ok: true, agentId: top.agentId, grid: { cols: previous.cols, rows: previous.rows } };
    },

    setEditing(client, dirty) {
      if (dirty) dirtyClients.add(client);
      else dirtyClients.delete(client);
    },

    clientGone(client) {
      dirtyClients.delete(client);
    },

    statusMessage,

    layoutSaved() {
      announceStatus();
    },
  };
}

/** A layout as one comparable string. */
const canonical = (layout: OfficeLayout): string => canonicalJson(layout);
