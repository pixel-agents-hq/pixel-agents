/**
 * edit_layout's operations: the input an agent sends (zod, snake_case, in
 * get_layout / list_catalog's vocabulary) and ONE pure function applying a
 * batch of them, in order, to a copy of the layout and the Directory ↔ Area
 * mappings. Every decision — what fits, what a stroke paints, how a desk
 * carries its riders, how the grid grows — is core's (core/src/layout), the
 * same functions the editor calls; this module only checks the arguments,
 * explains a refusal, and records what the batch did.
 *
 * All or none: the first op that can't apply refuses the whole batch with its
 * index and a reason; nothing is written until every op applied.
 */

import { z } from 'zod';

import {
  addArea,
  addPet,
  canPlaceFurniture,
  catalogEntry,
  DEFAULT_WALL_COLOR,
  eraseArea,
  eraseCarpet,
  eraseTile,
  type ExpandDirection,
  expandLayout,
  freshFurnitureUid,
  type FurnitureCatalog,
  getPlacementBlockedTiles,
  hasPet,
  isFloorTile,
  MAX_COLS,
  MAX_ROWS,
  type OfficeLayout,
  orientationInGroup,
  paintArea,
  paintCarpet,
  paintTile,
  paintWall,
  placeFurniture,
  planFurnitureMove,
  removeArea,
  removeFurniture,
  removePet,
  renameArea,
  rotateFurniture,
  setFurnitureColor,
  shrinkLayout,
  TileType,
  type TileType as TileTypeVal,
  toggleFurnitureState,
  updateAreaColor,
  wallSetOf,
} from '../../../core/src/layout/index.js';
import type { ColorValue } from '../../../core/src/schemas.js';
import type { AreaMappings } from '../officeFacts.js';
import { findArea, MAX_FLOOR_PATTERN } from './layoutView.js';

// ── Input ────────────────────────────────────────────────────

/** The most ops one call may carry, and the most tile entries one op may list. */
export const MAX_LAYOUT_OPS = 200;
const MAX_TILE_ENTRIES = 500;
/** An Area label's longest spelling. */
const MAX_AREA_LABEL = 40;
/** The furthest one resize_grid step may move an edge, and a rectangle's longest side. */
const MAX_RESIZE_STEP = Math.max(MAX_COLS, MAX_ROWS);

const int = z.number().int();
const tile = z.object({ col: int, row: int });
const rect = z.object({
  col: int,
  row: int,
  width: int.min(1).max(MAX_RESIZE_STEP),
  height: int.min(1).max(MAX_RESIZE_STEP),
});
const tiles = z
  .array(z.union([rect, tile]))
  .min(1)
  .max(MAX_TILE_ENTRIES)
  .describe('Tiles {col,row} and/or rectangles {col,row,width,height}, in any mix.');

const hsbc = { h: z.number(), s: z.number(), b: z.number(), c: z.number() };
const inRange = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

/** A floor, wall or carpet colour: colorize mode (h 0..360, s 0..100, b/c -100..100). */
const tintColor = z
  .object({ ...hsbc, colorize: z.boolean().optional() })
  .refine(
    (c) =>
      inRange(c.h, 0, 360) &&
      inRange(c.s, 0, 100) &&
      inRange(c.b, -100, 100) &&
      inRange(c.c, -100, 100),
    { message: 'colours here are colorize mode: h 0..360, s 0..100, b and c -100..100' },
  );

/** A furniture colour: adjust mode (h -180..180, s/b/c -100..100) unless `colorize`. */
const furnitureColor = z
  .object({ ...hsbc, colorize: z.boolean().optional() })
  .refine(
    (c) =>
      (c.colorize
        ? inRange(c.h, 0, 360) && inRange(c.s, 0, 100)
        : inRange(c.h, -180, 180) && inRange(c.s, -100, 100)) &&
      inRange(c.b, -100, 100) &&
      inRange(c.c, -100, 100),
    {
      message:
        'furniture colour: adjust mode h -180..180, s/b/c -100..100; with colorize: true, h 0..360, s 0..100',
    },
  );

const areaColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Area colours are "#rrggbb"');
const areaLabel = z.string().min(1).max(MAX_AREA_LABEL);
const uid = z.string().min(1).max(64);
const orientation = z.enum(['front', 'right', 'back', 'left']);

/** Every op edit_layout takes, by its `op` name. */
export const layoutOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('place_furniture'),
    type: z
      .string()
      .min(1)
      .describe('A catalogue type (list_catalog), orientation variants included.'),
    col: int,
    row: int.describe('Top-left tile of the footprint; may be negative for a wall item.'),
    color: furnitureColor.optional(),
    uid: uid
      .optional()
      .describe('Name the new item yourself (unused), to refer to it later in the batch.'),
  }),
  z.object({
    op: z.literal('move_furniture'),
    uid,
    col: int,
    row: int.describe('New top-left tile. A desk carries what stands on it.'),
  }),
  z.object({
    op: z.literal('rotate_furniture'),
    uid,
    orientation: orientation.describe('The orientation to turn to (a desk turns its riders too).'),
  }),
  z.object({
    op: z.literal('recolor_furniture'),
    uid,
    color: furnitureColor.nullable().describe('null = the art as drawn.'),
  }),
  z.object({
    op: z.literal('toggle_furniture'),
    uid,
    state: z.enum(['on', 'off']).optional().describe('Omit to flip it.'),
  }),
  z.object({ op: z.literal('remove_furniture'), uid }),
  z.object({
    op: z.literal('paint_floor'),
    tiles,
    pattern: int.min(1).describe('list_catalog floor_patterns[].pattern'),
    color: tintColor.optional(),
  }),
  z.object({
    op: z.literal('paint_walls'),
    tiles,
    wall_set: int
      .min(0)
      .optional()
      .describe("list_catalog wall_sets[].wall_set; default: an existing wall's"),
    color: tintColor.optional().describe("Default: an existing wall's colour."),
  }),
  z.object({
    op: z.literal('remove_walls'),
    tiles,
    pattern: int.min(1).optional().describe('The floor the walls become (default 1).'),
    color: tintColor.optional(),
  }),
  z.object({ op: z.literal('erase'), tiles }),
  z.object({
    op: z.literal('paint_carpet'),
    tiles,
    variant: int.min(0),
    color: tintColor.optional(),
    accent_color: tintColor.optional(),
  }),
  z.object({ op: z.literal('remove_carpet'), tiles }),
  z.object({ op: z.literal('place_pet'), pet_type: int.min(0) }),
  z.object({ op: z.literal('remove_pet'), pet_type: int.min(0) }),
  z.object({ op: z.literal('create_area'), label: areaLabel, color: areaColor }),
  z.object({
    op: z.literal('update_area'),
    label: areaLabel,
    new_label: areaLabel.optional(),
    color: areaColor.optional(),
  }),
  z.object({ op: z.literal('delete_area'), label: areaLabel }),
  z.object({ op: z.literal('paint_area'), label: areaLabel, tiles }),
  z.object({
    op: z.literal('unpaint_area'),
    tiles,
    label: areaLabel.optional().describe('Only clear tiles of this Area (default: any).'),
  }),
  z.object({
    op: z.literal('map_directory'),
    directory: z.string().min(1),
    area: areaLabel,
  }),
  z.object({
    op: z.literal('unmap_directory'),
    directory: z.string().min(1),
    area: areaLabel.optional().describe('Default: every Area it maps to.'),
  }),
  z.object({
    op: z.literal('resize_grid'),
    left: int.min(-MAX_RESIZE_STEP).max(MAX_RESIZE_STEP).optional(),
    right: int.min(-MAX_RESIZE_STEP).max(MAX_RESIZE_STEP).optional(),
    top: int.min(-MAX_RESIZE_STEP).max(MAX_RESIZE_STEP).optional(),
    bottom: int.min(-MAX_RESIZE_STEP).max(MAX_RESIZE_STEP).optional(),
  }),
]);

export type LayoutOp = z.infer<typeof layoutOpSchema>;

// ── Applying ─────────────────────────────────────────────────

