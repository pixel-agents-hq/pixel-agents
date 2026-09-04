import type { Frame } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  dragFurnitureTo,
  duplicateFurnitureTo,
  endStroke,
  enterEditMode,
  eraseTile,
  furniturePanel,
  paintTile,
  pressEditorKey,
  readFurniture,
  readTilesAt,
  selectEraseTool,
  selectFloorPattern,
  selectFloorTool,
  selectFurnitureAt,
  selectFurnitureTool,
  selectWallTool,
  type TestHooksWindow,
  TILE,
  undo,
} from '../../../helpers/editor';
import { buildSeedLayout } from '../../../helpers/layout-seed';

/**
 * e2e coverage for the layout editor's erase semantics and stroke-based undo.
 *
 * Two behaviours are pinned here:
 *  1. Erase clears a tile to VOID *and* deletes any furniture whose footprint
 *     the stroke passes through (removeFurnitureAt in editorActions.ts).
 *  2. One click-drag = one undo entry for every drag-painting tool — floor,
 *     wall, and erase (applyStrokeEdit in useEditorActions.ts). Carpet already
 *     had this and is covered in carpet.spec.ts.
 *
 * Tiles render only on the canvas (no DOM), so assertions read state through
 * window.__pixelAgentsTestHooks.getTiles() / getFurniture() — the same
 * canvas-state approach the carpet and pets specs use. Tool selection goes
 * through the real toolbar; tile targeting goes through the editorTileAction
 * hook, which bypasses ONLY canvas pixel→tile geometry. Stroke boundaries are
 * NOT bypassed — endStroke() dispatches a real mouseup on the canvas, because
 * "every edit collapses into one undo entry" is precisely the regression these
 * tests exist to catch.
 *
 * hooks-off lane: the layout editor has no hook dependency; lighter fixture.
 */

const DEFAULT_LAYOUT_PATH = path.join(
  __dirname,
  '../../../../webview-ui/public/assets/default-layout-1.json',
);

/** A valid furniture type from the bundled default layout (catalog-backed). */
function firstDefaultFurnitureType(): string {
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT_PATH, 'utf8')) as {
    furniture?: Array<{ type: string }>;
  };
  const type = parsed.furniture?.[0]?.type;
  if (!type) throw new Error('No furniture in bundled default layout to seed the editor tests');
  return type;
}

async function waitForFurnitureCount(frame: Frame, count: number): Promise<void> {
  await frame.waitForFunction(
    (n) => (window as TestHooksWindow).__pixelAgentsTestHooks?.getFurnitureCount?.() === n,
    count,
    { timeout: 10_000 },
  );
}

