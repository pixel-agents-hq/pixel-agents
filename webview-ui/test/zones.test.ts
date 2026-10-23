/**
 * Living-office zones (docs/office/DESIGN.md): layout Areas with reserved
 * labels parse into the places characters are sent to — Smoke spots around
 * the ashtray, Server spots in front of the racks, the seats of the Lounge,
 * Meeting room and Cafe, and the Entrance door. A layout without those
 * labels parses to nothing, which is what keeps it behaving as before.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { Direction } from '../src/office/types.js';
import type { OfficeZones } from '../src/office/zones.js';
import { toZoneLabel, ZoneLabel } from '../src/office/zones.js';
import {
  chair,
  installZoneCatalog,
  layoutFrom,
  OFFICE_FURNITURE,
  OFFICE_MAP,
  zonedOffice,
} from './livingOfficeFixture.js';

beforeAll(installZoneCatalog);

const places = (zones: OfficeZones, label: ZoneLabel) =>
  (zones.zones.get(label)?.places ?? []).map((p) => ({
    col: p.col,
    row: p.row,
    facing: p.facing,
    sit: p.sit,
  }));

describe('parsing the zones of a layout', () => {
  let zones: OfficeZones;
  beforeAll(() => {
    zones = zonedOffice().zones;
  });

  it('finds every routed zone, but not the desks room', () => {
    expect([...zones.zones.keys()].sort()).toEqual(
      ['Cafe', 'Entrance', 'Lounge', 'Meeting', 'Server', 'Smoke'].sort(),
    );
    expect(zones.zones.has(ZoneLabel.DEV)).toBe(false);
  });

  it('Smoke: the walkable tiles around the ashtray, each facing it', () => {
    const smoke = places(zones, ZoneLabel.SMOKE);
    expect(smoke).toHaveLength(5);
    expect(smoke).toEqual(
      expect.arrayContaining([
        { col: 10, row: 2, facing: Direction.RIGHT, sit: false },
        { col: 12, row: 2, facing: Direction.LEFT, sit: false },
        { col: 10, row: 3, facing: Direction.RIGHT, sit: false },
        { col: 12, row: 3, facing: Direction.LEFT, sit: false },
        { col: 11, row: 4, facing: Direction.UP, sit: false }, // below it
      ]),
    );
    // Never the ashtray's own tiles, even its walkable background row...
    expect(smoke.some((p) => p.col === 11 && (p.row === 2 || p.row === 3))).toBe(false);
    // ...nor above that row: it's the see-through top of the sprite, a tile off the bowl.
    expect(smoke.some((p) => p.col === 11 && p.row === 1)).toBe(false);
  });

  it('Server: the tiles in front of the racks, facing them, and the racks to light up', () => {
    expect(places(zones, ZoneLabel.SERVER)).toEqual([
      { col: 15, row: 3, facing: Direction.UP, sit: false },
      { col: 16, row: 3, facing: Direction.UP, sit: false },
    ]);
    expect(zones.rackTiles.sort()).toEqual(['15,1', '15,2', '16,1', '16,2'].sort());
  });

  it('Lounge, Meeting, Cafe: their seats', () => {
    const uids = (label: ZoneLabel) =>
      (zones.zones.get(label)?.places ?? []).map((p) => p.key).sort();
    expect(uids(ZoneLabel.LOUNGE)).toEqual(['l1', 'l2']);
    expect(uids(ZoneLabel.MEETING)).toEqual(['m0', 'm1', 'm2']);
    expect(uids(ZoneLabel.CAFE)).toEqual(['c1', 'c2']);
    expect(zones.zones.get(ZoneLabel.CAFE)!.places.every((p) => p.sit)).toBe(true);
  });

  it('Entrance: the door is its walkable tile on the outer edge', () => {
    expect(zones.door).toEqual({
      col: 19,
      row: 7,
      inward: Direction.LEFT,
      outward: Direction.RIGHT,
    });
  });

  it('a door several tiles wide resolves to its middle', () => {
    const map = [...OFFICE_MAP];
    map[6] = 'WLLLLMMMMMCCCCEEEEEE';
    map[8] = 'WLLLLMMMMMCCCCEEEEEE';
    const { door } = zonedOffice(OFFICE_FURNITURE, map).zones;
    expect([door?.col, door?.row]).toEqual([19, 7]);
  });

  it('with no Entrance tile on the edge, the door is the one nearest to it', () => {
    const map = [...OFFICE_MAP];
    map[7] = 'WLLLLMMMMMCCCCEEEEEW'; // wall the door up
    const { door } = zonedOffice(OFFICE_FURNITURE, map).zones;
    expect(door).not.toBeNull();
    const toEdge = Math.min(door!.col, 19 - door!.col, door!.row, 9 - door!.row);
    expect(toEdge).toBe(1); // one tile in from the wall, the closest an Entrance tile gets
  });

  it('Smoke without an ashtray falls back to any walkable Smoke tile', () => {
    const furniture = OFFICE_FURNITURE.filter((f) => f.type !== 'ASHTRAY_STAND');
    const smoke = places(zonedOffice(furniture).zones, ZoneLabel.SMOKE);
    expect(smoke).toHaveLength(4 * 4); // the whole 4×4 terrace
  });

  it('matches labels case-insensitively', () => {
    expect(toZoneLabel('lounge')).toBe(ZoneLabel.LOUNGE);
    expect(toZoneLabel(' SMOKE ')).toBe(ZoneLabel.SMOKE);
    expect(toZoneLabel('Engineering')).toBeNull();
    expect(toZoneLabel(null)).toBeNull();
  });
});

describe('a layout without zones', () => {
  it('parses to no zones and no door: no Areas at all', () => {
    const os = new OfficeState(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE, { withAreas: false }));
    expect(os.zones.zones.size).toBe(0);
    expect(os.zones.door).toBeNull();
    expect(os.zones.rackTiles).toEqual([]);
  });

  it('parses to no zones and no door: only a user’s own Areas', () => {
    const map = OFFICE_MAP.map((line) => line.replace(/[DKSLMCE]/g, 'X'));
    const os = new OfficeState(layoutFrom(map, [chair('d1', 2, 2)]));
    expect(os.zones.zones.size).toBe(0);
    expect(os.zones.door).toBeNull();
  });

  it('a layout rebuild re-parses the zones', () => {
    const os = new OfficeState(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE, { withAreas: false }));
    os.rebuildFromLayout(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE));
    expect(os.zones.zones.has(ZoneLabel.SMOKE)).toBe(true);
    expect(os.zones.door).not.toBeNull();
  });
});
