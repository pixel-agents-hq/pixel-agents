import { useCallback, useEffect, useRef } from 'react';

import { ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import type { Margins } from '../office/camera.js';
import { contentBounds, fitCamera, scalePan } from '../office/camera.js';
import type { OfficeState } from '../office/engine/officeState.js';

interface CameraFitOptions {
  getOfficeState: () => OfficeState;
  /** The office region the canvas fills (the canvas is sized to it). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom: (zoom: number) => void;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  /** What to keep clear around the office, CSS px (FIT_MARGINS_*). */
  margins: Margins;
  /** Fit by itself — on the first layout, and again whenever the layout's
   *  size or the viewport changes — until the user takes the camera. */
  autoFit: boolean;
  layoutReady: boolean;
  /** No automatic fit while editing: growing the grid a tile at a time must
   *  not re-zoom under the cursor. */
  isEditMode: boolean;
}

export interface CameraFitControls {
  /** The Fit button: frame the whole office now, and hand the camera back to
   *  auto-fit (it re-fits on later layout / viewport changes again). */
  fit: () => void;
  /** A zoom the user asked for (buttons, Ctrl+wheel, pinch): about the view's
   *  center, and auto-fit stands down. */
  userZoom: (zoom: number) => void;
  /** The user panned (drag, wheel, keys, touch): auto-fit stands down. */
  markManual: () => void;
}

/**
 * Fit-to-office for the camera. The math is office/camera.fitCamera; this
 * hook reads the viewport and owns the one rule about WHEN: auto-fit frames
 * the office when the first layout arrives, and again when its cols×rows (or
 * the viewport) change — the board on a TV gets a bigger layout while
 * running — but never after the user has zoomed or panned by hand in this
 * session. Pressing Fit is the user choosing fit again, so it re-arms it.
 *
 * Watching is a rAF check of two sizes against the last fitted ones: the
 * layout lives in imperative OfficeState (no React signal when the editor,
 * an import or a layoutLoaded rebuilds it), and the canvas follows its
 * container's size, which any panel or keyboard can change.
 */
export function useCameraFit({
  getOfficeState,
  containerRef,
  zoom,
  setZoom,
  panRef,
  margins,
  autoFit,
  layoutReady,
  isEditMode,
}: CameraFitOptions): CameraFitControls {
  const userTookCamera = useRef(false);
  const latest = useRef({ margins, isEditMode });
  latest.current = { margins, isEditMode };
  // The zoom the pan was last set for. Moved on the spot by every zoom this
  // hook makes — two steps inside one frame (a fast wheel) must not scale the
  // pan from the same stale zoom twice — and resynced from props each render.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  /** Fit now; returns the size key it fitted for, or null with no viewport yet. */
  const applyFit = useCallback((): string | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const layout = getOfficeState().getLayout();
    const m = latest.current.margins;
    const fit = fitCamera(
      layout.cols,
      layout.rows,
      { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) },
      { top: m.top * dpr, right: m.right * dpr, bottom: m.bottom * dpr, left: m.left * dpr },
      ZOOM_MIN,
      ZOOM_MAX,
      // Frame what's built, not the grid's VOID margins.
      contentBounds(layout),
    );
    setZoom(fit.zoom);
    zoomRef.current = fit.zoom;
    panRef.current = { x: fit.panX, y: fit.panY };
    return sizeKey(layout.cols, layout.rows, rect.width, rect.height, dpr);
  }, [containerRef, getOfficeState, setZoom, panRef]);

  const fittedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!autoFit || !layoutReady) return;
    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const layout = getOfficeState().getLayout();
      const key = sizeKey(
        layout.cols,
        layout.rows,
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );
      if (key === fittedKeyRef.current) return;
      if (userTookCamera.current || latest.current.isEditMode) {
        // Not ours to change — and not a pending fit either: leaving the
        // editor must not re-zoom over what was just built.
        fittedKeyRef.current = key;
        return;
      }
      fittedKeyRef.current = applyFit();
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [autoFit, layoutReady, containerRef, getOfficeState, applyFit]);

  const fit = useCallback(() => {
    userTookCamera.current = false;
    // A followed agent would pull the camera straight back off the fit.
    getOfficeState().breakCameraFollow();
    fittedKeyRef.current = applyFit();
  }, [applyFit, getOfficeState]);

  const userZoom = useCallback(
    (next: number) => {
      userTookCamera.current = true;
      const to = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      if (to !== zoomRef.current) {
        panRef.current = scalePan(panRef.current, zoomRef.current, to);
        zoomRef.current = to;
      }
      setZoom(to);
    },
    [setZoom, panRef],
  );

  const markManual = useCallback(() => {
    userTookCamera.current = true;
  }, []);

  return { fit, userZoom, markManual };
}

function sizeKey(cols: number, rows: number, w: number, h: number, dpr: number): string {
  return `${cols}x${rows}@${Math.round(w * dpr)}x${Math.round(h * dpr)}`;
}
