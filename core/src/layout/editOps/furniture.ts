/**
 * Furniture edits: placement rules, hit-testing, surface riders, moving,
 * copying, rotation, colours and on/off toggling.
 * Pure: each returns a new layout (or the same one when nothing changes).
 */

import type { FurnitureCatalog } from '../catalog.js';
import { catalogEntry, rotatedType, toggledType } from '../catalog.js';
import { getPlacementBlockedTiles } from '../layoutSerializer.js';
import type { ColorValue, OfficeLayout, PlacedFurniture } from '../types.js';
import { TileType } from '../types.js';

/** Place furniture. Returns new layout (immutable). */
export function placeFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  item: PlacedFurniture,
): OfficeLayout {
  if (!canPlaceFurniture(catalog, layout, item.type, item.col, item.row)) return layout;
  return { ...layout, furniture: [...layout.furniture, item] };
}

/** Remove furniture by uid. Returns new layout (immutable). */
export function removeFurniture(layout: OfficeLayout, uid: string): OfficeLayout {
  const filtered = layout.furniture.filter((f) => f.uid !== uid);
  if (filtered.length === layout.furniture.length) return layout;
  return { ...layout, furniture: filtered };
}

/** Whether a placed item's footprint (background rows included) covers (col, row). */
function coversTile(
  catalog: FurnitureCatalog,
  item: PlacedFurniture,
  col: number,
  row: number,
): boolean {
  const entry = catalogEntry(catalog, item.type);
  if (!entry) return false;
  return (
    col >= item.col &&
    col < item.col + entry.footprintW &&
    row >= item.row &&
    row < item.row + entry.footprintH
  );
}

/**
 * The placed item a click on (col, row) means, or undefined. Where items stack,
 * a surface item (laptop, monitor, mug…) wins over the desk under it — it's the
 * one drawn on top — so selecting, dragging, copying and eyedropping all agree
 * on what the cursor is pointing at.
 */
export function furnitureAt(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  col: number,
  row: number,
): PlacedFurniture | undefined {
  let hit: PlacedFurniture | undefined;
  for (const f of layout.furniture) {
    if (!coversTile(catalog, f, col, row)) continue;
    if (!hit || catalogEntry(catalog, f.type)?.canPlaceOnSurfaces) hit = f;
  }
  return hit;
}

/**
 * Every placed item whose footprint (background rows included) touches the
 * tile box between two corners — inclusive, in either order — in layout order.
 * What a box selection catches.
 */
export function furnitureInBox(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  col0: number,
  row0: number,
  col1: number,
  row1: number,
): string[] {
  const left = Math.min(col0, col1);
  const right = Math.max(col0, col1);
  const top = Math.min(row0, row1);
  const bottom = Math.max(row0, row1);
  return layout.furniture
    .filter((f) => {
      const entry = catalogEntry(catalog, f.type);
      if (!entry) return false;
      return (
        f.col <= right &&
        f.col + entry.footprintW - 1 >= left &&
        f.row <= bottom &&
        f.row + entry.footprintH - 1 >= top
      );
    })
    .map((f) => f.uid);
}

/**
 * Remove every furniture item whose footprint covers (col, row) — all of them,
 * not just the one {@link furnitureAt} would pick, so an erase stroke clears a
 * desk together with whatever stands on the tile it crosses. Returns new layout
 * (immutable). No-op if no furniture covers the tile; unknown types are kept
 * rather than silently dropped.
 */
export function removeFurnitureAt(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  col: number,
  row: number,
): OfficeLayout {
  const filtered = layout.furniture.filter((f) => !coversTile(catalog, f, col, row));
  if (filtered.length === layout.furniture.length) return layout;
  return { ...layout, furniture: filtered };
}

/** Footprint tiles of a placed item, as `"col,row"` keys (background rows included). */
function footprintTiles(catalog: FurnitureCatalog, item: PlacedFurniture): Set<string> {
  const entry = catalogEntry(catalog, item.type);
  const tiles = new Set<string>();
  if (!entry) return tiles;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    for (let dc = 0; dc < entry.footprintW; dc++) {
      tiles.add(`${item.col + dc},${item.row + dr}`);
    }
  }
  return tiles;
}

