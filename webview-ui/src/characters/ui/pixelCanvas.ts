/**
 * Pixel-perfect sprite canvases: every sprite pixel is exactly n device pixels, n a whole
 * number. CSS-only upscaling breaks at fractional devicePixelRatio (1.25, 1.5, browser
 * zoom) and gives uneven pixels, so canvases size their backing store in device pixels.
 */

import { type RefObject, useEffect } from 'react';

import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
} from '../../../../core/src/assets/constants.js';
import { SHEET_H, SHEET_W } from '../sheet.js';

export type Facing = 'down' | 'right' | 'up' | 'left';
export const FACINGS: readonly Facing[] = ['down', 'right', 'up', 'left'];
/** Sheet row per facing (left is right, mirrored). */
const ROW: Record<Facing, number> = { down: 0, up: 1, right: 2, left: 2 };
export const FRAME_W = CHAR_FRAME_W;
export const FRAME_H = CHAR_FRAME_H;
/** Frames per sheet row, and the rows (facings). */
export const FRAMES_PER_ROW = CHAR_FRAMES_PER_ROW;
export const ROW_NAMES = CHARACTER_DIRECTIONS;
export const FRAME_NAMES = [
  'walk1',
  'walk2',
  'walk3',
  'type1',
  'type2',
  'read1',
  'read2',
  'seated',
];
/** The front walk1 face, for the eye shape cards. */
export const FACE = { x: 2, y: 11, w: 12, h: 7 } as const;

/** Device pixels per sprite pixel for a CSS scale. */
export const devicePixels = (cssScale: number, dpr: number) =>
  Math.max(1, Math.round(cssScale * dpr));

/**
 * The biggest CSS scale at which a w x h sprite fits a width x height box, in whole
 * device pixels per sprite pixel so it stays pixel-perfect.
 */
export const fitScale = (w: number, h: number, width: number, height: number, dpr: number) =>
  Math.floor(Math.min(width / w, height / h) * dpr) / dpr;

/** The CSS size of `px` sprite pixels at `n` device pixels each, rounded up to layout's 1/64 px. */
export const cssSize = (px: number, n: number, dpr: number) =>
  Math.ceil(((px * n) / dpr) * 64 - 1e-6) / 64;

const sheetCanvases = new WeakMap<Uint8ClampedArray, HTMLCanvasElement>();
/** A sheet as a 128x96 canvas to draw from (one per sheet buffer). */
export function sheetImage(sheet: Uint8ClampedArray): HTMLCanvasElement {
  let canvas = sheetCanvases.get(sheet);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SHEET_W;
    canvas.height = SHEET_H;
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(sheet), SHEET_W), 0, 0);
    sheetCanvases.set(sheet, canvas);
  }
  return canvas;
}

export type SpriteView =
  { kind: 'frame'; facing: Facing; frame: number } | { kind: 'face' } | { kind: 'sheet' };

const viewSize = (view: SpriteView) =>
  view.kind === 'sheet'
    ? { w: SHEET_W, h: SHEET_H }
    : view.kind === 'face'
      ? { w: FACE.w, h: FACE.h }
      : { w: FRAME_W, h: FRAME_H };

/** Draw part of a sheet into a canvas sized by `sizeCanvas`. */
export function drawView(canvas: HTMLCanvasElement, sheet: Uint8ClampedArray, view: SpriteView) {
  const ctx = canvas.getContext('2d')!;
  const n = canvas.width / viewSize(view).w;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src = sheetImage(sheet);
  if (view.kind === 'sheet') {
    ctx.drawImage(src, 0, 0, SHEET_W, SHEET_H, 0, 0, SHEET_W * n, SHEET_H * n);
  } else if (view.kind === 'face') {
    ctx.drawImage(src, FACE.x, FACE.y, FACE.w, FACE.h, 0, 0, FACE.w * n, FACE.h * n);
  } else {
    if (view.facing === 'left') ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    const sx = view.frame * FRAME_W;
    const sy = ROW[view.facing] * FRAME_H;
    ctx.drawImage(src, sx, sy, FRAME_W, FRAME_H, 0, 0, FRAME_W * n, FRAME_H * n);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/** Size a canvas's backing store and CSS box for `cssScale`; returns device pixels per sprite pixel. */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  view: SpriteView,
  cssScale: number,
  dpr: number,
): number {
  const { w, h } = viewSize(view);
  const n = devicePixels(cssScale, dpr);
  if (canvas.width !== w * n) canvas.width = w * n;
  if (canvas.height !== h * n) canvas.height = h * n;
  canvas.style.width = `${cssSize(w, n, dpr)}px`;
  canvas.style.height = `${cssSize(h, n, dpr)}px`;
  return n;
}

/**
 * A canvas whose top-left corner falls between device pixels gets resampled (soft or
 * uneven pixels), so every canvas under `root` is nudged by its sub-pixel remainder after
 * layout changes, resizes and scrolls.
 */
export function useCanvasSnapping(root: RefObject<HTMLElement | null>, dpr: number): void {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const snap = () => {
      const canvases = [...el.querySelectorAll('canvas')];
      for (const c of canvases) c.style.translate = '';
      const rects = canvases.map((c) => c.getBoundingClientRect());
      canvases.forEach((c, i) => {
        const r = rects[i];
        if (!r.width) return;
        const dx = Math.round(r.left * dpr) / dpr - r.left;
        const dy = Math.round(r.top * dpr) / dpr - r.top;
        if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) c.style.translate = `${dx}px ${dy}px`;
      });
    };
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(snap);
    };
    soon();
    const resize = new ResizeObserver(soon);
    resize.observe(el);
    const mutations = new MutationObserver(soon);
    mutations.observe(el, { childList: true, subtree: true });
    window.addEventListener('resize', soon);
    el.addEventListener('scroll', soon, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', soon);
      el.removeEventListener('scroll', soon, { capture: true });
    };
  }, [root, dpr]);
}
