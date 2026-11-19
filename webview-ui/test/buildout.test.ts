/**
 * The Buildout in the office: `layoutLoaded.buildout` applied to OfficeState
 * (startBuildout), as every open office applies it. The office's state is the
 * new layout at once; what it SHOWS builds in — additions one by one outward
 * from the origin, removals dissolving in matrix rain — within the cap, while
 * the builder's character walks to the spot, works there, and goes back to
 * its desk. What a layout arriving mid-buildout does, and the resize shift.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import type { AgentVisit } from '../../core/src/messages.js';
import { BUILDOUT_MAX_SEC, MATRIX_EFFECT_DURATION_SEC } from '../src/constants.js';
import { applyAgentVisit } from '../src/office/engine/agentVisit.js';
import { planBuildout } from '../src/office/engine/buildout.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

const FRAME = 1 / 30;
const COLS = 12;
const ROWS = 6;

beforeAll(() => {
  const entry = (id: string, category: string): LoadedAssetData['catalog'][number] => ({
    id,
    label: id,
    category,
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  });
  assert.ok(
    buildDynamicCatalog({
      catalog: [entry('TEST_CHAIR', 'chairs'), entry('TEST_BOX', 'storage')],
      sprites: { TEST_CHAIR: [['c']], TEST_BOX: [['b']] },
    }),
  );
});

/** 12×6 floor, a wall at (11,0); agent 1 seated at (1,1), working (it called edit_layout). */
function baseLayout(): OfficeLayout {
  const tiles = new Array<TileType>(COLS * ROWS).fill(TileType.FLOOR_1);
  tiles[11] = TileType.WALL;
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    furniture: [
      { uid: 'seat', type: 'TEST_CHAIR', col: 1, row: 1 },
      { uid: 'old', type: 'TEST_BOX', col: 9, row: 4 },
    ],
  };
}

function office(): OfficeState {
  const os = new OfficeState(baseLayout());
  os.addAgent(1, undefined, undefined, 'seat', true);
  os.setAgentActive(1, true);
  return os;
}

const box = (uid: string, col: number, row: number): PlacedFurniture => ({
  uid,
  type: 'TEST_BOX',
  col,
  row,
});

/** The base layout with boxes near (6,3) and far (10,5), a floor tile repainted at (7,3),
 *  the box at (9,4) removed and the wall at (11,0) taken down. */
function edited(): OfficeLayout {
  const layout = baseLayout();
  const tiles = [...layout.tiles];
  tiles[3 * COLS + 7] = TileType.FLOOR_2;
  tiles[11] = TileType.FLOOR_1;
  return {
    ...layout,
    tiles,
    furniture: [layout.furniture[0], box('near', 6, 3), box('far', 10, 5)],
  };
}

const ORIGIN = { col: 6, row: 3 };

/** What the Buildout is dissolving now (none when it isn't playing). */
function dissolving(os: OfficeState) {
  return os.buildout.render()?.dissolving ?? [];
}

function shownUids(os: OfficeState): string[] {
  return os.shownLayout().furniture.map((f) => f.uid);
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) os.update(FRAME);
}

function runUntil(os: OfficeState, done: () => boolean, what: string, seconds = 20): void {
  for (let t = 0; t < seconds; t += FRAME) {
    if (done()) return;
    os.update(FRAME);
  }
  assert.fail(`never: ${what}`);
}

test('the office holds the new layout at once; what it shows builds in, nearest the origin first', () => {
  const os = office();
  const after = edited();
  os.startBuildout(after, { agentId: 1, origin: ORIGIN });

  // State is the result already: walking, seats and the saved layout don't wait.
  assert.equal(os.getLayout(), after);
  assert.equal(os.tileMap[0][11], TileType.FLOOR_1);
  assert.ok(os.buildout.isPlaying);

  // Record when each change first shows.
  const seen = new Map<string, number>();
  let t = 0;
  const look = (): void => {
    const shown = os.shownLayout();
    const uids = shownUids(os);
    if (uids.includes('near') && !seen.has('near')) seen.set('near', t);
    if (uids.includes('far') && !seen.has('far')) seen.set('far', t);
    if (shown.tiles[3 * COLS + 7] === TileType.FLOOR_2 && !seen.has('floor')) seen.set('floor', t);
    if (!uids.includes('old') && !seen.has('old gone')) seen.set('old gone', t);
    if (shown.tiles[11] !== TileType.WALL && !seen.has('wall gone')) seen.set('wall gone', t);
  };
  look();
  // The first change (at the origin) shows at once; the far ones not yet.
  assert.equal(seen.get('near'), 0);
  assert.ok(!seen.has('far') && !seen.has('old gone') && !seen.has('wall gone'));
  while (os.buildout.isPlaying) {
    os.update(FRAME);
    t += FRAME;
    look();
  }

  // Outward: (6,3) → (7,3) → (9,4) → (10,5) → (11,0).
  const order = ['near', 'floor', 'old gone', 'far', 'wall gone'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      seen.get(order[i - 1])! < seen.get(order[i])!,
      `${order[i - 1]} before ${order[i]}: ${JSON.stringify([...seen])}`,
    );
  }
  assert.ok(t <= BUILDOUT_MAX_SEC + FRAME, `done within the cap (${t})`);
  // Over: the office shows exactly its layout.
  assert.equal(os.shownLayout(), os.getLayout());
  assert.deepEqual(dissolving(os), []);
});