/**
 * Which desk a surface item (laptop, monitor, mug…) is sitting on, or null when
 * it overlaps no desk. An item straddling two desks belongs to the one it covers
 * most; ties go to the desk that comes first in `layout.furniture`, so ownership
 * is stable across calls.
 */
function hostDeskUid(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  item: PlacedFurniture,
): string | null {
  const entry = catalogEntry(catalog, item.type);
  if (!entry?.canPlaceOnSurfaces) return null;
  const tiles = footprintTiles(catalog, item);
  if (tiles.size === 0) return null;

  let bestUid: string | null = null;
  let bestOverlap = 0;
  for (const desk of layout.furniture) {
    if (desk.uid === item.uid) continue;
    const deskEntry = catalogEntry(catalog, desk.type);
    if (!deskEntry?.isDesk) continue;
    let overlap = 0;
    for (const key of footprintTiles(catalog, desk)) {
      if (tiles.has(key)) overlap++;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestUid = desk.uid;
    }
  }
  return bestUid;
}

/**
 * The surface items riding on the given desk — the stuff that moves and rotates
 * with it. Empty for anything that isn't a desk, and never recursive: a rider
 * carries nothing of its own.
 */
export function getSurfaceRiders(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  deskUid: string,
): PlacedFurniture[] {
  const desk = layout.furniture.find((f) => f.uid === deskUid);
  if (!desk || !catalogEntry(catalog, desk.type)?.isDesk) return [];
  return layout.furniture.filter(
    (f) => f.uid !== deskUid && hostDeskUid(catalog, layout, f) === deskUid,
  );
}

/** A desk and its riders at their target positions, plus whether they all fit. */
export interface FurnitureMovePlan {
  /**
   * The dragged item first, then the items moving with it (`with`), then every
   * surface rider — all at target positions, each once.
   */
  items: PlacedFurniture[];
  /** True when every item in the group fits where the plan puts it. */
  valid: boolean;
}

/**
 * Plan a drag: the dragged item plus everything on its surface, all shifted by
 * the same delta. Used for the drag ghost as well as the drop, so the preview
 * and the committed edit can never disagree. Null if `uid` is gone.
 *
 * `duplicate` only changes what counts as blocking. A move frees the tiles the
 * group vacates, so it may land on them; a copy leaves the originals standing,
 * so those same tiles block it. `items` keeps the source uids either way —
 * duplicateFurniture mints fresh ones when it commits.
 */
export function planFurnitureMove(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
  opts: { duplicate?: boolean; with?: readonly string[] } = {},
): FurnitureMovePlan | null {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return null;
  const dCol = newCol - item.col;
  const dRow = newRow - item.row;
  // The dragged item and the other selected items it carries, then their
  // riders: riders after every surface, so they draw on top of it.
  const carried = (opts.with ?? [])
    .filter((u) => u !== uid)
    .flatMap((u) => layout.furniture.find((f) => f.uid === u) ?? []);
  const bases = [item, ...carried];
  const group = new Map<string, PlacedFurniture>();
  for (const f of bases) group.set(f.uid, f);
  for (const f of bases) {
    for (const rider of getSurfaceRiders(catalog, layout, f.uid)) {
      if (!group.has(rider.uid)) group.set(rider.uid, rider);
    }
  }
  const items = [...group.values()].map((f) => ({
    ...f,
    col: f.col + dCol,
    row: f.row + dRow,
  }));
  return { items, valid: groupFits(catalog, layout, items, { leavesOriginals: opts.duplicate }) };
}

/**
 * Whether a desk group fits at the positions proposed for it: every member
 * passes canPlaceFurniture. The group's own originals never block a move or a
 * rotation (it vacates those tiles); with `leavesOriginals` — a copy — they do.
 * The one rule behind drag, drop, copy and rotate, so none of them can commit
 * a group the others would refuse.
 */
function groupFits(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  items: PlacedFurniture[],
  opts: { leavesOriginals?: boolean } = {},
): boolean {
  const exclude = opts.leavesOriginals ? undefined : new Set(items.map((f) => f.uid));
  return items.every((f) => canPlaceFurniture(catalog, layout, f.type, f.col, f.row, exclude));
}