/** Directory name → the Area labels it maps to (config `areaMappings`). */
export type { AreaMappings };

/** What a batch starts from. */
export interface LayoutEditStart {
  layout: OfficeLayout;
  mappings: AreaMappings;
  catalog: FurnitureCatalog | null;
  /** How many looks are loaded: floors 1..floorPatterns, wall sets and carpets 0..n-1, pets 0..n-1. */
  floorPatterns: number;
  wallSets: number;
  carpets: number;
  pets: number;
  /** The office's Directory names (what map_directory accepts). */
  directories: readonly string[];
  /** Mints a pet's id (the layout keeps one per pet). */
  newId(): string;
}

export type LayoutEditResult =
  | {
      ok: true;
      layout: OfficeLayout;
      mappings: AreaMappings;
      layoutChanged: boolean;
      mappingsChanged: boolean;
      /** Items the batch placed, by op index. */
      placed: Array<{ op: number; uid: string; type: string }>;
      /** Ops that changed less than they were asked to (already so, tiles skipped). */
      notes: string[];
      /** Where the edit happens: the first op's tile, in the final grid's coordinates
       *  (null when no op names a place). The Buildout (ticket 06) grows from here. */
      origin: { col: number; row: number } | null;
      /** How far the batch's resizes moved the start layout's tiles (0,0 = not at all). */
      shift: { col: number; row: number };
    }
  | { ok: false; index: number; reason: string };

/** A refusal of the op being applied. */
class OpRefused extends Error {}

function refuse(reason: string): never {
  throw new OpRefused(reason);
}

const SIDES: ReadonlyArray<readonly ['top' | 'bottom' | 'left' | 'right', ExpandDirection]> = [
  ['top', 'up'],
  ['bottom', 'down'],
  ['left', 'left'],
  ['right', 'right'],
];

/** Apply `ops` in order to a copy of `start`. Pure apart from `start.newId` and fresh furniture uids. */
export function applyLayoutOps(start: LayoutEditStart, ops: readonly LayoutOp[]): LayoutEditResult {
  let layout = start.layout;
  let mappings: AreaMappings = cloneMappings(start.mappings);
  const placed: Array<{ op: number; uid: string; type: string }> = [];
  const notes: string[] = [];
  let origin: { col: number; row: number } | null = null;
  const shift = { col: 0, row: 0 };

  const note = (index: number, op: LayoutOp, text: string): void => {
    notes.push(`op ${index} (${op.op}): ${text}`);
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    try {
      const step = applyOp(start, layout, mappings, op, (text) => note(index, op, text));
      layout = step.layout;
      mappings = step.mappings;
      if (step.placed) placed.push({ op: index, ...step.placed });
      if (step.shift) {
        shift.col += step.shift.col;
        shift.row += step.shift.row;
      }
      if (!origin && step.at) origin = { ...step.at };
      else if (origin && step.shift) {
        origin = { col: origin.col + step.shift.col, row: origin.row + step.shift.row };
      }
    } catch (err) {
      if (err instanceof OpRefused) return { ok: false, index, reason: err.message };
      throw err;
    }
  }

  return {
    ok: true,
    layout,
    mappings,
    layoutChanged: layout !== start.layout,
    mappingsChanged: !sameMappings(mappings, start.mappings),
    placed,
    notes,
    origin,
    shift,
  };
}

interface Step {
  layout: OfficeLayout;
  mappings: AreaMappings;
  placed?: { uid: string; type: string };
  /** The tile this op happens at, if it names one. */
  at?: { col: number; row: number } | null;
  /** How the grid's coordinates moved (a resize growing or cutting left/top). */
  shift?: { col: number; row: number };
}

