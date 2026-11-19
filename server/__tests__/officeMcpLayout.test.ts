/**
 * get_layout and list_catalog through the Pixel Office MCP's main seam: a
 * composed standalone server reading a seeded ~/.pixel-agents/layout.json and
 * the bundled furniture, floors, walls, carpets and pets, an agent launched
 * over /ws (mock-claude in a real PTY), and the MCP SDK's client calling the
 * tools with that agent's token. Asserted only on what the client gets back.
 */

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

describe('get_layout and list_catalog (composed server, seeded layout.json)', () => {
  let furniture: LoadedAssets;
  let pets: LoadedPetSprites;
  let counts: OfficeAssetCounts;

  beforeAll(async () => {
    ({ furniture, pets, counts } = await loadBundledAssets());
  });

  const h = useStandaloneOffice({
    name: 'pxl-mcp-layout',
    // The seeded office, where the real persistence path reads it.
    prepare: ({ home }) => seedLayoutFile(home, seededLayout()),
    layout: 'file',
    catalog: () => furniture.catalog,
    assets: () => ({ ...counts, pets: pets.manifests }),
  });
  const { send } = h;

  // ── Helpers ─────────────────────────────────────────────────

  /** Consent, launch one agent from the office, and connect as it. */
  async function agentClient(): Promise<{
    client: Awaited<ReturnType<typeof h.mcpClient>>;
    id: number;
  }> {
    await h.answer('allow');
    return h.launchAgent();
  }

  const call = h.callJson;

  // ── get_layout ──────────────────────────────────────────────

  it('summary: grid, Areas with colour, box, tiles, Directories and free seats — no item list', async () => {
    send({ type: 'saveAreaMappings', mappings: { proj: ['Blue room'] } });
    await waitFor(() => readConfig().standalone.areaMappings.proj, 'the mapping save');
    const { client, id } = await agentClient();

    const summary = await call(client, 'get_layout');
    expect(summary.detail).toBe('summary');
    expect(summary.grid).toMatchObject({ cols: 21, rows: 22, max_cols: 64, max_rows: 64 });
    expect(summary.furniture).toBeUndefined();
    expect(summary.map).toBeUndefined();
    expect(JSON.stringify(summary).length).toBeLessThan(3000);

    const [blue, api] = summary.areas as Json[];
    expect(blue).toMatchObject({
      label: 'Blue room',
      letter: 'A',
      color: BLUE,
      color_name: 'blue',
      bounds: { col: 1, row: 11, width: 9, height: 10 },
      tiles: 90,
      directories: [{ name: 'proj', path: h.workspace }],
    });
    expect(api).toMatchObject({
      label: 'API',
      letter: 'B',
      color_name: 'red',
      bounds: { col: 11, row: 11, width: 8, height: 10 },
      directories: [],
    });
    // Chairs: four wooden chairs + two benches in the Blue room, four sofas in API.
    expect(blue.seats).toBeGreaterThan(0);
    expect(api.seats).toBeGreaterThan(0);
    expect(blue.free_seats).toHaveLength(blue.seats);
    expect(summary.seats.total).toBe(blue.seats + api.seats + summary.seats.outside_areas.seats);
    expect(summary.furniture_counts).toMatchObject({
      desks: expect.any(Number),
      chairs: expect.any(Number),
    });
    const counted = Object.values(summary.furniture_counts as Record<string, number>);
    expect(counted.reduce((a, b) => a + b, 0)).toBe(summary.furniture_total);

    // Seated in the Blue room: that seat is no longer free.
    const seat = blue.free_seats[0] as string;
    send({ type: 'saveAgentSeats', seats: { [id]: { seatId: seat } } });
    await waitFor(() => h.store.getAdapter()?.loadSeats()[String(id)]?.seatId, 'the seat save');
    const after = await call(client, 'get_layout', { detail: 'summary' });
    expect(after.areas[0].free_seats).not.toContain(seat);
    expect(after.areas[0].free_seats).toHaveLength(blue.seats - 1);
    expect(after.seats.free).toBe(summary.seats.free - 1);
  });

  it('furniture: items with uid, type, footprint, orientation, state, Area — narrowed by each filter', async () => {
    const { client } = await agentClient();
    const all = (await call(client, 'get_layout', { detail: 'furniture' })).furniture as Json[];
    expect(all).toHaveLength(36);

    const pc = all.find((f) => f.type === 'PC_FRONT_OFF' && f.col === 3)!;
    expect(pc).toMatchObject({
      label: 'PC',
      category: 'electronics',
      row: 12,
      footprint: { width: 1, height: 2 },
      orientation: 'front',
      state: 'off',
      color: null,
      area: 'Blue room',
    });
    expect(pc.uid).toEqual(expect.any(String));
    // A wall item belongs to the room below it.
    expect(all.find((f) => f.type === 'CLOCK')).toMatchObject({
      category: 'wall',
      area: 'Blue room',
    });
    expect(all.find((f) => f.type === 'SOFA_SIDE:left')).toMatchObject({
      orientation: 'left',
      area: 'API',
    });

    const chairs = (await call(client, 'get_layout', { detail: 'furniture', category: 'chairs' }))
      .furniture as Json[];
    expect(chairs.length).toBeGreaterThan(0);
    expect(chairs.every((f) => f.category === 'chairs')).toBe(true);
    expect(chairs).toHaveLength(all.filter((f) => f.category === 'chairs').length);

    const api = (await call(client, 'get_layout', { detail: 'furniture', area: 'api' }))
      .furniture as Json[];
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((f) => f.area === 'API')).toBe(true);
    expect(api.map((f) => f.type)).toContain('COFFEE_TABLE');

    const desk = (
      await call(client, 'get_layout', {
        detail: 'furniture',
        rect: { col: 2, row: 12, width: 2, height: 1 },
      })
    ).furniture as Json[];
    expect(desk.map((f) => f.type).sort()).toEqual(['DESK_FRONT', 'PC_FRONT_OFF']);

    const combined = (
      await call(client, 'get_layout', {
        detail: 'furniture',
        area: 'Blue room',
        category: 'electronics',
      })
    ).furniture as Json[];
    expect(combined).toHaveLength(6);

    expect((await call(client, 'get_layout', { area: 'Kitchen' })).error).toMatch(
      /No Area "Kitchen".*"Blue room", "API"/,
    );
  });

  it('tiles: an ASCII map of wall, floor, void and Area letters, cropped to an Area or a rectangle', async () => {
    const { client } = await agentClient();
    const full = (await call(client, 'get_layout', { detail: 'tiles' })).map as Json;
    expect(full).toMatchObject({ origin: { col: 0, row: 0 }, width: 21, height: 22 });
    expect(full.legend).toMatchObject({
      '#': 'wall',
      '.': 'floor outside any Area',
      '-': 'void (no tile)',
      A: 'floor in Area "Blue room"',
      B: 'floor in Area "API"',
    });
    expect(full.rows[0]).toBe('-'.repeat(21));
    expect(full.rows[10]).toBe('#'.repeat(20) + '-');
    expect(full.rows[14]).toBe('#' + 'A'.repeat(9) + '.' + 'B'.repeat(8) + '#-');
    expect(full.ruler).toBe('012345678901234567890');

    const room = (await call(client, 'get_layout', { detail: 'tiles', area: 'API' })).map as Json;
    expect(room).toMatchObject({ origin: { col: 11, row: 11 }, width: 8, height: 10 });
    expect(room.rows.every((r: string) => r === 'BBBBBBBB')).toBe(true);

    const corner = (
      await call(client, 'get_layout', {
        detail: 'tiles',
        rect: { col: 8, row: 12, width: 4, height: 3 },
      })
    ).map as Json;
    expect(corner.origin).toEqual({ col: 8, row: 12 });
    expect(corner.rows).toEqual(['AA#B', 'AA#B', 'AA.B']);

    expect(
      (
        await call(client, 'get_layout', {
          detail: 'tiles',
          rect: { col: 40, row: 0, width: 2, height: 2 },
        })
      ).error,
    ).toMatch(/outside the 21×22 grid/);
  });

  // ── list_catalog ────────────────────────────────────────────

  it('list_catalog: placement rules, rotations and states for every type, plus floors, walls, carpets and pets', async () => {
    const { client } = await agentClient();
    const catalog = await call(client, 'list_catalog');

    const desk = (catalog.furniture as Json[]).find((f) => f.type === 'DESK_FRONT')!;
    expect(desk).toMatchObject({
      label: 'Desk',
      category: 'desks',
      is_desk: true,
      can_place_on_surfaces: false,
      can_place_on_walls: false,
    });
    expect(desk.orientations.map((o: Json) => o.orientation)).toContain('front');

    const pc = (catalog.furniture as Json[]).find((f) => f.type === 'PC_FRONT_OFF')!;
    expect(pc).toMatchObject({ can_place_on_surfaces: true, background_rows: 1 });
    expect(pc.orientations).toContainEqual(
      expect.objectContaining({
        orientation: 'front',
        type: 'PC_FRONT_OFF',
        on_type: 'PC_FRONT_ON_1',
      }),
    );
    const clock = (catalog.furniture as Json[]).find((f) => f.type === 'CLOCK')!;
    expect(clock).toMatchObject({ can_place_on_walls: true, category: 'wall' });

    // Every type it names is a real catalogue type with the footprint it states.
    const entries = new Map(furniture.catalog.map((a) => [a.id, a]));
    for (const item of catalog.furniture as Json[]) {
      for (const variant of [item, ...((item.orientations as Json[]) ?? [])]) {
        const id = String(variant.type).replace(/:left$/, '');
        expect(entries.get(id), variant.type).toBeDefined();
        expect(variant.footprint).toEqual({
          width: entries.get(id)!.footprintW,
          height: entries.get(id)!.footprintH,
        });
        if (variant.on_type) expect(entries.get(variant.on_type)?.state).toBe('on');
      }
    }

    expect(catalog.floor_patterns).toEqual(
      Array.from({ length: 9 }, (_, i) => ({ pattern: i + 1 })),
    );
    expect(catalog.wall_sets.slice(0, 2)).toEqual([
      { wall_set: 0, label: 'Plain' },
      { wall_set: 1, label: 'Brick' },
    ]);
    expect(catalog.wall_sets).toHaveLength(counts.wallSets);
    expect(catalog.carpets).toEqual([{ variant: 0 }, { variant: 1 }, { variant: 2 }]);
    expect(catalog.pets).toEqual([
      { pet_type: 0, id: 'claudio', name: 'Claudio' },
      { pet_type: 1, id: 'gitcat', name: 'Gitcat' },
    ]);
    expect(catalog.rules).toMatchObject({
      coordinates: expect.any(String),
      walls: expect.any(String),
    });

    const desks = await call(client, 'list_catalog', { category: 'desks' });
    expect((desks.furniture as Json[]).every((f) => f.category === 'desks')).toBe(true);
    expect(desks.furniture.length).toBeGreaterThan(0);
  });
});