/**
 * A furniture uid that isn't already taken. `taken` is updated in place, so a
 * batch of copies minted in the same millisecond can't collide with each other.
 */
export function freshFurnitureUid(taken: Set<string>): string {
  let uid: string;
  do {
    uid = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  } while (taken.has(uid));
  taken.add(uid);
  return uid;
}

/**
 * Copy an item (and the items in `with`) and everything on their surfaces to a
 * new spot, leaving the originals where they are. Returns the new layout
 * (immutable) plus the copies of `uid` and `with`, in that order, so the caller
 * can select them; null when the group doesn't fit.
 */
export function duplicateFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
  withUids: readonly string[] = [],
): { layout: OfficeLayout; uids: string[] } | null {
  const plan = planFurnitureMove(catalog, layout, uid, newCol, newRow, {
    duplicate: true,
    with: withUids,
  });
  if (!plan || !plan.valid) return null;
  const taken = new Set(layout.furniture.map((f) => f.uid));
  const copyOf = new Map<string, string>();
  const copies = plan.items.map((f) => {
    const copyUid = freshFurnitureUid(taken);
    copyOf.set(f.uid, copyUid);
    return { ...f, uid: copyUid, ...(f.color ? { color: { ...f.color } } : {}) };
  });
  return {
    layout: { ...layout, furniture: [...layout.furniture, ...copies] },
    uids: [uid, ...withUids].flatMap((u) => copyOf.get(u) ?? []),
  };
}

/**
 * Commit a drag-drop gesture: move the item (with the selected items in
 * `with`, and everyone's riders) to (newCol, newRow), or — with `duplicate` —
 * stamp a copy of the group there. Null when the group doesn't fit, so nothing
 * changes. `selected` is what the drop leaves selected, first item first: the
 * copies, so R / T / the colour sliders act on what was just dropped; a moved
 * selection stays selected; a single moved item doesn't.
 */
export function dropFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
  opts: { duplicate: boolean; with?: readonly string[] },
): { layout: OfficeLayout; selected: string[] } | null {
  const withUids = opts.with ?? [];
  if (opts.duplicate) {
    const copy = duplicateFurniture(catalog, layout, uid, newCol, newRow, withUids);
    return copy && { layout: copy.layout, selected: copy.uids };
  }
  const moved = moveFurniture(catalog, layout, uid, newCol, newRow, withUids);
  if (moved === layout) return null;
  return { layout: moved, selected: withUids.length ? [uid, ...withUids] : [] };
}

/** Set (or, with null, remove) a placed item's colour. Returns new layout (immutable). */
export function setFurnitureColor(
  layout: OfficeLayout,
  uid: string,
  color: ColorValue | null,
): OfficeLayout {
  if (!layout.furniture.some((f) => f.uid === uid)) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) =>
      f.uid === uid ? { ...f, color: color ? { ...color } : undefined } : f,
    ),
  };
}

/**
 * Place a new catalog item under the cursor at (col, row) — wall items hang so
 * their bottom row sits on the hovered tile — with a fresh uid and, if given,
 * its own copy of `color`. Returns new layout (immutable); unchanged when the
 * item doesn't fit there.
 */
export function placeNewFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  type: string,
  col: number,
  row: number,
  color: ColorValue | null,
): OfficeLayout {
  const uid = freshFurnitureUid(new Set(layout.furniture.map((f) => f.uid)));
  const item: PlacedFurniture = { uid, type, col, row: getWallPlacementRow(catalog, type, row) };
  if (color) item.color = { ...color };
  return placeFurniture(catalog, layout, item);
}

/** Replace each listed item in the layout by uid. Returns new layout (immutable). */
function withFurniture(layout: OfficeLayout, updates: PlacedFurniture[]): OfficeLayout {
  const byUid = new Map(updates.map((f) => [f.uid, f]));
  return { ...layout, furniture: layout.furniture.map((f) => byUid.get(f.uid) ?? f) };
}

/**
 * Move furniture to a new position, carrying anything on its surface along.
 * Returns new layout (immutable). No-op unless the whole group fits.
 */