function applyOp(
  start: LayoutEditStart,
  layout: OfficeLayout,
  mappings: AreaMappings,
  op: LayoutOp,
  note: (text: string) => void,
): Step {
  const same = { layout, mappings };
  switch (op.op) {
    // ── Furniture ──
    case 'place_furniture': {
      const catalog = needCatalog(start);
      const entry = catalogEntry(catalog, op.type);
      if (!entry) refuse(`unknown furniture type "${op.type}"; list_catalog lists the types`);
      const taken = new Set(layout.furniture.map((f) => f.uid));
      if (op.uid !== undefined && taken.has(op.uid)) refuse(`uid "${op.uid}" is already taken`);
      if (!canPlaceFurniture(catalog, layout, op.type, op.col, op.row)) {
        refuse(whyNotPlaced(catalog, layout, op.type, op.col, op.row));
      }
      const id = op.uid ?? freshFurnitureUid(taken);
      const item = { uid: id, type: op.type, col: op.col, row: op.row };
      const next = placeFurniture(
        catalog,
        layout,
        op.color ? { ...item, color: { ...op.color } } : item,
      );
      return { ...same, layout: next, placed: { uid: id, type: op.type }, at: item };
    }
    case 'move_furniture': {
      const catalog = needCatalog(start);
      const item = needItem(layout, op.uid);
      if (item.col === op.col && item.row === op.row) {
        note('already there');
        return { ...same, at: item };
      }
      const plan = planFurnitureMove(catalog, layout, op.uid, op.col, op.row)!;
      if (!plan.valid) {
        const group = new Set(plan.items.map((f) => f.uid));
        const blocked = plan.items.find(
          (f) => !canPlaceFurniture(catalog, layout, f.type, f.col, f.row, group),
        )!;
        const what = blocked.uid === op.uid ? '' : ` (it carries ${blocked.uid}, which)`;
        refuse(
          `can't move ${op.uid} to (${op.col}, ${op.row})${what}: ` +
            whyNotPlaced(catalog, layout, blocked.type, blocked.col, blocked.row, group),
        );
      }
      const moved = new Map(plan.items.map((f) => [f.uid, f]));
      return {
        ...same,
        layout: { ...layout, furniture: layout.furniture.map((f) => moved.get(f.uid) ?? f) },
        at: { col: op.col, row: op.row },
      };
    }
    case 'rotate_furniture': {
      const catalog = needCatalog(start);
      const item = needItem(layout, op.uid);
      const group = catalog.rotationGroups.get(item.type);
      const current = orientationInGroup(catalog, item.type);
      if (!group || !current) refuse(`${op.uid} (${item.type}) has only one orientation`);
      if (!group.orientations.includes(op.orientation)) {
        refuse(`${item.type} turns only to ${group.orientations.join(', ')}`);
      }
      if (current === op.orientation) {
        note(`already faces ${op.orientation}`);
        return { ...same, at: item };
      }
      const turned = turnTo(catalog, layout, op.uid, op.orientation, group.orientations.length);
      if (!turned) {
        const target = group.members[op.orientation];
        refuse(
          `${op.uid} doesn't fit turned ${op.orientation} at (${item.col}, ${item.row}): ` +
            whyNotPlaced(catalog, layout, target, item.col, item.row, new Set([op.uid])),
        );
      }
      return { ...same, layout: turned, at: item };
    }
    case 'recolor_furniture': {
      const item = needItem(layout, op.uid);
      return { ...same, layout: setFurnitureColor(layout, op.uid, op.color ?? null), at: item };
    }
    case 'toggle_furniture': {
      const catalog = needCatalog(start);
      const item = needItem(layout, op.uid);
      const state = stateOf(catalog, item.type);
      if (!state) refuse(`${op.uid} (${item.type}) has no on/off state`);
      if (op.state === state) {
        note(`already ${state}`);
        return { ...same, at: item };
      }
      return { ...same, layout: toggleFurnitureState(catalog, layout, op.uid), at: item };
    }
    case 'remove_furniture': {
      const item = needItem(layout, op.uid);
      return { ...same, layout: removeFurniture(layout, op.uid), at: item };
    }

    // ── Tiles ──
    case 'paint_floor': {
      const pattern = needFloorPattern(start, op.pattern);
      const list = tileList(layout, op.tiles);
      const color = op.color ? floorColor(op.color) : undefined;
      let next = layout;
      for (const t of list) next = paintTile(next, t.col, t.row, pattern, color);
      return { ...same, layout: next, at: list[0] };
    }
    case 'paint_walls': {
      const list = tileList(layout, op.tiles);
      const brush = wallBrush(layout);
      const set = op.wall_set ?? brush.set;
      if (set >= Math.max(1, start.wallSets)) {
        refuse(
          `wall_set ${set} doesn't exist; list_catalog lists ${start.wallSets} wall sets (0..${start.wallSets - 1})`,
        );
      }
      const color = op.color ? floorColor(op.color) : brush.color;
      let next = layout;
      for (const t of list) next = paintWall(next, t.col, t.row, set, color);
      return { ...same, layout: next, at: list[0] };
    }
    case 'remove_walls': {
      const pattern = needFloorPattern(start, op.pattern ?? 1);
      const list = tileList(layout, op.tiles);
      const floor = { type: pattern, color: op.color ? floorColor(op.color) : undefined };
      let next = layout;
      let skipped = 0;
      for (const t of list) {
        if (next.tiles[t.row * next.cols + t.col] !== TileType.WALL) {
          skipped++;
          continue;
        }
        // The wall tool's removing stroke (wallStrokeTile): the wall becomes this floor.
        next = paintTile(next, t.col, t.row, floor.type, floor.color);
      }
      if (skipped) note(`${skipped} of ${list.length} tiles were not walls and were left alone`);
      return { ...same, layout: next, at: list[0] };
    }
    case 'erase': {
      const catalog = needCatalog(start);
      const list = tileList(layout, op.tiles);
      let next = layout;
      for (const t of list) next = eraseTile(catalog, next, t.col, t.row);
      const removed = layout.furniture.length - next.furniture.length;
      if (removed)
        note(`removed ${removed} furniture item${removed === 1 ? '' : 's'} standing there`);
      return { ...same, layout: next, at: list[0] };
    }
    case 'paint_carpet': {
      if (op.variant >= start.carpets) {
        refuse(
          `carpet variant ${op.variant} doesn't exist; list_catalog lists ${start.carpets} (0..${start.carpets - 1})`,
        );
      }
      const list = tileList(layout, op.tiles);
      const color = op.color ? { ...op.color, colorize: true } : undefined;
      const accent = op.accent_color ? { ...op.accent_color, colorize: true } : undefined;
      let next = layout;
      let skipped = 0;
      for (const t of list) {
        if (!isFloorTile(next, t.col, t.row)) skipped++;
        else next = paintCarpet(next, t.col, t.row, op.variant, color, accent);
      }
      if (skipped) note(`${skipped} of ${list.length} tiles are walls or void and got no carpet`);
      return { ...same, layout: next, at: list[0] };
    }
    case 'remove_carpet': {
      const list = tileList(layout, op.tiles);
      let next = layout;
      for (const t of list) next = eraseCarpet(next, t.col, t.row);
      return { ...same, layout: next, at: list[0] };
    }

    // ── Pets ──
    case 'place_pet': {
      if (op.pet_type >= start.pets) {
        refuse(
          `pet_type ${op.pet_type} doesn't exist; list_catalog lists ${start.pets} pets (0..${start.pets - 1})`,
        );
      }
      if (hasPet(layout, op.pet_type)) {
        note('that pet is already in the office (one of each)');
        return same;
      }
      return { ...same, layout: addPet(layout, op.pet_type, start.newId()) };
    }
    case 'remove_pet': {
      if (!hasPet(layout, op.pet_type)) {
        note('no such pet in the office');
        return same;
      }
      return { ...same, layout: removePet(layout, op.pet_type) };
    }

    // ── Areas ──
    case 'create_area': {
      const label = op.label.trim();
      if (!label) refuse('an Area needs a label');
      const clash = findArea(layout, label);
      if (clash) refuse(`an Area "${clash}" already exists`);
      return { ...same, layout: addArea(layout, label, op.color.toLowerCase()) };
    }
    case 'update_area': {
      const label = needArea(layout, op.label);
      if (op.new_label === undefined && op.color === undefined) {
        refuse('give new_label and/or color');
      }
      let next = layout;
      let nextMappings = mappings;
      if (op.color !== undefined) next = updateAreaColor(next, label, op.color.toLowerCase());
      if (op.new_label !== undefined) {
        const newLabel = op.new_label.trim();
        if (!newLabel) refuse('new_label is empty');
        const clash = findArea(next, newLabel);
        if (clash && clash !== label) refuse(`an Area "${clash}" already exists`);
        if (newLabel !== label) {
          next = renameArea(next, label, newLabel);
          // A Directory mapped to the room keeps it under its new name.
          nextMappings = mapLabels(mappings, (l) => (l === label ? newLabel : l));
        }
      }
      return {
        layout: next,
        mappings: nextMappings,
        at: firstAreaTile(next, op.new_label?.trim() || label),
      };
    }
    case 'delete_area': {
      const label = needArea(layout, op.label);
      const at = firstAreaTile(layout, label);
      return {
        layout: removeArea(layout, label),
        mappings: mapLabels(mappings, (l) => (l === label ? null : l)),
        at,
      };
    }
    case 'paint_area': {
      const label = needArea(layout, op.label);
      const list = tileList(layout, op.tiles);
      let next = layout;
      let skipped = 0;
      for (const t of list) {
        if (!isFloorTile(next, t.col, t.row)) skipped++;
        else next = paintArea(next, t.col, t.row, label);
      }
      if (skipped)
        note(`${skipped} of ${list.length} tiles are walls or void (Areas cover floor only)`);
      return { ...same, layout: next, at: list[0] };
    }
    case 'unpaint_area': {
      const only = op.label === undefined ? null : needArea(layout, op.label);
      const list = tileList(layout, op.tiles);
      let next = layout;
      for (const t of list) {
        const current = next.areaTiles?.[t.row * next.cols + t.col] ?? null;
        if (only === null || current === only) next = eraseArea(next, t.col, t.row);
      }
      return { ...same, layout: next, at: list[0] };
    }

    // ── Directory mappings ──
    case 'map_directory': {
      const directory = needDirectory(start, op.directory);
      const label = needArea(layout, op.area);
      const current = mappings[directory] ?? [];
      if (current.includes(label)) {
        note(`${directory} already maps to ${label}`);
        return same;
      }
      return {
        layout,
        mappings: { ...mappings, [directory]: [...current, label] },
        at: firstAreaTile(layout, label),
      };
    }
    case 'unmap_directory': {
      const directory =
        Object.keys(mappings).find((d) => d === op.directory) ??
        Object.keys(mappings).find((d) => d.toLowerCase() === op.directory.toLowerCase());
      const current = directory ? mappings[directory] : [];
      const label = op.area === undefined ? null : (findArea(layout, op.area) ?? op.area);
      const kept = label === null ? [] : current.filter((l) => l !== label);
      if (!directory || kept.length === current.length) {
        note(`${op.directory} wasn't mapped${label ? ` to ${label}` : ''}`);
        return same;
      }
      const next = { ...mappings };
      if (kept.length) next[directory] = kept;
      else delete next[directory];
      return { layout, mappings: next };
    }

    // ── Grid ──
    case 'resize_grid': {
      let next = layout;
      const shift = { col: 0, row: 0 };
      let asked = false;
      for (const [side, direction] of SIDES) {
        const by = op[side] ?? 0;
        if (by !== 0) asked = true;
        for (let i = 0; i < Math.abs(by); i++) {
          if (by > 0) {
            const grown = expandLayout(next, direction);
            if (!grown) refuse(`the grid can't grow past ${MAX_COLS}x${MAX_ROWS}`);
            next = grown.layout;
            shift.col += grown.shift.col;
            shift.row += grown.shift.row;
          } else {
            const cut = shrinkLayout(needCatalog(start), next, direction);
            if (!cut) {
              refuse(
                `the ${side} edge isn't empty after ${i} of ${-by} cuts: only an edge of void tiles ` +
                  'with no furniture on it can go (erase it first), and the grid keeps at least one tile',
              );
            }
            next = cut.layout;
            shift.col += cut.shift.col;
            shift.row += cut.shift.row;
          }
        }
      }
      if (!asked) refuse('give left, right, top and/or bottom (tiles to add, negative to remove)');
      return { ...same, layout: next, shift };
    }
  }
}