test.describe('Layout editor — erase', () => {
  // All-floor grid with one catalog-backed item anchored at (3,3). A seeded
  // furniture-free grid would make "erase deletes furniture" unfalsifiable.
  test.use({
    seedLayout: (() => {
      const layout = buildSeedLayout({ cols: 12, rows: 12 });
      layout.furniture = [{ uid: 'seed-desk', type: firstDefaultFurnitureType(), col: 3, row: 3 }];
      return layout;
    })(),
  });

  test('erasing a tile deletes the furniture it passes through @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk at (3,3) to load');
    await waitForFurnitureCount(frame, 1);
    narrator.check('one seeded furniture item present before erasing');

    narrator.step('opening the layout editor and selecting the erase tool');
    await enterEditMode(frame);
    await selectEraseTool(frame);

    narrator.step('erasing (3,3) — the desk’s anchor tile');
    await paintTile(frame, 3, 3);

    await waitForFurnitureCount(frame, 0);
    narrator.check('furniture count 1 → 0: the erase stroke deleted the item it crossed');

    expect(await readTilesAt(frame, [[3, 3]])).toEqual([TILE.VOID]);
    narrator.check('tile (3,3) is VOID — the tile itself was cleared too');
  });

  test('erasing away from an item leaves it in place @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk at (3,3) to load');
    await waitForFurnitureCount(frame, 1);

    narrator.step('opening the layout editor and selecting the erase tool');
    await enterEditMode(frame);
    await selectEraseTool(frame);

    // (9,9) is far outside any plausible footprint of a single seeded item —
    // this is the negative case proving erase isn't just clearing everything.
    narrator.step('erasing (9,9), far from the desk');
    await paintTile(frame, 9, 9);
    await expect.poll(() => readTilesAt(frame, [[9, 9]])).toEqual([TILE.VOID]);
    narrator.check('tile (9,9) is VOID');

    const furniture = await readFurniture(frame);
    expect(furniture.map((f) => f.uid)).toContain('seed-desk');
    narrator.check('the desk survived — only furniture under the stroke is removed');
  });

  test('one undo restores both the tiles and the furniture an erase stroke removed @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk at (3,3) to load');
    await waitForFurnitureCount(frame, 1);

    narrator.step('opening the layout editor and selecting the erase tool');
    await enterEditMode(frame);
    await selectEraseTool(frame);

    // One continuous stroke across the desk plus two bare tiles.
    narrator.step('erasing (3,3), (4,3) and (5,3) in one continuous stroke');
    await paintTile(frame, 3, 3);
    await paintTile(frame, 4, 3);
    await paintTile(frame, 5, 3);
    await waitForFurnitureCount(frame, 0);
    narrator.check('the desk is gone and the stroke cleared its tiles');

    narrator.step('clicking Undo once');
    await undo(frame);

    await waitForFurnitureCount(frame, 1);
    narrator.check('the desk is back after a single undo');

    await expect
      .poll(() =>
        readTilesAt(frame, [
          [3, 3],
          [4, 3],
          [5, 3],
        ]),
      )
      .toEqual([TILE.FLOOR_1, TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('all three tiles restored — tile + furniture share one undo entry');
  });

  test('a right-drag erase stroke is a single undo entry @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('opening the layout editor and selecting the floor tool');
    await enterEditMode(frame);
    await selectFloorTool(frame);

    // Right-drag erases regardless of the active paint tool (useEditorActions'
    // handleEditorEraseAction), so this covers the second erase entry point.
    narrator.step('right-drag erasing (6,6) and (7,6) in one stroke');
    await eraseTile(frame, 6, 6);
    await eraseTile(frame, 7, 6);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [6, 6],
          [7, 6],
        ]),
      )
      .toEqual([TILE.VOID, TILE.VOID]);
    narrator.check('both tiles cleared to VOID by the right-drag');

    narrator.step('clicking Undo once');
    await undo(frame);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [6, 6],
          [7, 6],
        ]),
      )
      .toEqual([TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('both tiles restored by one undo — the right-drag is one entry');
  });
});

test.describe('Layout editor — stroke undo', () => {
  test.use({ seedLayout: buildSeedLayout({ cols: 12, rows: 12 }) });

  test('a floor paint stroke is a single undo entry @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('opening the layout editor → floor tool, pattern 2');
    await enterEditMode(frame);
    await selectFloorTool(frame);
    // The grid is seeded FLOOR_1, so paint FLOOR_2 to make the change visible.
    await selectFloorPattern(frame, TILE.FLOOR_2);

    narrator.step('painting (2,2), (3,2) and (4,2) in one continuous stroke');
    await paintTile(frame, 2, 2);
    await paintTile(frame, 3, 2);
    await paintTile(frame, 4, 2);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 2],
          [3, 2],
          [4, 2],
        ]),
      )
      .toEqual([TILE.FLOOR_2, TILE.FLOOR_2, TILE.FLOOR_2]);
    narrator.check('three tiles painted with pattern 2');

    narrator.step('clicking Undo once');
    await undo(frame);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 2],
          [3, 2],
          [4, 2],
        ]),
      )
      .toEqual([TILE.FLOOR_1, TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('all three revert together — the stroke is one undo entry');
  });

  test('a wall paint stroke is a single undo entry @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('opening the layout editor → wall tool');
    await enterEditMode(frame);
    await selectWallTool(frame);

    narrator.step('painting walls at (2,5), (3,5) and (4,5) in one stroke');
    await paintTile(frame, 2, 5);
    await paintTile(frame, 3, 5);
    await paintTile(frame, 4, 5);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 5],
          [3, 5],
          [4, 5],
        ]),
      )
      .toEqual([TILE.WALL, TILE.WALL, TILE.WALL]);
    narrator.check('three wall tiles painted');

    narrator.step('clicking Undo once');
    await undo(frame);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 5],
          [3, 5],
          [4, 5],
        ]),
      )
      .toEqual([TILE.FLOOR_1, TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('all three walls revert together — one undo entry');
  });

  test('separate strokes stay separate undo entries @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('opening the layout editor → floor tool, pattern 2');
    await enterEditMode(frame);
    await selectFloorTool(frame);
    await selectFloorPattern(frame, TILE.FLOOR_2);

    // Guards the opposite regression: if endStroke() were never called, every
    // edit would pile into one undo entry and the first Undo would wipe both.
    narrator.step('stroke A: painting (2,8) and (3,8), then releasing the mouse');
    await paintTile(frame, 2, 8);
    await paintTile(frame, 3, 8);
    await endStroke(frame);

    narrator.step('stroke B: painting (5,8) and (6,8)');
    await paintTile(frame, 5, 8);
    await paintTile(frame, 6, 8);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 8],
          [3, 8],
          [5, 8],
          [6, 8],
        ]),
      )
      .toEqual([TILE.FLOOR_2, TILE.FLOOR_2, TILE.FLOOR_2, TILE.FLOOR_2]);
    narrator.check('four tiles painted across two strokes');

    narrator.step('clicking Undo once — only stroke B should revert');
    await undo(frame);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 8],
          [3, 8],
          [5, 8],
          [6, 8],
        ]),
      )
      .toEqual([TILE.FLOOR_2, TILE.FLOOR_2, TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('stroke B reverted, stroke A intact — the mouse-up split the entries');

    narrator.step('clicking Undo again — stroke A should revert');
    await undo(frame);
    await expect
      .poll(() =>
        readTilesAt(frame, [
          [2, 8],
          [3, 8],
        ]),
      )
      .toEqual([TILE.FLOOR_1, TILE.FLOOR_1]);
    narrator.check('stroke A reverted by the second undo — two strokes, two entries');
  });
});