export function moveFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
  withUids: readonly string[] = [],
): OfficeLayout {
  const plan = planFurnitureMove(catalog, layout, uid, newCol, newRow, { with: withUids });
  if (!plan || !plan.valid) return layout;
  return withFurniture(layout, plan.items);
}

function clamp(value: number, a: number, b: number): number {
  return Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));
}

/**
 * The type an item takes when it turns a quarter `direction` on screen (see
 * rotateRiderWithDesk: 'cw' is counter-clockwise on screen), or null when it
 * can't turn.
 *
 * The orientation cycle front → right → back → left means different turns for
 * different items. A chair's or sofa's orientation is the way it faces (front =
 * down, right = right), so the cycle turns it counter-clockwise. A screen's
 * (electronics) orientation is the way its user looks (workstations.ts: a front
 * PC is used from below, a side PC from its left, so its screen faces left):
 * the same cycle turns it clockwise, so it steps the other way.
 */
function turnedType(
  catalog: FurnitureCatalog,
  type: string,
  direction: 'cw' | 'ccw',
): string | null {
  const screen = catalogEntry(catalog, type)?.category === 'electronics';
  const step = screen ? (direction === 'cw' ? 'ccw' : 'cw') : direction;
  return rotatedType(catalog, type, step);
}

/**
 * Turn a rider a quarter turn along with the desk under it: its own sprite steps
 * one orientation in the same direction, and its spot on the desk swings round
 * with the desk top.
 *
 * The desk's own footprint is authored per orientation, not derived (a 3x2 front
 * desk becomes a 1x4 side desk), so positions can't be rotated as a rigid grid.
 * Instead the rider's centre is taken as a fraction of the desk's footprint,
 * turned a quarter in that normalized space, and read back against the desk's
 * NEW footprint — then clamped so the rider stays on the desk it rides.
 *
 * The catalog's 'cw' step is front → right → back → left, which turns a
 * south-facing item east: counter-clockwise on screen, where y grows downward.
 * Hence (u,v) → (v, 1-u): the desk's back edge travels north → west, taking the
 * monitors standing along it with it.
 */
function rotateRiderWithDesk(
  catalog: FurnitureCatalog,
  rider: PlacedFurniture,
  desk: PlacedFurniture,
  deskFrom: { footprintW: number; footprintH: number },
  deskTo: { footprintW: number; footprintH: number },
  direction: 'cw' | 'ccw',
): PlacedFurniture {
  const from = catalogEntry(catalog, rider.type);
  if (!from) return rider;
  const type = turnedType(catalog, rider.type, direction) ?? rider.type;
  const to = catalogEntry(catalog, type) ?? from;

  const u = (rider.col - desk.col + from.footprintW / 2) / deskFrom.footprintW;
  const v = (rider.row - desk.row + from.footprintH / 2) / deskFrom.footprintH;
  const [ru, rv] = direction === 'cw' ? [v, 1 - u] : [1 - v, u];

  const localCol = Math.round(ru * deskTo.footprintW - to.footprintW / 2);
  const localRow = Math.round(rv * deskTo.footprintH - to.footprintH / 2);
  return {
    ...rider,
    type,
    col: desk.col + clamp(localCol, 0, deskTo.footprintW - to.footprintW),
    row: desk.row + clamp(localRow, 0, deskTo.footprintH - to.footprintH),
  };
}

/**
 * Rotate furniture to the next orientation, turning anything on its surface with
 * it. Returns new layout (immutable). No-op unless the whole group fits in its
 * new orientation — the desk and every rider, on the grid and clear of others.
 */
export function rotateFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
  direction: 'cw' | 'ccw',
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  const turn = item && turnWithRiders(catalog, layout, item, direction);
  if (!turn || !turn.turns) return layout;
  if (!groupFits(catalog, layout, turn.unit)) return layout;
  return withFurniture(layout, turn.unit);
}

/**
 * An item turned a quarter, with everything riding on it: the item steps one
 * orientation, and each rider steps one too while its spot swings round the
 * item's top (rotateRiderWithDesk). A desk with no turned art of its own (a
 * one-orientation table) keeps its shape and still turns what's on it, so the
 * PCs on a table face the new way. `turns` is false when nothing changes
 * orientation; `to` is the item's footprint after the turn. Null for an
 * unknown type.
 */