// ── Arguments ────────────────────────────────────────────────

function needCatalog(start: LayoutEditStart): FurnitureCatalog {
  if (!start.catalog) refuse('no furniture catalogue is loaded in this office');
  return start.catalog;
}

function needItem(layout: OfficeLayout, id: string) {
  const item = layout.furniture.find((f) => f.uid === id);
  if (!item) refuse(`no furniture with uid "${id}"; get_layout detail "furniture" lists them`);
  return item;
}

function needArea(layout: OfficeLayout, label: string): string {
  const found = findArea(layout, label);
  if (!found) {
    const known = (layout.areas ?? []).map((a) => `"${a.label}"`).join(', ') || 'none';
    refuse(`no Area "${label}" (Areas: ${known})`);
  }
  return found;
}

function needDirectory(start: LayoutEditStart, name: string): string {
  const found =
    start.directories.find((d) => d === name) ??
    start.directories.find((d) => d.toLowerCase() === name.toLowerCase());
  if (!found) {
    const known = start.directories.map((d) => `"${d}"`).join(', ') || 'none';
    refuse(`no Directory "${name}" (Directories: ${known})`);
  }
  return found;
}

function needFloorPattern(start: LayoutEditStart, pattern: number): TileTypeVal {
  const patterns = Math.min(start.floorPatterns, MAX_FLOOR_PATTERN);
  if (pattern < 1 || pattern > patterns) {
    refuse(`floor pattern ${pattern} doesn't exist; list_catalog lists patterns 1..${patterns}`);
  }
  return pattern as TileTypeVal;
}

