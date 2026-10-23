/**
 * Camera controls (office/camera.ts): Fit's zoom + pan, keyboard panning and
 * the drag threshold — the "no way to move around except zoom" fix for the
 * TV / phone board. The DOM adapters (OfficeCanvas, useKeyboardPan,
 * useCameraFit) only feed these.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import { ZOOM_MAX, ZOOM_MIN } from '../src/constants.js';
import {
  contentBounds,
  fitCamera,
  isEditableTarget,
  keyPanDirection,
  keyPanImpulse,
  pastDragThreshold,
  scalePan,
  stepKeyPan,
  stepZoom,
} from '../src/office/camera.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';

const NO_MARGINS = { top: 0, right: 0, bottom: 0, left: 0 };

describe('fitCamera', () => {
  it('picks the largest integer zoom at which the whole office fits', () => {
    // 20×11 tiles = 320×176 sprite px. In 1000×600: 1000/320 = 3.1, 600/176 = 3.4.
    const fit = fitCamera(20, 11, { width: 1000, height: 600 }, NO_MARGINS, ZOOM_MIN, ZOOM_MAX);
    expect(fit.zoom).toBe(3);
    expect(20 * TILE_SIZE * fit.zoom).toBeLessThanOrEqual(1000);
    expect(11 * TILE_SIZE * fit.zoom).toBeLessThanOrEqual(600);
    expect(20 * TILE_SIZE * (fit.zoom + 1)).toBeGreaterThan(1000); // one more no longer fits
  });

  it('centers the office in the viewport when there are no margins', () => {
    const fit = fitCamera(20, 11, { width: 1000, height: 600 }, NO_MARGINS, ZOOM_MIN, ZOOM_MAX);
    expect(fit.panX).toBe(0);
    expect(fit.panY).toBe(0);
  });

  it('keeps the margins clear and centers in what remains', () => {
    // A tall toolbar strip at the bottom: 1000×700 minus 100 at the bottom
    // leaves 1000×600 → zoom 3 again, and the center moves up by 50.
    const fit = fitCamera(
      20,
      11,
      { width: 1000, height: 700 },
      { top: 0, right: 0, bottom: 100, left: 0 },
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(fit.zoom).toBe(3);
    expect(fit.panX).toBe(0);
    expect(fit.panY).toBe(-50);

    const sides = fitCamera(
      20,
      11,
      { width: 1000, height: 700 },
      { top: 0, right: 90, bottom: 0, left: 30 },
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(sides.panX).toBe(-30); // (30 - 90) / 2
  });

  it('a margin-bound viewport changes the answer: the margins are honoured, not ignored', () => {
    // 960 wide fits zoom 3 exactly; 64 + 88 of margins leave 808 → zoom 2.
    const bare = fitCamera(20, 11, { width: 960, height: 2000 }, NO_MARGINS, ZOOM_MIN, ZOOM_MAX);
    const kept = fitCamera(
      20,
      11,
      { width: 960, height: 2000 },
      { top: 16, right: 88, bottom: 120, left: 64 },
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(bare.zoom).toBe(3);
    expect(kept.zoom).toBe(2);
  });

  it('clamps to the zoom range: a huge screen stops at ZOOM_MAX, a tiny one at ZOOM_MIN', () => {
    expect(
      fitCamera(4, 3, { width: 8000, height: 8000 }, NO_MARGINS, ZOOM_MIN, ZOOM_MAX).zoom,
    ).toBe(ZOOM_MAX);
    expect(
      fitCamera(64, 64, { width: 200, height: 200 }, NO_MARGINS, ZOOM_MIN, ZOOM_MAX).zoom,
    ).toBe(ZOOM_MIN);
  });

  it('ignores margins on an axis they would swallow whole', () => {
    const fit = fitCamera(
      10,
      10,
      { width: 100, height: 400 },
      { top: 0, right: 60, bottom: 0, left: 60 },
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(fit.panX).toBe(0);
    expect(fit.zoom).toBe(ZOOM_MIN);
  });

  it('a bigger layout fits at a smaller zoom', () => {
    const viewport = { width: 1920, height: 1080 };
    const small = fitCamera(21, 22, viewport, NO_MARGINS, ZOOM_MIN, ZOOM_MAX);
    const big = fitCamera(40, 30, viewport, NO_MARGINS, ZOOM_MIN, ZOOM_MAX);
    expect(small.zoom).toBe(3);
    expect(big.zoom).toBe(2);
  });
});

describe('framing what is built', () => {
  const V = TileType.VOID;
  const W = TileType.WALL;
  const F = TileType.FLOOR_1;
  // 6×6 grid: VOID all round, a wall row, then floor — like the default
  // layout, which is 22 rows with only 11 of them built.
  // prettier-ignore
  const tiles = [
    V, V, V, V, V, V,
    V, V, V, V, V, V,
    V, W, W, W, W, V,
    V, F, F, F, F, V,
    V, F, F, F, F, V,
    V, V, V, V, V, V,
  ];

  it('contentBounds is the non-VOID box, plus the row a top wall rises into', () => {
    expect(contentBounds({ cols: 6, rows: 6, tiles })).toEqual({
      col: 1,
      row: 1,
      cols: 4,
      rows: 4,
    });
    const noWall = tiles.map((t) => (t === W ? F : t));
    expect(contentBounds({ cols: 6, rows: 6, tiles: noWall })).toEqual({
      col: 1,
      row: 2,
      cols: 4,
      rows: 3,
    });
  });

  it('an all-VOID (or empty) grid frames the whole grid', () => {
    expect(contentBounds({ cols: 3, rows: 2, tiles: new Array(6).fill(V) })).toEqual({
      col: 0,
      row: 0,
      cols: 3,
      rows: 2,
    });
  });

  it('fits the built box, not the grid, and centers it', () => {
    const bounds = contentBounds({ cols: 6, rows: 6, tiles }); // 4×4 at (1,1)
    // 4×4 tiles = 64 sprite px → zoom 4 in 300×300; the whole 6×6 grid would only allow 3.
    const fit = fitCamera(
      6,
      6,
      { width: 300, height: 300 },
      NO_MARGINS,
      ZOOM_MIN,
      ZOOM_MAX,
      bounds,
    );
    expect(fit.zoom).toBe(4);
    // Box center (3, 3) tiles vs grid center (3, 3): x already centered;
    // y: box center row 3 vs grid center 3 → centered too.
    expect([fit.panX, fit.panY]).toEqual([0, 0]);

    // A box in the grid's top-left quarter is pulled to the middle.
    const corner = { col: 0, row: 0, cols: 2, rows: 2 };
    const off = fitCamera(
      6,
      6,
      { width: 300, height: 300 },
      NO_MARGINS,
      ZOOM_MIN,
      ZOOM_MAX,
      corner,
    );
    // 2 tiles = 32 px → zoom 9; box center 1 tile vs grid center 3 → +2 tiles.
    expect(off.zoom).toBe(9);
    expect(off.panX).toBe(2 * TILE_SIZE * 9);
    expect(off.panY).toBe(2 * TILE_SIZE * 9);
  });
});

describe('scalePan', () => {
  it('keeps the point at the view center: pan scales with the zoom', () => {
    expect(scalePan({ x: -192, y: 60 }, 3, 2)).toEqual({ x: -128, y: 40 });
    expect(scalePan({ x: 0, y: 0 }, 3, 5)).toEqual({ x: 0, y: 0 });
    // Round trip lands back where it started.
    const there = scalePan({ x: 90, y: -45 }, 3, 7);
    expect(scalePan(there, 7, 3)).toEqual({ x: 90, y: -45 });
  });
});

describe('keyPanDirection', () => {
  it('maps the arrows always', () => {
    expect(keyPanDirection('ArrowLeft', false)).toEqual({ dx: -1, dy: 0 });
    expect(keyPanDirection('ArrowRight', false)).toEqual({ dx: 1, dy: 0 });
    expect(keyPanDirection('ArrowUp', false)).toEqual({ dx: 0, dy: -1 });
    expect(keyPanDirection('ArrowDown', false)).toEqual({ dx: 0, dy: 1 });
  });

  it('maps WASD only when letters are on (off in the layout editor)', () => {
    expect(keyPanDirection('w', true)).toEqual({ dx: 0, dy: -1 });
    expect(keyPanDirection('a', true)).toEqual({ dx: -1, dy: 0 });
    expect(keyPanDirection('s', true)).toEqual({ dx: 0, dy: 1 });
    expect(keyPanDirection('d', true)).toEqual({ dx: 1, dy: 0 });
    for (const key of ['w', 'a', 's', 'd']) expect(keyPanDirection(key, false)).toBeNull();
  });

  it('is case-insensitive for letters (Shift / Caps Lock)', () => {
    expect(keyPanDirection('W', true)).toEqual({ dx: 0, dy: -1 });
    expect(keyPanDirection('D', true)).toEqual({ dx: 1, dy: 0 });
  });

  it("leaves the editor's own keys and everything else alone", () => {
    for (const key of ['r', 'R', 't', 'T', 'Escape', 'z', 'Delete', ' ', 'Enter', 'Shift']) {
      expect(keyPanDirection(key, true)).toBeNull();
    }
  });
});

describe('isEditableTarget', () => {
  it('is true for inputs, textareas (xterm), selects and contenteditables', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'select' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for the page itself, buttons and the canvas', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget({ tagName: 'CANVAS', isContentEditable: false })).toBe(false);
  });
});

describe('keyboard pan motion', () => {
  const RATE = 10;
  const SPEED = 400; // device px/s

  it('a press queues a step against the view direction (view right → map left)', () => {
    expect(keyPanImpulse({ dx: 1, dy: 0 }, 96)).toEqual({ x: -96, y: 0 });
    expect(keyPanImpulse({ dx: 0, dy: -1 }, 96)).toEqual({ x: 0, y: 96 });
  });

  it('the step glides out smoothly and lands exactly, frame by frame', () => {
    let glideX = -96;
    let total = 0;
    const deltas: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      const step = stepKeyPan({
        glideX,
        glideY: 0,
        heldX: 0,
        heldY: 0,
        dt: 1 / 60,
        glideRate: RATE,
        holdSpeed: SPEED,
      });
      glideX = step.glideX;
      total += step.panDX;
      deltas.push(Math.abs(step.panDX));
    }
    expect(total).toBeCloseTo(-96, 6);
    expect(glideX).toBe(0);
    // Ease-out: the first frame moves the most, and no frame jumps the whole way.
    expect(deltas[0]).toBeGreaterThan(deltas[10]);
    expect(deltas[0]).toBeLessThan(96 / 2);
  });

  it('a held key drifts at the hold speed, opposite the view direction', () => {
    const step = stepKeyPan({
      glideX: 0,
      glideY: 0,
      heldX: 1,
      heldY: -1,
      dt: 0.5,
      glideRate: RATE,
      holdSpeed: SPEED,
    });
    expect(step.panDX).toBeCloseTo(-200);
    expect(step.panDY).toBeCloseTo(200);
  });

  it('a zero-length frame moves nothing', () => {
    const step = stepKeyPan({
      glideX: -50,
      glideY: 20,
      heldX: 1,
      heldY: 0,
      dt: 0,
      glideRate: RATE,
      holdSpeed: SPEED,
    });
    expect(step.panDX).toBeCloseTo(0);
    expect(step.panDY).toBeCloseTo(0);
    expect(step.glideX).toBe(-50);
    expect(step.glideY).toBe(20);
  });
});

describe('pastDragThreshold', () => {
  it('a jiggle is still a click; past the threshold it is a drag', () => {
    expect(pastDragThreshold(0, 0, 5)).toBe(false);
    expect(pastDragThreshold(3, 4, 5)).toBe(false); // exactly 5
    expect(pastDragThreshold(4, 4, 5)).toBe(true);
    expect(pastDragThreshold(-6, 0, 5)).toBe(true);
  });
});

describe('stepZoom (the zoom buttons and Ctrl+wheel)', () => {
  const up = (z: number) => stepZoom(z, 1, ZOOM_MIN, ZOOM_MAX);
  const down = (z: number) => stepZoom(z, -1, ZOOM_MIN, ZOOM_MAX);

  it('steps by about 15%, not a whole zoom level', () => {
    expect(up(2)).toBe(2.25);
    expect(up(2.25)).toBe(2.5);
    expect(up(3)).toBe(3.5);
    expect(down(2.25)).toBe(2);
    expect(down(3)).toBe(2.5);
  });

  it('lands on quarter steps, so a 16 px tile stays whole device pixels', () => {
    let z = ZOOM_MIN;
    while (z < ZOOM_MAX) {
      z = up(z);
      expect(Number.isInteger(16 * z)).toBe(true);
    }
  });

  it('always moves at least a quarter, and stops at the limits', () => {
    expect(up(1)).toBe(1.25);
    expect(down(1.25)).toBe(1);
    expect(down(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(up(ZOOM_MAX)).toBe(ZOOM_MAX);
  });

  it('snaps an odd starting zoom first', () => {
    expect(up(2.1)).toBe(2.25);
  });
});
