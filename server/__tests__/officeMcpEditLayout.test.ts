/**
 * edit_layout and undo_layout_edit through the Pixel Office MCP's main seam: a
 * composed standalone server over a seeded ~/.pixel-agents/layout.json and the
 * bundled assets, an agent launched over /ws (mock-claude in a real PTY), the
 * MCP SDK's client calling the tools with that agent's token, and offices on
 * /ws reporting their editor's unsaved changes and pressing "Undo <agent>'s
 * edit". Asserted on what the client gets back, what lands in layout.json and
 * config.json, and what every office is sent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { LoadedAssets, LoadedPetSprites } from '../src/assetLoader.js';
import { readConfig } from '../src/configPersistence.js';
import {
  BLUE,
  type Json,
  loadBundledAssets,
  type OfficeAssetCounts,
  seededLayout,
  seedLayoutFile,
  useStandaloneOffice,
  waitFor,
} from './helpers/officeMcpHarness.js';

const GREEN = ['#', '22c55e'].join('');
const WALL = 0;
const VOID = 255;

describe('edit_layout and undo_layout_edit (composed server, seeded layout.json)', () => {
  let furniture: LoadedAssets;
  let pets: LoadedPetSprites;
  let counts: OfficeAssetCounts;

  beforeAll(async () => {
    ({ furniture, pets, counts } = await loadBundledAssets());
  });

  const h = useStandaloneOffice({
    name: 'pxl-mcp-edit',
    prepare: ({ home }) => seedLayoutFile(home, seededLayout()),
    layout: 'file',
    catalog: () => furniture.catalog,
    assets: () => ({ ...counts, pets: pets.manifests }),
  });
  const { send } = h;

  // ── Helpers ─────────────────────────────────────────────────

  function layoutFile(): string {
    return path.join(h.home, '.pixel-agents', 'layout.json');
  }

  function onDisk(): Json {
    return JSON.parse(fs.readFileSync(layoutFile(), 'utf8')) as Json;
  }

  /** Consent, launch one agent from the office, and connect as it. */
  async function agentClient(): Promise<{
    client: Awaited<ReturnType<typeof h.mcpClient>>;
    id: number;
  }> {
    await h.answer('allow');
    return h.launchAgent();
  }

  const call = h.callJson;
  const edit = (client: Parameters<typeof call>[0], ops: Json[]) =>
    call(client, 'edit_layout', { ops });

  function item(layout: Json, uid: string): Json | undefined {
    return (layout.furniture as Json[]).find((f) => f.uid === uid);
  }

  function idx(layout: Json, col: number, row: number): number {
    return row * (layout.cols as number) + col;
  }

  /** The newest layoutLoaded an office was sent after `from`. */
  function lastLayout(log: Json[], from: number): Json | undefined {
    return log
      .slice(from)
      .filter((m) => m.type === 'layoutLoaded')
      .pop()?.layout;
  }

  // ── Furniture ───────────────────────────────────────────────

  it('furniture: place (desk + PC on it + wall clock), move with riders, recolour, toggle, remove — saved and broadcast', async () => {
    const { client } = await agentClient();
    const before = h.received.length;

    const placed = await edit(client, [
      { op: 'place_furniture', type: 'DESK_FRONT', col: 12, row: 18, uid: 'desk1' },
      { op: 'place_furniture', type: 'PC_FRONT_OFF', col: 13, row: 18, uid: 'pc1' },
      { op: 'place_furniture', type: 'CLOCK', col: 16, row: 9 },
      { op: 'place_furniture', type: 'BIN', col: 17, row: 11, color: { h: 30, s: 10, b: 0, c: 0 } },
    ]);
    expect(placed).toMatchObject({ applied: 4, changed: true, grid: { cols: 21, rows: 22 } });
    expect(placed.placed).toHaveLength(4);
    expect(placed.placed[0]).toEqual({ op: 0, uid: 'desk1', type: 'DESK_FRONT' });
    const clockUid = placed.placed[2].uid as string;
    const binUid = placed.placed[3].uid as string;

    let disk = onDisk();
    expect(item(disk, 'desk1')).toMatchObject({ type: 'DESK_FRONT', col: 12, row: 18 });
    expect(item(disk, 'pc1')).toMatchObject({ col: 13, row: 18 });
    // A wall item is placed by its top-left: the bottom row (10) is the wall.
    expect(item(disk, clockUid)).toMatchObject({ type: 'CLOCK', col: 16, row: 9 });
    expect(item(disk, binUid)!.color).toEqual({ h: 30, s: 10, b: 0, c: 0 });
    // Every office is shown the edit, once.
    await waitFor(() => lastLayout(h.received, before), 'the broadcast');
    expect(h.received.slice(before).filter((m) => m.type === 'layoutLoaded')).toHaveLength(1);
    expect(item(lastLayout(h.received, before)!, 'pc1')).toBeDefined();

    // The desk carries the PC; the bin turns off-colour; the PC switches on and back.
    const changed = await edit(client, [
      { op: 'move_furniture', uid: 'desk1', col: 11, row: 19 },
      { op: 'recolor_furniture', uid: binUid, color: null },
      { op: 'toggle_furniture', uid: 'pc1', state: 'on' },
      { op: 'toggle_furniture', uid: 'pc1' },
      { op: 'remove_furniture', uid: clockUid },
    ]);
    expect(changed.changed).toBe(true);
    disk = onDisk();
    expect(item(disk, 'desk1')).toMatchObject({ col: 11, row: 19 });
    expect(item(disk, 'pc1')).toMatchObject({ type: 'PC_FRONT_OFF', col: 12, row: 19 });
    expect(item(disk, binUid)!.color).toBeUndefined();
    expect(item(disk, clockUid)).toBeUndefined();

    // Rotating a chair: front → right is another type of the group.
    const chair = await edit(client, [
      { op: 'place_furniture', type: 'WOODEN_CHAIR_FRONT', col: 16, row: 19, uid: 'chair1' },
      { op: 'rotate_furniture', uid: 'chair1', orientation: 'left' },
    ]);
    expect(chair.changed).toBe(true);
    expect(item(onDisk(), 'chair1')!.type).toBe('WOODEN_CHAIR_SIDE:left');
  });

  it('a refused batch names the op and why, and leaves layout.json and every office untouched', async () => {
    const { client } = await agentClient();
    const bytes = fs.readFileSync(layoutFile(), 'utf8');
    const before = h.received.length;

    const overlap = await edit(client, [
      { op: 'place_furniture', type: 'BIN', col: 12, row: 19 },
      { op: 'paint_floor', tiles: [{ col: 12, row: 12, width: 2, height: 2 }], pattern: 2 },
      // The table's solid row (its top row is a background row).
      { op: 'place_furniture', type: 'BIN', col: 17, row: 20 },
    ]);
    expect(overlap.error).toMatch(
      /^op 2 \(place_furniture\): BIN \(1x1\) at \(17, 20\) overlaps SMALL_TABLE_FRONT/,
    );
    expect(overlap.error).toMatch(/Nothing was changed\.$/);

    const errors = await Promise.all([
      edit(client, [{ op: 'place_furniture', type: 'NOPE', col: 1, row: 1 }]),
      edit(client, [{ op: 'place_furniture', type: 'BIN', col: 10, row: 11 }]),
      edit(client, [{ op: 'place_furniture', type: 'CLOCK', col: 3, row: 14 }]),
      edit(client, [{ op: 'move_furniture', uid: 'ghost', col: 1, row: 1 }]),
      edit(client, [{ op: 'erase', tiles: [{ col: 30, row: 1 }] }]),
      edit(client, [{ op: 'paint_floor', tiles: [{ col: 1, row: 1 }], pattern: 99 }]),
      edit(client, [{ op: 'paint_carpet', tiles: [{ col: 1, row: 11 }], variant: 99 }]),
      edit(client, [{ op: 'create_area', label: 'api', color: GREEN }]),
      edit(client, [{ op: 'paint_area', label: 'Kitchen', tiles: [{ col: 1, row: 11 }] }]),
      edit(client, [{ op: 'map_directory', directory: 'nowhere', area: 'API' }]),
      edit(client, [{ op: 'rotate_furniture', uid: 'f-1773357087399-3kfy', orientation: 'left' }]),
      edit(client, [{ op: 'resize_grid', right: -2 }]),
      edit(client, [{ op: 'resize_grid', left: 50 }]),
    ]);
    const reasons = errors.map((e) => e.error as string);
    expect(reasons[0]).toMatch(/op 0 \(place_furniture\): unknown furniture type "NOPE"/);
    expect(reasons[1]).toMatch(/tile \(10, 11\) is a wall/);
    expect(reasons[2]).toMatch(/bottom row must lie on wall tiles/);
    expect(reasons[3]).toMatch(/no furniture with uid "ghost"/);
    expect(reasons[4]).toMatch(/tile \(30, 1\) is outside the 21x22 grid/);
    expect(reasons[5]).toMatch(/floor pattern 99 doesn't exist/);
    expect(reasons[6]).toMatch(/carpet variant 99 doesn't exist/);
    expect(reasons[7]).toMatch(/an Area "API" already exists/);
    expect(reasons[8]).toMatch(/no Area "Kitchen"/);
    expect(reasons[9]).toMatch(/no Directory "nowhere"/);
    expect(reasons[10]).toMatch(/has only one orientation/);
    expect(reasons[11]).toMatch(
      /op 0 \(resize_grid\): the right edge isn't empty after 1 of 2 cuts/,
    );
    expect(reasons[12]).toMatch(/can't grow past 64/);
    // Schema errors are refused before anything runs, with the op's path.
    const badColor = await edit(client, [
      {
        op: 'paint_floor',
        tiles: [{ col: 1, row: 11 }],
        pattern: 1,
        color: { h: 500, s: 0, b: 0, c: 0 },
      },
    ]);
    expect(JSON.stringify(badColor)).toMatch(/colorize mode/);

    expect(fs.readFileSync(layoutFile(), 'utf8')).toBe(bytes);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.received.slice(before).some((m) => m.type === 'layoutLoaded')).toBe(false);
  });

  // ── Tiles ───────────────────────────────────────────────────

  it('floor, walls, erase and carpets: rectangles and tile lists, each the editor op', async () => {
    const { client } = await agentClient();
    const result = await edit(client, [
      // A new room in the void above: floor, then a wall ring of set 2.
      {
        op: 'paint_floor',
        tiles: [{ col: 2, row: 2, width: 4, height: 3 }],
        pattern: 3,
        color: { h: 200, s: 40, b: 5, c: 0 },
      },
      {
        op: 'paint_walls',
        tiles: [
          { col: 1, row: 1, width: 6, height: 1 },
          { col: 1, row: 2 },
          { col: 6, row: 2 },
        ],
        wall_set: 2,
        color: { h: 20, s: 30, b: 0, c: 0, colorize: true },
      },
      { op: 'paint_walls', tiles: [{ col: 6, row: 3 }] },
      {
        op: 'remove_walls',
        tiles: [
          { col: 6, row: 2 },
          { col: 3, row: 3 },
        ],
        pattern: 4,
      },
      {
        op: 'paint_carpet',
        tiles: [
          { col: 2, row: 2, width: 2, height: 2 },
          { col: 1, row: 1 },
        ],
        variant: 0,
        color: { h: 10, s: 50, b: 0, c: 0 },
      },
      { op: 'remove_carpet', tiles: [{ col: 2, row: 2 }] },
      // The bin at (2, 20) goes with its tile.
      { op: 'erase', tiles: [{ col: 2, row: 20 }] },
    ]);
    expect(result.changed).toBe(true);
    expect(result.notes).toEqual([
      'op 3 (remove_walls): 1 of 2 tiles were not walls and were left alone',
      'op 4 (paint_carpet): 1 of 5 tiles are walls or void and got no carpet',
      'op 6 (erase): removed 1 furniture item standing there',
    ]);

    const disk = onDisk();
    expect(disk.tiles[idx(disk, 3, 3)]).toBe(3);
    expect(disk.tileColors[idx(disk, 3, 3)]).toEqual({ h: 200, s: 40, b: 5, c: 0 });
    expect(disk.tiles[idx(disk, 1, 1)]).toBe(WALL);
    expect(disk.wallSets[idx(disk, 1, 1)]).toBe(2);
    // Walls keep no colorize flag (always tinted).
    expect(disk.tileColors[idx(disk, 1, 1)]).toEqual({ h: 20, s: 30, b: 0, c: 0 });
    // A wall painted with no look takes an existing wall's (the first one: the new set 2 ring).
    expect(disk.tiles[idx(disk, 6, 3)]).toBe(WALL);
    expect(disk.wallSets[idx(disk, 6, 3)]).toBe(2);
    // The removed wall is floor of pattern 4 and holds no wall set.
    expect(disk.tiles[idx(disk, 6, 2)]).toBe(4);
    expect(disk.wallSets[idx(disk, 6, 2)]).toBeNull();
    expect(disk.carpetTiles[idx(disk, 3, 3)]).toMatchObject({
      variant: 0,
      color: { h: 10, colorize: true },
    });
    expect(disk.carpetTiles[idx(disk, 2, 2)]).toBeNull();
    expect(disk.tiles[idx(disk, 2, 20)]).toBe(VOID);
    expect(item(disk, 'f-1773357087399-3kfy')).toBeUndefined();
  });

  it('pets: placed and removed by pet_type, one of each', async () => {
    const { client } = await agentClient();
    expect(await edit(client, [{ op: 'place_pet', pet_type: 0 }])).toMatchObject({ changed: true });
    expect(onDisk().pets).toEqual([{ id: expect.any(String), petType: 0 }]);
    const again = await edit(client, [{ op: 'place_pet', pet_type: 0 }]);
    expect(again).toMatchObject({
      changed: false,
      notes: ['op 0 (place_pet): that pet is already in the office (one of each)'],
    });
    await edit(client, [{ op: 'remove_pet', pet_type: 0 }]);
    expect(onDisk().pets).toEqual([]);
    const missing = await edit(client, [{ op: 'place_pet', pet_type: pets.manifests.length }]);
    expect(missing.error).toMatch(/pet_type \d+ doesn't exist/);
  });

  // ── Areas and Directories ───────────────────────────────────

  it('Areas: create, paint, rename (mappings follow), recolour, unpaint, delete; Directories map and unmap', async () => {
    const { client } = await agentClient();
    const before = h.received.length;
    const made = await edit(client, [
      { op: 'create_area', label: 'Kitchen', color: GREEN },
      {
        op: 'paint_area',
        label: 'kitchen',
        tiles: [
          { col: 11, row: 18, width: 3, height: 3 },
          { col: 10, row: 18 },
        ],
      },
      { op: 'map_directory', directory: 'proj', area: 'Kitchen' },
    ]);
    expect(made.notes).toEqual([
      'op 1 (paint_area): 1 of 10 tiles are walls or void (Areas cover floor only)',
    ]);
    let disk = onDisk();
    expect(disk.areas).toContainEqual({ label: 'Kitchen', color: GREEN });
    expect(disk.areaTiles[idx(disk, 12, 19)]).toBe('Kitchen');
    expect(readConfig().standalone.areaMappings).toEqual({ proj: ['Kitchen'] });
    await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'areaMappingsLoaded'),
      'the mappings broadcast',
    );

    await edit(client, [
      { op: 'update_area', label: 'Kitchen', new_label: 'Galley', color: BLUE },
      { op: 'unpaint_area', tiles: [{ col: 11, row: 18, width: 3, height: 1 }], label: 'Galley' },
      { op: 'map_directory', directory: 'proj', area: 'API' },
    ]);
    disk = onDisk();
    expect(disk.areas).toContainEqual({ label: 'Galley', color: BLUE });
    expect(disk.areaTiles[idx(disk, 11, 18)]).toBeNull();
    expect(disk.areaTiles[idx(disk, 11, 19)]).toBe('Galley');
    expect(readConfig().standalone.areaMappings).toEqual({ proj: ['Galley', 'API'] });

    await edit(client, [
      { op: 'delete_area', label: 'Galley' },
      { op: 'unmap_directory', directory: 'proj', area: 'API' },
    ]);
    disk = onDisk();
    expect(disk.areas.map((a: Json) => a.label)).toEqual(['Blue room', 'API']);
    expect(disk.areaTiles.includes('Galley')).toBe(false);
    expect(readConfig().standalone.areaMappings).toEqual({});
  });

  // ── Grid ────────────────────────────────────────────────────

  it('resize_grid grows (shifting everything after it) and cuts empty edges only', async () => {
    const { client } = await agentClient();
    const result = await edit(client, [
      { op: 'resize_grid', left: 2, right: -1, top: -10 },
      // Coordinates after the resize: the bin once at (2, 20) is at (4, 10).
      { op: 'remove_furniture', uid: 'f-1773357087399-3kfy' },
      { op: 'place_furniture', type: 'BIN', col: 4, row: 10 },
    ]);
    expect(result.grid).toEqual({ cols: 22, rows: 12 });
    const disk = onDisk();
    expect(disk.cols).toBe(22);
    expect(disk.rows).toBe(12);
    expect(disk.tiles).toHaveLength(22 * 12);
    expect(disk.tiles[idx(disk, 2, 0)]).toBe(WALL);
    expect(disk.areaTiles[idx(disk, 3, 1)]).toBe('Blue room');
    // The wall clock hung at row 9 over the cut edge: it hangs at row -1 now.
    const clock = (disk.furniture as Json[]).find((f) => f.type === 'CLOCK')!;
    expect(clock).toMatchObject({ col: 7, row: -1 });
  });

  // ── Editing lock ────────────────────────────────────────────

  it('an office with unsaved editor changes blocks edits and undo; reporting clean or closing the socket lifts it', async () => {
    const { client } = await agentClient();
    const editor = await h.connectOffice();
    const op = [{ op: 'place_pet', pet_type: 0 }];

    send({ type: 'layoutEditing', dirty: true }, editor.socket);
    await new Promise((r) => setTimeout(r, 100));
    const locked = await edit(client, op);
    expect(locked.error).toMatch(/unsaved changes in the office layout editor/);
    expect(locked.error).toMatch(/[^.]\. Nothing was changed\.$/);
    expect((await call(client, 'undo_layout_edit')).error).toMatch(/unsaved changes/);
    expect(onDisk().pets ?? []).toEqual([]);

    send({ type: 'layoutEditing', dirty: false }, editor.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect(await edit(client, op)).toMatchObject({ changed: true });

    // Dirty again, then the office goes away: its report goes with it.
    send({ type: 'layoutEditing', dirty: true }, editor.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect((await edit(client, [{ op: 'remove_pet', pet_type: 0 }])).error).toMatch(/unsaved/);
    editor.socket.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(await edit(client, [{ op: 'remove_pet', pet_type: 0 }])).toMatchObject({
      changed: true,
    });
  });

  // ── Undo ────────────────────────────────────────────────────

  it('undo_layout_edit restores the layout and mappings before each edit, newest first', async () => {
    const { client, id } = await agentClient();
    const original = onDisk();
    await edit(client, [{ op: 'place_furniture', type: 'BIN', col: 12, row: 19, uid: 'bin-a' }]);
    await edit(client, [
      { op: 'erase', tiles: [{ col: 1, row: 11, width: 3, height: 1 }] },
      { op: 'map_directory', directory: 'proj', area: 'API' },
    ]);
    const status = await waitFor(
      () => h.received.find((m) => m.type === 'agentLayoutEditStatus' && m.agentId === id),
      'the undo status',
    );
    // Named as the office names it: its character.
    const me = ((await call(client, 'list_agents')).agents as Json[]).find((a) => a.id === id)!;
    expect(status.agentName).toBe(me.character.label);

    const undone = await call(client, 'undo_layout_edit');
    expect(undone).toMatchObject({ undone: true, edit_by_agent: id });
    let disk = onDisk();
    expect(disk.tiles[idx(disk, 1, 11)]).not.toBe(VOID);
    expect(item(disk, 'bin-a')).toBeDefined();
    expect(readConfig().standalone.areaMappings).toEqual({});

    await call(client, 'undo_layout_edit');
    disk = onDisk();
    expect(item(disk, 'bin-a')).toBeUndefined();
    expect(disk.furniture).toEqual(original.furniture);
    expect(disk.tiles).toEqual(original.tiles);

    expect((await call(client, 'undo_layout_edit')).error).toMatch(/no agent layout edit to undo/);
    expect(h.received.filter((m) => m.type === 'agentLayoutEditStatus').pop()).toEqual({
      type: 'agentLayoutEditStatus',
    });
  });

  it('undo is refused once the layout changed since — through the tool and the editor button alike', async () => {
    const { client, id } = await agentClient();
    await edit(client, [{ op: 'place_furniture', type: 'BIN', col: 12, row: 19, uid: 'bin-a' }]);

    // The editor button: a press undoes it, and every office sees the layout before it.
    const before = h.received.length;
    send({ type: 'undoAgentLayoutEdit' });
    const restored = await waitFor(() => lastLayout(h.received, before), 'the undo broadcast');
    expect(item(restored, 'bin-a')).toBeUndefined();
    expect(item(onDisk(), 'bin-a')).toBeUndefined();

    // Another edit, then a person saves over it: neither undo may discard their work.
    await edit(client, [{ op: 'place_furniture', type: 'BIN', col: 12, row: 19, uid: 'bin-b' }]);
    await waitFor(
      () => h.received.find((m) => m.type === 'agentLayoutEditStatus' && m.agentId === id),
      'the status',
    );
    const saved = onDisk();
    saved.furniture = (saved.furniture as Json[]).filter((f) => f.type !== 'CLOCK');
    const savedAt = h.received.length;
    send({ type: 'saveLayout', layout: saved });
    await waitFor(
      () =>
        h.received
          .slice(savedAt)
          .find((m) => m.type === 'agentLayoutEditStatus' && m.agentId === undefined),
      'the button to go',
    );
    expect((await call(client, 'undo_layout_edit')).error).toMatch(
      /layout changed since the last agent edit/,
    );
    const pressedAt = h.received.length;
    send({ type: 'undoAgentLayoutEdit' });
    const answer = await waitFor(
      () =>
        h.received.slice(pressedAt).find((m) => m.type === 'agentLayoutEditStatus' && m.refused),
      'the refusal',
    );
    expect(answer.refused).toMatch(/layout changed since/);
    expect(item(onDisk(), 'bin-b')).toBeDefined();
    expect((onDisk().furniture as Json[]).some((f) => f.type === 'CLOCK')).toBe(false);
  });

  it('read-only refuses edit_layout and undo_layout_edit', async () => {
    const { client } = await agentClient();
    const bytes = fs.readFileSync(layoutFile(), 'utf8');
    send({ type: 'setOfficeMcpReadOnly', readOnly: true });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.readOnly === true),
      'read-only',
    );
    expect((await edit(client, [{ op: 'place_pet', pet_type: 0 }])).error).toMatch(/read-only/);
    expect((await call(client, 'undo_layout_edit')).error).toMatch(/read-only/);
    expect(fs.readFileSync(layoutFile(), 'utf8')).toBe(bytes);
  });
});