/** Floor and wall tiles are always tinted (colorize): the flag isn't stored. */
function floorColor(color: ColorValue): ColorValue {
  return { h: color.h, s: color.s, b: color.b, c: color.c };
}

/** The wall brush edit_layout uses when an op names none: the first wall's set and colour, as
 *  the editor's wall tool starts from. */
function wallBrush(layout: OfficeLayout): { set: number; color: ColorValue } {
  for (let i = 0; i < layout.tiles.length; i++) {
    const color = layout.tileColors?.[i];
    if (layout.tiles[i] === TileType.WALL && color) {
      return { set: wallSetOf(layout, i), color: floorColor(color) };
    }
  }
  return { set: 0, color: { ...DEFAULT_WALL_COLOR } };
}

/** The tiles an op lists (rectangles expanded), each once, in order. Any off the grid refuses. */
function tileList(
  layout: OfficeLayout,
  entries: ReadonlyArray<{ col: number; row: number; width?: number; height?: number }>,
): Array<{ col: number; row: number }> {
  const seen = new Set<number>();
  const list: Array<{ col: number; row: number }> = [];
  for (const e of entries) {
    const width = e.width ?? 1;
    const height = e.height ?? 1;
    for (let row = e.row; row < e.row + height; row++) {
      for (let col = e.col; col < e.col + width; col++) {
        if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) {
          refuse(
            `tile (${col}, ${row}) is outside the ${layout.cols}x${layout.rows} grid ` +
              '(cols 0..' +
              `${layout.cols - 1}, rows 0..${layout.rows - 1}; resize_grid grows it)`,
          );
        }
        const idx = row * layout.cols + col;
        if (seen.has(idx)) continue;
        seen.add(idx);
        list.push({ col, row });
      }
    }
  }
  return list;
}

