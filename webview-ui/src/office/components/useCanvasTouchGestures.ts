import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { TOUCH_TAP_MAX_DURATION_MS, ZOOM_MAX, ZOOM_MIN } from '../../constants.js';
import { unlockAudio } from '../../notificationSound.js';
import { withinTapSlop } from '../../touch/touchPrimitives.js';

interface CanvasTouchOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Off in edit mode: there a tap lands as the browser's synthesized
   *  mousedown/mouseup and drives select/paint through the mouse handlers.
   *  (Touch *drags* don't paint — mobile hides the editor.) */
  enabled: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panRef: { current: { x: number; y: number } };
  clampPan: (x: number, y: number) => { x: number; y: number };
  /** A pan began — the camera stops following anything automatically. */
  onManualPan: () => void;
  /** A short, still touch: same as a mouse click at that point. */
  onTap: (clientX: number, clientY: number) => void;
}

interface Point {
  clientX: number;
  clientY: number;
}

/**
 * One-finger pan, two-finger pinch zoom (with midpoint pan), short tap =
 * click, on the office canvas. Native non-passive listeners for the same
 * reason as wheel: React registers touch handlers passively, and we must
 * preventDefault so the browser neither scrolls nor synthesizes a duplicate
 * mouse click after our own tap handling.
 *
 * Listeners attach once per canvas/enabled change and read the latest zoom
 * and callbacks through a ref — a pinch changes zoom on every step and must
 * not tear the listeners down mid-gesture.
 */
export function useCanvasTouchGestures(options: CanvasTouchOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { canvasRef, enabled } = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;

    // 'pending-tap' promotes to 'pan' once the finger travels past the slop.
    let mode: 'none' | 'pending-tap' | 'pan' | 'pinch' = 'none';
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let panX = 0;
    let panY = 0;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    const distance = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const midpoint = (a: Touch, b: Touch): Point => ({
      clientX: (a.clientX + b.clientX) / 2,
      clientY: (a.clientY + b.clientY) / 2,
    });

    const anchorPan = (p: Point) => {
      startX = p.clientX;
      startY = p.clientY;
      panX = latest.current.panRef.current.x;
      panY = latest.current.panRef.current.y;
    };
    const panTo = (p: Point) => {
      const { panRef, clampPan } = latest.current;
      const dpr = window.devicePixelRatio || 1;
      panRef.current = clampPan(
        panX + (p.clientX - startX) * dpr,
        panY + (p.clientY - startY) * dpr,
      );
    };

    const onTouchStart = (e: TouchEvent) => {
      unlockAudio();
      e.preventDefault();
      if (e.touches.length === 1) {
        mode = 'pending-tap';
        startTime = performance.now();
        anchorPan(e.touches[0]);
      } else if (e.touches.length === 2) {
        // Second finger down: any pending tap/pan becomes a pinch.
        mode = 'pinch';
        pinchStartDist = distance(e.touches[0], e.touches[1]);
        pinchStartZoom = latest.current.zoom;
        anchorPan(midpoint(e.touches[0], e.touches[1]));
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (mode === 'pinch' && e.touches.length >= 2) {
        const { zoom, onZoomChange } = latest.current;
        const proposed = Math.round(
          pinchStartZoom * (distance(e.touches[0], e.touches[1]) / pinchStartDist),
        );
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, proposed));
        if (next !== zoom) onZoomChange(next);
        // Two-finger drag also pans, tracked from the midpoint.
        panTo(midpoint(e.touches[0], e.touches[1]));
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (mode === 'pending-tap' && !withinTapSlop(t.clientX - startX, t.clientY - startY)) {
        mode = 'pan';
        latest.current.onManualPan();
      }
      if (mode === 'pan') panTo(t);
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (mode === 'pending-tap' && performance.now() - startTime <= TOUCH_TAP_MAX_DURATION_MS) {
          const t = e.changedTouches[0];
          if (t) latest.current.onTap(t.clientX, t.clientY);
        }
        mode = 'none';
        return;
      }
      // Pinch finger lifted: continue as a plain pan from the remaining finger.
      if (e.touches.length === 1) {
        mode = 'pan';
        anchorPan(e.touches[0]);
      }
    };

    const onTouchCancel = () => {
      mode = 'none';
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchCancel);
    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [canvasRef, enabled]);
}