function turnWithRiders(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  item: PlacedFurniture,
  direction: 'cw' | 'ccw',
): {
  unit: PlacedFurniture[];
  to: { footprintW: number; footprintH: number; backgroundTiles?: number };
  turns: boolean;
} | null {
  const from = catalogEntry(catalog, item.type);
  if (!from) return null;
  const newType = turnedType(catalog, item.type, direction);
  const to = (newType && catalogEntry(catalog, newType)) || from;
  const riders = getSurfaceRiders(catalog, layout, item.uid).map((r) =>
    rotateRiderWithDesk(catalog, r, item, from, to, direction),
  );
  const self = newType && to !== from ? { ...item, type: newType } : item;
  return { unit: [self, ...riders], to, turns: self !== item || riders.length > 0 };
}
// ── Several selected items at once (Shift+click) ─────────────────

/** Remove every listed item. Returns new layout (immutable). */
export function removeFurnitureGroup(layout: OfficeLayout, uids: readonly string[]): OfficeLayout {
  return uids.reduce(removeFurniture, layout);
}

/** Set (or remove) the colour of every listed item. Returns new layout (immutable). */
export function setFurnitureColors(
  layout: OfficeLayout,
  uids: readonly string[],
  color: ColorValue | null,
): OfficeLayout {
  return uids.reduce((l, uid) => setFurnitureColor(l, uid, color), layout);
}

/**
 * A placed item's solid footprint (background rows left out) as a rectangle in
 * tiles — where it stands, for working out where it stands after a turn.
 */
function solidRect(
  item: PlacedFurniture,
  entry: { footprintW: number; footprintH: number; backgroundTiles?: number },
) {
  const bg = Math.min(entry.backgroundTiles ?? 0, entry.footprintH - 1);
  return { col: item.col, row: item.row + bg, w: entry.footprintW, h: entry.footprintH - bg };
}

/**
 * Turn the listed items a quarter turn together, as one arrangement: each item
 * turns (as rotateFurniture turns it, riders included) and its spot swings
 * round the arrangement's centre the same way — so a desk keeps its chair in
 * front of it and a row of sofas stays a row. Items riding on a listed desk go
 * with the desk. A single item turns in place. No-op unless every item fits
 * where the turn puts it.
 *
 * The catalog's 'cw' step turns a south-facing item east — counter-clockwise
 * on screen (see rotateRiderWithDesk) — so positions turn that way too.
 */
export function rotateFurnitureGroup(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uids: readonly string[],
  direction: 'cw' | 'ccw',
): OfficeLayout {
  const carried = new Set(
    uids.flatMap((u) => getSurfaceRiders(catalog, layout, u).map((r) => r.uid)),
  );
  const bases = uids
    .filter((u) => !carried.has(u))
    .flatMap((u) => {
      const item = layout.furniture.find((f) => f.uid === u);
      const entry = item && catalogEntry(catalog, item.type);
      return item && entry ? [{ item, entry }] : [];
    });
  if (bases.length === 0) return layout;
  if (bases.length === 1) return rotateFurniture(catalog, layout, bases[0].item.uid, direction);

  // The arrangement's centre: the middle of the box round its solid footprints.
  const rects = bases.map(({ item, entry }) => solidRect(item, entry));
  const left = Math.min(...rects.map((r) => r.col));
  const right = Math.max(...rects.map((r) => r.col + r.w));
  const top = Math.min(...rects.map((r) => r.row));
  const bottom = Math.max(...rects.map((r) => r.row + r.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  const turned: PlacedFurniture[] = [];
  bases.forEach(({ item }, i) => {
    const turn = turnWithRiders(catalog, layout, item, direction);
    if (!turn) return;
    const { unit, to } = turn;

    // Swing the item's centre round the arrangement's, then stand its new
    // footprint on that spot; its riders shift with it.
    const rect = rects[i];
    const dx = rect.col + rect.w / 2 - cx;
    const dy = rect.row + rect.h / 2 - cy;
    const [rx, ry] = direction === 'cw' ? [dy, -dx] : [-dy, dx];
    const target = solidRect({ ...item, col: 0, row: 0 }, to);
    const col = Math.round(cx + rx - target.w / 2);
    const row = Math.round(cy + ry - target.h / 2) - target.row;
    const shiftCol = col - item.col;
    const shiftRow = row - item.row;
    for (const f of unit) turned.push({ ...f, col: f.col + shiftCol, row: f.row + shiftRow });
  });

  if (!groupFits(catalog, layout, turned)) return layout;
  return withFurniture(layout, turned);
}

/** Toggle the on/off state of every listed item that has one. Returns new layout (immutable). */
export function toggleFurnitureStates(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uids: readonly string[],
): OfficeLayout {
  return uids.reduce((l, uid) => toggleFurnitureState(catalog, l, uid), layout);
}

/** Toggle furniture state (on/off). Returns new layout (immutable). */
export function toggleFurnitureState(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  uid: string,
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  const newType = toggledType(catalog, item.type);
  if (!newType) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, type: newType } : f)),
  };
}