function firstAreaTile(layout: OfficeLayout, label: string): { col: number; row: number } | null {
  const idx = (layout.areaTiles ?? []).indexOf(label);
  return idx < 0 ? null : { col: idx % layout.cols, row: Math.floor(idx / layout.cols) };
}

// ── Furniture helpers ────────────────────────────────────────

/** A placed item's on/off state, when its type has an on/off counterpart. */
function stateOf(catalog: FurnitureCatalog, type: string): 'on' | 'off' | null {
  if (catalog.offToOn.has(type)) return 'off';
  if (catalog.stateGroups.has(type)) return 'on';
  return null;
}

/**
 * Turn an item (and its riders) step by step to `target`, the shorter way round
 * that fits at every step (each step is the editor's rotate). Null when neither
 * way gets there.
 */
function turnTo(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  id: string,
  target: string,
  orientations: number,
): OfficeLayout | null {
  let best: { layout: OfficeLayout; steps: number } | null = null;
  for (const direction of ['cw', 'ccw'] as const) {
    let current = layout;
    for (let steps = 1; steps < orientations; steps++) {
      const next = rotateFurniture(catalog, current, id, direction);
      if (next === current) break;
      current = next;
      const type = current.furniture.find((f) => f.uid === id)!.type;
      if (orientationInGroup(catalog, type) === target) {
        if (!best || steps < best.steps) best = { layout: current, steps };
        break;
      }
    }
  }
  return best?.layout ?? null;
}

