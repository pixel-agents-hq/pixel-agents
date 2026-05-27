/**
 * HSV color wheel: SV square + vertical hue rainbow. Replaces the HSBC slider
 * stack for carpet colors so users can pick a color visually instead of
 * thinking in terms of Photoshop Colorize axes.
 *
 * Conversion: SV "value" axis (0..100) maps to ColorValue.b (-100..100) via
 * `b = 2*v - 100`. Saturation axis (0..100) maps directly to `s`. `c` is
 * always 0. `colorize: true` is always emitted since the carpet renderer
 * uses flat colorization.
 *
 * Drag is captured at the document level via useEffect-managed listeners so
 * the marker keeps tracking when the cursor exits the picker bounds, matching
 * production color pickers (Photoshop, Figma).
 */

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  VISUAL_COLOR_PICKER_HUE_GRADIENT,
  VISUAL_COLOR_PICKER_HUE_WIDTH_PX,
  VISUAL_COLOR_PICKER_MARKER_BORDER,
  VISUAL_COLOR_PICKER_MARKER_RADIUS_PX,
  VISUAL_COLOR_PICKER_MARKER_SHADOW,
  VISUAL_COLOR_PICKER_SV_BLACK_GRADIENT,
  VISUAL_COLOR_PICKER_SV_SIZE_PX,
  VISUAL_COLOR_PICKER_SV_WHITE_GRADIENT,
  VISUAL_COLOR_PICKER_WIDTH_PX,
  visualColorPickerSvBaseColor,
} from '../constants.js';
import type { ColorValue } from './ui/types.js';

interface VisualColorPickerProps {
  value: ColorValue;
  onChange: (color: ColorValue) => void;
  /** Optional label displayed above the picker. */
  label?: string;
  /** Container width in pixels. Defaults to VISUAL_COLOR_PICKER_WIDTH_PX. */
  width?: number;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** Convert ColorValue (colorize HSBC) → {h, s, v} where v in 0..100. */
function colorValueToHsv(c: ColorValue): Hsv {
  const h = Math.max(0, Math.min(360, c.h));
  const s = Math.max(0, Math.min(100, c.s));
  // colorize "b" is signed -100..100; map to 0..100 by (b + 100) / 2.
  const v = Math.max(0, Math.min(100, (c.b + 100) / 2));
  return { h, s, v };
}

/** Convert {h, s, v} (0..360, 0..100, 0..100) back to ColorValue with colorize: true. */
function hsvToColorValue(hsv: Hsv): ColorValue {
  return {
    h: Math.round(hsv.h),
    s: Math.round(hsv.s),
    b: Math.round(hsv.v * 2 - 100),
    c: 0,
    colorize: true,
  };
}

/** Convert {h, s, v} (0..360, 0..100, 0..100) to a hex preview string. */
function hsvToHex(hsv: Hsv): string {
  const h = hsv.h / 360;
  const s = hsv.s / 100;
  const v = hsv.v / 100;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function VisualColorPicker({ value, onChange, label, width }: VisualColorPickerProps) {
  const totalWidth = width ?? VISUAL_COLOR_PICKER_WIDTH_PX;
  const svSize = VISUAL_COLOR_PICKER_SV_SIZE_PX;
  const hueWidth = VISUAL_COLOR_PICKER_HUE_WIDTH_PX;
  const markerR = VISUAL_COLOR_PICKER_MARKER_RADIUS_PX;

  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  const [hsv, setHsv] = useState<Hsv>(() => colorValueToHsv(value));
  const [isDraggingSV, setIsDraggingSV] = useState(false);
  const [isDraggingHue, setIsDraggingHue] = useState(false);

  // Track the last "emitted" ColorValue so parent-driven re-renders don't loop.
  const lastEmittedRef = useRef<ColorValue>(value);
  useEffect(() => {
    if (
      value.h !== lastEmittedRef.current.h ||
      value.s !== lastEmittedRef.current.s ||
      value.b !== lastEmittedRef.current.b
    ) {
      setHsv(colorValueToHsv(value));
      lastEmittedRef.current = value;
    }
  }, [value]);

  const emit = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const cv = hsvToColorValue(next);
      lastEmittedRef.current = cv;
      onChange(cv);
    },
    [onChange],
  );

