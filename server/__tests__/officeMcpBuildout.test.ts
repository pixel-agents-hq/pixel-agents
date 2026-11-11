/**
 * The Buildout's server half: an agent's layout edit is broadcast as
 * `layoutLoaded` carrying `buildout: { agentId, origin }` (plus the resize
 * `shift`, when the edit moved the grid's tiles), so every open office can
 * build it in. Undo, a person's save and the connect snapshot carry none, and
 * neither does an edit that names no tile. Driven through createLayoutEdits
 * (the one place an agent edit is committed and broadcast) over an in-memory
 * layout.
 */

import { describe, expect, it } from 'vitest';

import type { AreaMappings } from '../src/mcp/layoutEditOps.js';
import { createLayoutEdits, type LayoutEdits } from '../src/mcp/layoutEdits.js';

const FLOOR = 1;

type Json = Record<string, any>;

/** 8×6 floor, no furniture. */
function floorLayout(): Json {
  const cols = 8;
  const rows = 6;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<number>(cols * rows).fill(FLOOR),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [],
  };
}

describe('layoutLoaded.buildout (agent edits only)', () => {
  let saved: Json | null;
  let mappings: AreaMappings;
  let sent: Json[];
  let edits: LayoutEdits;
  let next = 0;
  /** How the office names each agent now (absent: it left). */
  let names: Map<number, string>;

  function setup(): void {
    saved = floorLayout();
    names = new Map();
    mappings = {};
    sent = [];
    edits = createLayoutEdits({
      readLayout: () => (saved ? (JSON.parse(JSON.stringify(saved)) as Json) : null),
      writeLayout: (layout) => {
        saved = JSON.parse(JSON.stringify(layout)) as Json;
      },
      catalog: () => null,
      assets: () => ({ floorPatterns: 9, wallSets: 1, carpets: 1, pets: 1 }),
      directories: () => ['proj'],
      readAreaMappings: () => mappings,
      writeAreaMappings: (m) => {
        mappings = m;
      },
      broadcast: (message) => sent.push(message),
      agentName: (id) => names.get(id) ?? `agent ${id}`,
      newId: () => `id-${next++}`,
    });
  }

  const layoutsSent = (): Json[] => sent.filter((m) => m.type === 'layoutLoaded');

  it('an agent edit carries its agent and origin (the first tile the batch names)', () => {
    setup();
    const result = edits.edit(7, [
      { op: 'paint_floor', tiles: [{ col: 5, row: 4 }], pattern: 2 },
      { op: 'paint_walls', tiles: [{ col: 1, row: 1 }] },
    ] as never);
    expect(result).toMatchObject({ ok: true, changed: true });
    const [msg] = layoutsSent();
    expect(msg.buildout).toEqual({ agentId: 7, origin: { col: 5, row: 4 } });
    expect(msg.layout).toEqual(saved);
  });

  it('the undo names the agent as it was called when it edited, after it left', () => {
    setup();
    names.set(7, 'Naruto');
    edits.edit(7, [{ op: 'paint_floor', tiles: [{ col: 5, row: 4 }], pattern: 2 }] as never);
    names.delete(7);
    expect(edits.statusMessage()).toMatchObject({ agentId: 7, agentName: 'Naruto' });
  });

  it('a resize that moves the tiles carries the shift, and the origin in the new grid', () => {
    setup();
    edits.edit(3, [
      { op: 'paint_walls', tiles: [{ col: 2, row: 0 }] },
      { op: 'resize_grid', left: 2, top: 1 },
    ] as never);
    const [msg] = layoutsSent();
    expect(msg.buildout).toEqual({ agentId: 3, origin: { col: 4, row: 1 } });
    expect(msg.shift).toEqual({ col: 2, row: 1 });
  });

  it('a resize alone that moves the tiles: no buildout, but the shift; its undo shifts back', () => {
    setup();
    edits.edit(3, [{ op: 'resize_grid', left: 1, top: 2 }] as never);
    const [msg] = layoutsSent();
    expect(msg.buildout).toBeUndefined();
    expect(msg.shift).toEqual({ col: 1, row: 2 });
    sent = [];
    expect(edits.undo()).toMatchObject({ ok: true });
    expect(layoutsSent()[0].shift).toEqual({ col: -1, row: -2 });
  });

  it('an edit that names no tile (a resize alone) carries no buildout', () => {
    setup();
    edits.edit(3, [{ op: 'resize_grid', right: 1 }] as never);
    const [msg] = layoutsSent();
    expect(msg).toBeDefined();
    expect(msg.buildout).toBeUndefined();
    expect(msg.shift).toBeUndefined();
  });

  it('undo carries no buildout', () => {
    setup();
    edits.edit(7, [{ op: 'paint_floor', tiles: [{ col: 1, row: 1 }], pattern: 3 }] as never);
    sent = [];
    expect(edits.undo()).toMatchObject({ ok: true, agentId: 7 });
    const [msg] = layoutsSent();
    expect(msg).toBeDefined();
    expect(msg.buildout).toBeUndefined();
  });
});