/**
 * Furniture standing on a desk (anything with `canPlaceOnSurfaces` overlapping
 * an `isDesk` item) travels with that desk: a drag carries it, an Alt-drag
 * copies it along with the desk, and a rotation turns it and swings its spot
 * round the desk top.
 *
 * The two seeded assets are bundled rotation groups: DESK is 2-way
 * (front 3x2 ↔ side 1x4) and PC is 4-way, so a rotation changes BOTH types —
 * the rider isn't merely translated. Coordinates are exact because the desk's
 * per-orientation footprints are authored, not derived, so the rider's new spot
 * is a fixed consequence of the mapping in rotateFurniture.
 */
const DESK = 'DESK_FRONT'; // 3x2, rotates to DESK_SIDE (1x4)
const SURFACE_ITEM = 'PC_FRONT_OFF'; // 1x2, sits on the desk at local (1,0)

test.describe('Layout editor — desks carry what stands on them', () => {
  test.use({
    seedLayout: (() => {
      const layout = buildSeedLayout({ cols: 12, rows: 12 });
      layout.furniture = [
        { uid: 'seed-desk', type: DESK, col: 3, row: 3 },
        { uid: 'seed-pc', type: SURFACE_ITEM, col: 4, row: 3 },
      ];
      return layout;
    })(),
  });

  test('dragging a desk moves the item standing on it @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);

    narrator.step('opening the layout editor');
    await enterEditMode(frame);

    // 3 rows down: the desk's new footprint covers the PC's old tiles, which is
    // exactly the overlap that used to make a short drag impossible.
    narrator.step('dragging the desk from (3,3) to (3,6)');
    await dragFurnitureTo(frame, 'seed-desk', 3, 6);

    await expect
      .poll(async () => {
        const byUid = Object.fromEntries((await readFurniture(frame)).map((f) => [f.uid, f]));
        return [byUid['seed-desk'], byUid['seed-pc']].map((f) => f && `${f.col},${f.row}`);
      })
      .toEqual(['3,6', '4,6']);
    narrator.check('desk (3,3)→(3,6) and the PC on it (4,3)→(4,6) — same delta, one drag');
  });

  test('a drag that would push the item on the desk off the grid is refused @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    // The desk alone would fit at row 10 (3x2 → rows 10-11); the PC riding it
    // would not (rows 10-11 too, but the group is validated as one).
    narrator.step('dragging the desk to (3,11) — the bottom edge of a 12-row grid');
    await dragFurnitureTo(frame, 'seed-desk', 3, 11);

    const furniture = await readFurniture(frame);
    const desk = furniture.find((f) => f.uid === 'seed-desk');
    expect(`${desk?.col},${desk?.row}`).toBe('3,3');
    narrator.check('the desk stayed put — the whole group has to fit, not just the desk');
  });

  test('rotating a desk turns the item standing on it @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    // (3,4) is covered by the desk only — the PC occupies column 4.
    narrator.step('selecting the desk by clicking its own tile (3,4)');
    await selectFurnitureAt(frame, 3, 4);

    narrator.step('pressing R to rotate');
    await pressEditorKey(frame, 'r');

    await expect
      .poll(async () => {
        const byUid = Object.fromEntries((await readFurniture(frame)).map((f) => [f.uid, f]));
        const pc = byUid['seed-pc'];
        return { desk: byUid['seed-desk']?.type, pc: pc?.type, at: pc && `${pc.col},${pc.row}` };
      })
      .toEqual({ desk: 'DESK_SIDE', pc: 'PC_SIDE', at: '3,4' });
    narrator.check(
      'desk front→side, PC front→side, and the PC moved onto the 1-wide side desk at (3,4)',
    );
  });

  test('alt-dragging a desk copies it with the item standing on it @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    narrator.step('alt-dragging the desk from (3,3) to (3,7)');
    await duplicateFurnitureTo(frame, 'seed-desk', 3, 7);

    await waitForFurnitureCount(frame, 4);
    narrator.check('2 → 4 items: the desk AND the PC on it were copied, not just the desk');

    const furniture = await readFurniture(frame);
    const at = (col: number, row: number) =>
      furniture.filter((f) => f.col === col && f.row === row);
    expect(at(3, 3).map((f) => f.uid)).toEqual(['seed-desk']);
    expect(at(4, 3).map((f) => f.uid)).toEqual(['seed-pc']);
    narrator.check('both originals are still where they were — a copy, not a move');

    expect(at(3, 7).map((f) => f.type)).toEqual([DESK]);
    expect(at(4, 7).map((f) => f.type)).toEqual([SURFACE_ITEM]);
    narrator.check('desk copy at (3,7) with its PC copy at (4,7) — same delta for the whole group');

    expect(new Set(furniture.map((f) => f.uid)).size).toBe(4);
    narrator.check('every copy got a fresh uid — nothing collides with the originals');
  });

  test('an alt-drag copy that overlaps the original is refused @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    // One column right overlaps the desk's own solid row (the desk's top row is
    // a background row, so only row 4 blocks). A move vacates those tiles and
    // fits; a copy leaves the original standing on them.
    narrator.step('alt-dragging the desk one column right, over its own tiles');
    await duplicateFurnitureTo(frame, 'seed-desk', 4, 3);

    expect((await readFurniture(frame)).length).toBe(2);
    narrator.check('no copy was made — the original still blocks the tiles it sits on');

    narrator.step('dragging the desk to the same (4,3) without alt');
    await dragFurnitureTo(frame, 'seed-desk', 4, 3);

    await expect
      .poll(async () => {
        const desk = (await readFurniture(frame)).find((f) => f.uid === 'seed-desk');
        return desk && `${desk.col},${desk.row}`;
      })
      .toBe('4,3');
    narrator.check('the plain move lands there — only the copy is blocked by the original');
  });

  test('one undo removes the whole copied group @area:editor', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    narrator.step('alt-dragging the desk from (3,3) to (3,7)');
    await duplicateFurnitureTo(frame, 'seed-desk', 3, 7);
    await waitForFurnitureCount(frame, 4);

    narrator.step('clicking Undo once');
    await undo(frame);

    await waitForFurnitureCount(frame, 2);
    narrator.check('both copies vanish together — the group is a single undo entry');
  });

  test('selecting a placed item closes the open tool panel, and R rotates it @area:editor', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the seeded desk + PC to load');
    await waitForFurnitureCount(frame, 2);
    await enterEditMode(frame);

    narrator.step('opening the Furniture panel without picking a catalog item');
    await selectFurnitureTool(frame);
    await expect(furniturePanel(frame)).toBeVisible();
    narrator.check('the Furniture panel is open');

    narrator.step('selecting the placed desk at (3,4)');
    await selectFurnitureAt(frame, 3, 4);

    await expect(furniturePanel(frame)).toBeHidden();
    narrator.check('the panel closed — picking an item out of the office collapses the open tab');

    // The selection, not the (empty) catalog type, is what R must target — the
    // regression this test has always guarded.
    narrator.step('pressing R');
    await pressEditorKey(frame, 'r');

    await expect
      .poll(async () => (await readFurniture(frame)).find((f) => f.uid === 'seed-desk')?.type)
      .toBe('DESK_SIDE');
    narrator.check('the desk rotated — the click left it selected, only the panel went away');
  });
});