/**
 * Why canPlaceFurniture refused (type, col, row): the first rule it breaks, in
 * its own order. Only explains — the decision is always canPlaceFurniture's.
 */
function whyNotPlaced(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  type: string,
  col: number,
  row: number,
  excluded?: ReadonlySet<string>,
): string {
  const entry = catalogEntry(catalog, type);
  if (!entry) return `unknown furniture type "${type}"`;
  const w = entry.footprintW;
  const h = entry.footprintH;
  const size = `${type} (${w}x${h}) at (${col}, ${row})`;
  const bottom = row + h - 1;
  if (entry.canPlaceOnWalls) {
    if (col < 0 || col + w > layout.cols || bottom < 0 || bottom >= layout.rows) {
      return `${size} has its bottom row off the ${layout.cols}x${layout.rows} grid`;
    }
    for (let dc = 0; dc < w; dc++) {
      if (layout.tiles[bottom * layout.cols + col + dc] !== TileType.WALL) {
        return `${size}: a wall item's bottom row must lie on wall tiles, and (${col + dc}, ${bottom}) isn't a wall`;
      }
    }
  } else {
    if (col < 0 || row < 0 || col + w > layout.cols || row + h > layout.rows) {
      return `${size} doesn't fit inside the ${layout.cols}x${layout.rows} grid`;
    }
    const bg = entry.backgroundTiles ?? 0;
    for (let dr = bg; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const t = layout.tiles[(row + dr) * layout.cols + col + dc];
        if (t === TileType.WALL || t === TileType.VOID) {
          return `${size}: tile (${col + dc}, ${row + dr}) is ${t === TileType.WALL ? 'a wall' : 'void'}, not floor`;
        }
      }
    }
  }
  const bg = entry.backgroundTiles ?? 0;
  for (const other of layout.furniture) {
    if (excluded?.has(other.uid)) continue;
    const blocked = getPlacementBlockedTiles(catalog, [other]);
    const otherEntry = catalogEntry(catalog, other.type);
    for (let dr = bg; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const key = `${col + dc},${row + dr}`;
        if (!blocked.has(key)) continue;
        if (entry.canPlaceOnSurfaces && otherEntry?.isDesk) continue;
        return `${size} overlaps ${other.type} "${other.uid}" at (${col + dc}, ${row + dr})`;
      }
    }
  }
  return `${size} doesn't fit there`;
}

// ── Mappings ─────────────────────────────────────────────────

function cloneMappings(m: AreaMappings): AreaMappings {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
}

/** Every mapping's labels through `f` (null drops the label; a Directory left with none goes). */
function mapLabels(m: AreaMappings, f: (label: string) => string | null): AreaMappings {
  const next: AreaMappings = {};
  for (const [dir, labels] of Object.entries(m)) {
    const kept = [...new Set(labels.map(f).filter((l): l is string => l !== null))];
    if (kept.length) next[dir] = kept;
  }
  return next;
}

export function sameMappings(a: AreaMappings, b: AreaMappings): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    return !!y && x.length === y.length && x.every((l, i) => l === y[i]);
  });
}