/** For wall items, offset the row so the bottom row aligns with the hovered tile. */
export function getWallPlacementRow(catalog: FurnitureCatalog, type: string, row: number): number {
  const entry = catalogEntry(catalog, type);
  if (!entry?.canPlaceOnWalls) return row;
  return row - (entry.footprintH - 1);
}

/**
 * Check if furniture can be placed at (col, row) without overlapping.
 * `excluded` are the uids that don't count as obstacles — the item being moved,
 * or a desk together with its riders, which never block their own move.
 */
export function canPlaceFurniture(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  type: string, // FurnitureType enum or asset ID
  col: number,
  row: number,
  excluded?: ReadonlySet<string>,
): boolean {
  const entry = catalogEntry(catalog, type);
  if (!entry) return false;

  // Check bounds — wall items may extend above the map (top rows hang above the wall)
  if (entry.canPlaceOnWalls) {
    const bottomRow = row + entry.footprintH - 1;
    if (
      col < 0 ||
      col + entry.footprintW > layout.cols ||
      bottomRow < 0 ||
      bottomRow >= layout.rows
    ) {
      return false;
    }
  } else {
    if (
      col < 0 ||
      row < 0 ||
      col + entry.footprintW > layout.cols ||
      row + entry.footprintH > layout.rows
    ) {
      return false;
    }
  }

  // Wall/VOID placement check (background rows skip this check)
  const bgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < bgRows) continue;
    if (row + dr < 0) continue; // row above map (wall items extending upward)
    // Wall items: only the bottom row must be on wall tiles; upper rows can overlap VOID/anything
    if (entry.canPlaceOnWalls && dr < entry.footprintH - 1) continue;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const idx = (row + dr) * layout.cols + (col + dc);
      const tileVal = layout.tiles[idx];
      if (entry.canPlaceOnWalls) {
        if (tileVal !== TileType.WALL) return false;
      } else {
        if (tileVal === TileType.VOID) return false; // Cannot place on VOID
        if (tileVal === TileType.WALL) return false; // Normal items cannot overlap walls
      }
    }
  }

  // Build occupied set excluding the item being moved, skipping background tile rows
  const occupied = getPlacementBlockedTiles(catalog, layout.furniture, excluded);

  // If this item can be placed on surfaces, build set of desk tiles to exclude from collision
  let deskTiles: Set<string> | null = null;
  if (entry.canPlaceOnSurfaces) {
    deskTiles = new Set<string>();
    for (const item of layout.furniture) {
      if (excluded?.has(item.uid)) continue;
      const itemEntry = catalogEntry(catalog, item.type);
      if (!itemEntry || !itemEntry.isDesk) continue;
      for (let dr = 0; dr < itemEntry.footprintH; dr++) {
        for (let dc = 0; dc < itemEntry.footprintW; dc++) {
          deskTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
  }

  // Check overlap — also skip the NEW item's own background rows
  const newBgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < newBgRows) continue; // new item's background rows can overlap existing items
    if (row + dr < 0) continue; // row above map (wall items extending upward)
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const key = `${col + dc},${row + dr}`;
      if (occupied.has(key) && !deskTiles?.has(key)) return false;
    }
  }

  return true;
}