  const updateSVFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, rect.width);
      const y = clamp(clientY - rect.top, 0, rect.height);
      const s = (x / rect.width) * 100;
      const v = 100 - (y / rect.height) * 100;
      emit({ h: hsv.h, s, v });
    },
    [emit, hsv.h],
  );

  const updateHueFromClient = useCallback(
    (clientY: number) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = clamp(clientY - rect.top, 0, rect.height);
      const h = (y / rect.height) * 360;
      emit({ h, s: hsv.s, v: hsv.v });
    },
    [emit, hsv.s, hsv.v],
  );

  const onSVMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDraggingSV(true);
      updateSVFromClient(e.clientX, e.clientY);
    },
    [updateSVFromClient],
  );

  const onHueMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDraggingHue(true);
      updateHueFromClient(e.clientY);
    },
    [updateHueFromClient],
  );

  // Document-level listeners while dragging — so the cursor can leave the picker
  // bounds without breaking the drag.
  useEffect(() => {
    if (!isDraggingSV && !isDraggingHue) return undefined;
    const onMove = (e: MouseEvent) => {
      if (isDraggingSV) updateSVFromClient(e.clientX, e.clientY);
      if (isDraggingHue) updateHueFromClient(e.clientY);
    };
    const onUp = () => {
      setIsDraggingSV(false);
      setIsDraggingHue(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSV, isDraggingHue, updateSVFromClient, updateHueFromClient]);

  const svBackground: CSSProperties = useMemo(
    () => ({
      width: svSize,
      height: svSize,
      backgroundColor: visualColorPickerSvBaseColor(hsv.h),
      backgroundImage: `${VISUAL_COLOR_PICKER_SV_BLACK_GRADIENT}, ${VISUAL_COLOR_PICKER_SV_WHITE_GRADIENT}`,
      backgroundBlendMode: 'normal',
      position: 'relative',
      cursor: isDraggingSV ? 'grabbing' : 'crosshair',
      imageRendering: 'pixelated',
    }),
    [hsv.h, isDraggingSV, svSize],
  );

  const hueBackground: CSSProperties = useMemo(
    () => ({
      width: hueWidth,
      height: svSize,
      backgroundImage: VISUAL_COLOR_PICKER_HUE_GRADIENT,
      position: 'relative',
      cursor: isDraggingHue ? 'grabbing' : 'crosshair',
      imageRendering: 'pixelated',
    }),
    [hueWidth, isDraggingHue, svSize],
  );

  const svMarkerStyle: CSSProperties = useMemo(
    () => ({
      position: 'absolute',
      left: `${(hsv.s / 100) * svSize - markerR}px`,
      top: `${(1 - hsv.v / 100) * svSize - markerR}px`,
      width: markerR * 2,
      height: markerR * 2,
      borderRadius: '50%',
      border: VISUAL_COLOR_PICKER_MARKER_BORDER,
      boxShadow: VISUAL_COLOR_PICKER_MARKER_SHADOW,
      pointerEvents: 'none',
      backgroundColor: hsvToHex(hsv),
    }),
    [hsv, markerR, svSize],
  );

  const hueMarkerStyle: CSSProperties = useMemo(
    () => ({
      position: 'absolute',
      left: -2,
      top: `${(hsv.h / 360) * svSize - markerR}px`,
      width: hueWidth + 4,
      height: markerR * 2,
      border: VISUAL_COLOR_PICKER_MARKER_BORDER,
      boxShadow: VISUAL_COLOR_PICKER_MARKER_SHADOW,
      pointerEvents: 'none',
      boxSizing: 'border-box',
    }),
    [hsv.h, hueWidth, markerR, svSize],
  );

  return (
    <div
      className="flex flex-col gap-4 py-4 px-6 bg-bg-dark border-2 border-border rounded-none"
      style={{ width: totalWidth }}
    >
      {label && <span className="text-xs text-text-muted">{label}</span>}
      <div className="flex flex-row gap-8 items-start">
        <div ref={svRef} style={svBackground} onMouseDown={onSVMouseDown}>
          <div style={svMarkerStyle} />
        </div>
        <div ref={hueRef} style={hueBackground} onMouseDown={onHueMouseDown}>
          <div style={hueMarkerStyle} />
        </div>
      </div>
      <div className="flex flex-row gap-8 text-xs text-text-muted">
        <span>H: {Math.round(hsv.h)}°</span>
        <span>S: {Math.round(hsv.s)}</span>
        <span>V: {Math.round(hsv.v)}</span>
      </div>
    </div>
  );
}
