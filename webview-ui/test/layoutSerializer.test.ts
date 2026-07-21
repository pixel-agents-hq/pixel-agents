/**
 * Tests for the `migrateLayoutColors` migration path (which wraps
 * the internal `migrateLayout` function — the only public migration entrypoint).
 *
 * Focused on the pet-system extension: legacy layouts (no `pets` field)
 * must be migrated to include `pets: []`. Layouts with existing `pets`
 * must preserve them unchanged.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ColorValue } from '../src/components/ui/types.js';
import { migrateLayoutColors } from '../src/office/layout/layoutSerializer.js';
import type { OfficeLayout, PlacedFurniture, PlacedPet } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

// ── Helpers ────────────────────────────────────────────────────

function baseLayout(overrides: Partial<OfficeLayout> = {}): OfficeLayout {
  // 4×3 minimum layout. layoutRevision = 1 to skip the OLD_VOID branch and
  // tileColors length-match to skip the tileColors-generation early return.
  const cols = 4;
  const rows = 3;
  const tiles = new Array(cols * rows).fill(TileType.FLOOR_1);
  const tileColors: Array<ColorValue | null> = new Array(cols * rows).fill(null);
  return {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    tileColors,
    layoutRevision: 1,
    ...overrides,
  };
}

// ── Migration: pets field absent ──────────────────────────────

test('migrateLayoutColors injects pets:[] when missing on a fresh layout', () => {
  const layout = baseLayout();
  // Sanity precondition: no pets field on the input.
  assert.equal(layout.pets, undefined);
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

test('migrateLayoutColors injects pets:[] even when tileColors triggers the early-return path', () => {
  // tileColors already populated with the right length → early-return guard fires.
  // The pets-default block must run BEFORE that early return.
  const layout = baseLayout(); // already has matching tileColors
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

test('migrateLayoutColors handles pets: null (corrupted JSON) by defaulting to []', () => {
  const layout = baseLayout({ pets: null as unknown as PlacedPet[] | undefined });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: pets preserved ─────────────────────────────────

test('migrateLayoutColors preserves an existing non-empty pets array', () => {
  const pets: PlacedPet[] = [
    { id: 'pet-1', petType: 0 },
    { id: 'pet-2', petType: 1 },
  ];
  const layout = baseLayout({ pets });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, pets);
});

test('migrateLayoutColors preserves an empty pets array (does not overwrite)', () => {
  const layout = baseLayout({ pets: [] });
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: pets + tileColors regeneration interaction ─────

test('migrateLayoutColors injects pets:[] AND regenerates tileColors when missing', () => {
  // Force the tileColors path by stripping tileColors entirely.
  const layout: OfficeLayout = {
    version: 1,
    cols: 4,
    rows: 3,
    tiles: new Array(12).fill(TileType.FLOOR_1),
    furniture: [],
    layoutRevision: 1,
  };
  const migrated = migrateLayoutColors(layout);
  assert.deepEqual(migrated.pets, []);
  assert.ok(Array.isArray(migrated.tileColors));
  assert.equal(migrated.tileColors!.length, 12);
});

// ── Migration: OLD_VOID + pets interaction ────────────────────

test('migrateLayoutColors handles OLD_VOID tile migration AND pets:[] injection together', () => {
  // Mark as legacy: no layoutRevision, contains OLD_VOID=8.
  const cols = 4;
  const rows = 3;
  const tiles: number[] = new Array(cols * rows).fill(TileType.FLOOR_1);
  tiles[0] = 8; // OLD_VOID literal
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: tiles as OfficeLayout['tiles'],
    furniture: [],
  };
  const migrated = migrateLayoutColors(layout);
  assert.equal(migrated.tiles[0], TileType.VOID);
  assert.deepEqual(migrated.pets, []);
});

// ── Migration: returned layout retains other fields ───────────

test('migrateLayoutColors preserves furniture and other fields untouched', () => {
  const furniture: PlacedFurniture[] = [{ uid: 'f-1', type: 'desk_basic', col: 1, row: 1 }];
  const layout = baseLayout({ furniture, pets: [{ id: 'p1', petType: 0 }] });
  const migrated = migrateLayoutColors(layout);
  assert.equal(migrated.furniture.length, 1);
  // The migrator may rewrite furniture types, so compare uid/col/row, not the
  // raw type string.
  assert.equal(migrated.furniture[0].uid, 'f-1');
  assert.equal(migrated.furniture[0].col, 1);
  assert.equal(migrated.furniture[0].row, 1);
  assert.deepEqual(migrated.pets, [{ id: 'p1', petType: 0 }]);
  assert.equal(migrated.cols, 4);
  assert.equal(migrated.rows, 3);
  assert.equal(migrated.version, 1);
});

// ── Migration: idempotency ────────────────────────────────────

test('migrateLayoutColors is idempotent (running twice produces equivalent output)', () => {
  const layout = baseLayout();
  const once = migrateLayoutColors(layout);
  const twice = migrateLayoutColors(once);
  assert.deepEqual(twice.pets, once.pets);
  assert.deepEqual(twice.tiles, once.tiles);
  assert.deepEqual(twice.tileColors, once.tileColors);
});