test('what the edit removed dissolves in matrix rain, from its turn, for the effect’s length', () => {
  const os = office();
  os.startBuildout(edited(), { agentId: 1, origin: ORIGIN });

  const kinds = (): string[] => dissolving(os).map((d) => d.kind);
  runUntil(os, () => kinds().includes('furniture'), 'the removed box to dissolve');
  const box = dissolving(os).find((d) => d.kind === 'furniture')!;
  assert.equal(box.kind === 'furniture' && box.item.uid, 'old');
  // Dissolving, it is no longer one of the items shown (the rain draws it).
  assert.ok(!shownUids(os).includes('old'));
  run(os, MATRIX_EFFECT_DURATION_SEC + FRAME);
  assert.ok(!kinds().includes('furniture'), 'the rain is over');

  runUntil(os, () => kinds().includes('wall'), 'the wall to dissolve');
  const wall = dissolving(os).find((d) => d.kind === 'wall')!;
  assert.deepEqual(wall.kind === 'wall' && { col: wall.col, row: wall.row }, { col: 11, row: 0 });
  // Additions never rain.
  runUntil(os, () => !os.buildout.isPlaying, 'the end');
});

test('however large the edit, it builds in within the cap', () => {
  const os = office();
  const layout = baseLayout();
  const tiles = layout.tiles.map((t) => (t === TileType.WALL ? t : TileType.FLOOR_3));
  const furniture = [...layout.furniture.filter((f) => f.uid !== 'old')];
  for (let col = 3; col < COLS; col++) furniture.push(box(`b${col}`, col, 5));
  os.startBuildout({ ...layout, tiles, furniture }, { agentId: 1, origin: { col: 0, row: 0 } });
  run(os, BUILDOUT_MAX_SEC);
  assert.ok(!os.buildout.isPlaying);
  assert.equal(os.shownLayout(), os.getLayout());
});

test('the builder walks to a spot beside the origin, faces it and works there, then goes back to its desk', () => {
  const os = office();
  os.startBuildout(edited(), { agentId: 1, origin: { col: 5, row: 4 } });
  const ch = os.characters.get(1)!;
  const stop = os.visits.stopOf(1)!.stop;
  assert.equal(Math.abs(stop.col - 5) + Math.abs(stop.row - 4), 1, 'beside the origin');
  assert.equal(stop.work, true);

  // A server Visit's clear (its next turn) doesn't cut the builder's walk short.
  applyAgentVisit(os, { type: 'agentVisit', id: 1, cleared: true } as AgentVisit);
  assert.ok(os.visits.stopOf(1), 'still on its way');

  runUntil(os, () => os.visits.stopOf(1)?.arrived === true, 'reaching the spot');
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: stop.col, row: stop.row });
  const facing =
    stop.col < 5
      ? Direction.RIGHT
      : stop.col > 5
        ? Direction.LEFT
        : stop.row < 4
          ? Direction.DOWN
          : Direction.UP;
  assert.equal(ch.dir, facing);
  assert.equal(ch.state, CharacterState.IDLE);
  run(os, 0.5);
  assert.ok(os.visits.stopOf(1)?.arrived, 'it works there a while');

  // Then back to its seat, at work again.
  runUntil(os, () => os.visits.stopOf(1) === null, 'the work to end');
  runUntil(os, () => ch.state === CharacterState.TYPE, 'back at its desk');
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 1, row: 1 });
});

test('the build never waits for the walk: it starts at once and keeps to the cap', () => {
  const os = office();
  // Origin at the far corner: a long walk.
  os.startBuildout(edited(), { agentId: 1, origin: { col: 10, row: 5 } });
  run(os, BUILDOUT_MAX_SEC);
  assert.ok(!os.buildout.isPlaying, 'built while the builder was still on its way');
  assert.ok(os.visits.stopOf(1), 'the builder still goes to the spot');
});

test('a builder this office does not show: the edit still builds in', () => {
  const os = office();
  os.startBuildout(edited(), { agentId: 42, origin: ORIGIN });
  assert.ok(os.buildout.isPlaying);
  assert.equal(os.visits.stopOf(1), null, 'no one else is sent');
  run(os, BUILDOUT_MAX_SEC);
  assert.ok(!os.buildout.isPlaying);
});

test('a layout arriving mid-buildout: a plain one shows at once; another edit builds from the last result', () => {
  const os = office();
  os.startBuildout(edited(), { agentId: 1, origin: ORIGIN });
  run(os, 0.1);
  assert.ok(os.buildout.isPlaying);

  // A person's save or an undo (no buildout): the office shows it, no animation left.
  const undone = baseLayout();
  os.rebuildFromLayout(undone);
  assert.ok(!os.buildout.isPlaying);
  assert.equal(os.shownLayout(), undone);

  // Two edits in a row: the second diffs against the first's result, not what was shown.
  os.startBuildout(edited(), { agentId: 1, origin: ORIGIN });
  run(os, 0.1);
  const second = edited();
  second.furniture = [...second.furniture, box('third', 4, 4)];
  os.startBuildout(second, { agentId: 1, origin: { col: 4, row: 4 } });
  const shown = shownUids(os);
  // The first edit's items are all there at once; only the new box builds in.
  for (const uid of ['near', 'far']) assert.ok(shown.includes(uid), uid);
  assert.ok(!shown.includes('old'));
  assert.equal(os.shownLayout().tiles[11], TileType.FLOOR_1);
  assert.equal(os.visits.stopOf(1)!.stop.work, true, 'the builder heads for the new spot');
});

test('a resize that moved the tiles: what stayed is not rebuilt, characters move with the grid', () => {
  const os = office();
  const before = os.getLayout();
  // Grow two columns on the left, then place one box.
  const cols = COLS + 2;
  const tiles = new Array<TileType>(cols * ROWS).fill(TileType.VOID);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++)
      tiles[row * cols + col + 2] = before.tiles[row * COLS + col];
  }
  const grown: OfficeLayout = {
    ...before,
    cols,
    tiles,
    furniture: [...before.furniture.map((f) => ({ ...f, col: f.col + 2 })), box('new', 6, 2)],
  };
  const plan = planBuildout(before, grown, { col: 6, row: 2 }, { shift: { col: 2, row: 0 } })!;
  assert.deepEqual(
    plan.added.map((a) => a.uid),
    ['new'],
  );
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.tiles, []);

  const ch = os.characters.get(1)!;
  os.startBuildout(grown, { agentId: 1, origin: { col: 6, row: 2 } }, { col: 2, row: 0 });
  // Its seat moved two columns right with everything else.
  assert.equal(os.characters.get(1)!.seatId, 'seat');
  assert.equal(ch.tileCol, 3);
});

test('an edit with nothing visible to build (Areas only) builds nothing', () => {
  const os = office();
  const after: OfficeLayout = {
    ...baseLayout(),
    areas: [{ label: 'Room', color: ['#', '123456'].join('') }],
    areaTiles: new Array<string | null>(COLS * ROWS).fill('Room'),
  };
  os.startBuildout(after, { agentId: 1, origin: ORIGIN });
  assert.ok(!os.buildout.isPlaying);
  assert.equal(os.visits.stopOf(1), null, 'no walk for nothing');
  assert.equal(os.getLayout(), after);
});

test('an item moved toward the origin: the old one dissolves as the new one appears, never both shown', () => {
  const os = office();
  const after = baseLayout();
  // The box at (9,4) moves next to the origin.
  after.furniture = [after.furniture[0], box('old', 7, 3)];
  os.startBuildout(after, { agentId: 1, origin: ORIGIN });
  while (os.buildout.isPlaying) {
    const copies = shownUids(os).filter((uid) => uid === 'old').length;
    assert.ok(copies <= 1, 'shown at most once');
    os.update(FRAME);
  }
  assert.deepEqual(shownUids(os), ['seat', 'old']);
});
