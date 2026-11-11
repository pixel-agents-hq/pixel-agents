/**
 * The pixel editor: one frame of one worn piece, painted pixel by pixel. Edits are stored
 * uncoloured on the profile (they follow the piece's colour), per piece and frame.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Checkbox } from '../../components/ui/Checkbox.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import { PixelText } from '../../components/ui/PixelText.js';
import {
  CHARACTER_EDITOR_COLORS,
  CHARACTER_EDITOR_SCALE,
  CHARACTER_PAINT_FALLBACK,
} from '../../constants.js';
import { type BoxSize, useBoxSize } from '../../hooks/useBoxSize.js';
import { rgbHex } from '../color.js';
import { pieceName } from '../items.js';
import { clearFrameEdits, clearPieceEdits, hasEdits, paintPixel } from '../profiles.js';
import { cellAt, FRAME_COUNT, isOpaque } from '../sheet.js';
import { layerOf, wornPieces } from '../slots.js';
import { ArmedButton } from './ArmedButton.js';
import { ItemTools } from './ItemTools.js';
import {
  devicePixels,
  fitScale,
  FRAME_H,
  FRAME_NAMES,
  FRAME_W,
  FRAMES_PER_ROW,
  ROW_NAMES,
  sheetImage,
  sizeCanvas,
  type SpriteView,
} from './pixelCanvas.js';
import { type EditorTool, useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

/** The editor canvas's view: one frame (sized like any frame; drawn by hand below). */
const FRAME_VIEW: SpriteView = { kind: 'frame', facing: 'down', frame: 0 };

const TOOLS: { id: EditorTool; label: string; short: string; key: string; help: string }[] = [
  { id: 'pencil', label: 'Pencil', short: 'Pencil', key: 'B', help: 'Paint pixels of this piece.' },
  {
    id: 'eraser',
    label: 'Eraser',
    short: 'Eraser',
    key: 'E',
    help: 'Remove this piece’s pixels so whatever is underneath shows.',
  },
  {
    id: 'restore',
    label: 'Restore',
    short: 'Restore',
    key: 'R',
    help: 'Put pixels back to the generated piece.',
  },
  {
    id: 'picker',
    label: 'Pick colour',
    short: 'Pick',
    key: 'I',
    help: 'Click one of this piece’s pixels to paint with its colour.',
  },
];
/** Bresenham: every pixel from a to b. */
function line(a: [number, number], b: [number, number], fn: (x: number, y: number) => void) {
  let [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Sprite-pixel scale: as big as fits the editor body's box, beside the tool column when
 * the body doesn't wrap (phones) and above the frame nav. Desktop keeps it within
 * deskMin-deskMax; phones never go under phoneMinDevicePx device pixels.
 */
function useEditorScale(
  box: BoxSize | null,
  body: React.RefObject<HTMLDivElement | null>,
  phone: boolean,
  dpr: number,
): number {
  const [scale, setScale] = useState<number>(CHARACTER_EDITOR_SCALE.deskMax);
  useLayoutEffect(() => {
    const el = body.current;
    const wrap = el?.querySelector<HTMLElement>('.chv-ed-canvas-wrap');
    const nav = el?.querySelector<HTMLElement>('.chv-ed-nav');
    const tools = el?.querySelector<HTMLElement>('.chv-ed-tools');
    if (!box || !box.width || !el || !wrap || !nav || !tools) return;
    const bodyStyle = getComputedStyle(el);
    const beside =
      bodyStyle.flexWrap === 'nowrap'
        ? (parseFloat(getComputedStyle(tools).minWidth) || 0) +
          (parseFloat(bodyStyle.columnGap) || 0)
        : 0;
    const below = nav.offsetHeight + (parseFloat(getComputedStyle(wrap).rowGap) || 0);
    const fit = fitScale(FRAME_W, FRAME_H, box.width - beside, box.height - below, dpr);
    setScale(
      phone
        ? Math.max(CHARACTER_EDITOR_SCALE.phoneMinDevicePx / dpr, fit)
        : Math.max(CHARACTER_EDITOR_SCALE.deskMin, Math.min(CHARACTER_EDITOR_SCALE.deskMax, fit)),
    );
  }, [box, body, phone, dpr]);
  return scale;
}

export function PixelEditor() {
  const studio = useStudio();
  const {
    renderer,
    profile,
    editor,
    setEditor,
    stepFrame,
    closeEditor,
    dpr,
    phone,
    cast,
    undo,
    redo,
    status,
  } = studio;
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const [bodyBoxRef, bodyBox] = useBoxSize<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const stroke = useRef<{ pointer: number; last: [number, number] } | null>(null);
  const scale = useEditorScale(bodyBox, body, phone, dpr);
  const ed = editor!;

  const palette = renderer.piecePalette(profile, ed.pix);
  const color = ed.color ?? palette[Math.floor(palette.length / 2)] ?? CHARACTER_PAINT_FALLBACK;
  const shown = (hex: string) => renderer.shownColor(profile, ed.pix, hex);
  const row = Math.floor(ed.frame / FRAMES_PER_ROW);
  const pieceLabel = pieceName(renderer, profile, ed.pix);

  // the editor shows a worn piece; when it comes off, the editor closes
  const worn = wornPieces(renderer.wardrobe, profile);
  useEffect(() => {
    if (!worn.some((p) => p.pix === ed.pix)) closeEditor();
  });

  // Fade / Front draw the other pieces and this one as two sheets (built once per change)
  const layered = ed.fade || ed.front;
  const layers = useMemo(
    () =>
      layered
        ? {
            others: renderer.buildSheet(profile, { except: ed.pix }),
            piece: renderer.buildSheet(profile, {
              only: ed.pix,
              props: ed.front ? undefined : false,
            }),
          }
        : null,
    [renderer, profile, ed.pix, ed.front, layered],
  );

  // checkerboard, the frame and the grid
  const n = devicePixels(scale, dpr);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const devicePx = sizeCanvas(c, FRAME_VIEW, scale, dpr);
    if (overlay.current) sizeCanvas(overlay.current, FRAME_VIEW, scale, dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        ctx.fillStyle =
          (x + y) % 2 ? CHARACTER_EDITOR_COLORS.checkerLight : CHARACTER_EDITOR_COLORS.checkerDark;
        ctx.fillRect(x * devicePx, y * devicePx, devicePx, devicePx);
      }
    }
    const sx = (ed.frame % FRAMES_PER_ROW) * FRAME_W;
    const sy = row * FRAME_H;
    const draw = (sheet: Uint8ClampedArray, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        sheetImage(sheet),
        sx,
        sy,
        FRAME_W,
        FRAME_H,
        0,
        0,
        FRAME_W * devicePx,
        FRAME_H * devicePx,
      );
      ctx.globalAlpha = 1;
    };
    if (layers) {
      draw(layers.others, ed.fade ? 0.3 : 1);
      draw(layers.piece, 1);
    } else draw(renderer.sheet(profile), 1);
    ctx.strokeStyle = CHARACTER_EDITOR_COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 1; x < FRAME_W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * devicePx + 0.5, 0);
      ctx.lineTo(x * devicePx + 0.5, FRAME_H * devicePx);
      ctx.stroke();
    }
    for (let y = 1; y < FRAME_H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * devicePx + 0.5);
      ctx.lineTo(FRAME_W * devicePx, y * devicePx + 0.5);
      ctx.stroke();
    }
  }, [renderer, profile, layers, ed.pix, ed.frame, ed.fade, row, scale, dpr]);

  // the hovered pixel's box, on its own canvas so moving it doesn't repaint the frame
  useLayoutEffect(() => {
    const c = overlay.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!hover) return;
    ctx.strokeStyle = CHARACTER_EDITOR_COLORS.hover;
    ctx.lineWidth = 2;
    ctx.strokeRect(hover[0] * n + 1, hover[1] * n + 1, n - 2, n - 2);
  }, [hover, n]);

  const pixelAt = (e: React.PointerEvent): [number, number] | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * FRAME_W);
    const y = Math.floor(((e.clientY - r.top) / r.height) * FRAME_H);
    return x >= 0 && x < FRAME_W && y >= 0 && y < FRAME_H ? [x, y] : null;
  };
  const paint = (points: [number, number][]) => {
    const value = ed.tool === 'pencil' ? color : ed.tool === 'eraser' ? null : undefined;
    studio.edit((p) => {
      for (const [x, y] of points) paintPixel(p, ed.pix, ed.frame, y * FRAME_W + x, value);
    });
  };
  const pickColour = ([x, y]: [number, number]) => {
    const base = renderer.layerBase(profile, layerOf(ed.pix))?.data;
    const o = cellAt(ed.frame, y * FRAME_W + x);
    if (!base || !isOpaque(base[o + 3])) {
      status('That pixel isn’t part of this piece. Pick one of its own pixels.', 'err');
      return;
    }
    status('');
    setEditor({ color: rgbHex(base[o], base[o + 1], base[o + 2]), tool: 'pencil' });
  };

  const frameEdited = hasEdits(profile, ed.pix, ed.frame);
  const pieceEdited = hasEdits(profile, ed.pix);
  const tool = TOOLS.find((t) => t.id === ed.tool)!;

  return (
    <div className="chv-editor">
      <div className="chv-ed-head">
        <div>
          <h2>Edit {pieceLabel}</h2>
          <div className="chv-ed-frame">
            Frame <b>{FRAME_NAMES[ed.frame % FRAMES_PER_ROW]}</b> · facing <b>{ROW_NAMES[row]}</b>
          </div>
        </div>
        {phone ? (
          <ViewButton title="Back to the sheet" onClick={closeEditor}>
            <PixelIcon name="prev" />
            Sheet
          </ViewButton>
        ) : (
          <ViewButton primary onClick={closeEditor}>
            Done
          </ViewButton>
        )}
      </div>

      <div className="chv-chips" role="group" aria-label="Piece to edit">
        {worn.map((piece) => (
          <button
            key={piece.pix}
            type="button"
            className={hasEdits(profile, piece.pix) ? 'chv-chip chv-chip-edited' : 'chv-chip'}
            title={
              hasEdits(profile, piece.pix)
                ? `${pieceName(renderer, profile, piece.pix)} has edits`
                : undefined
            }
            aria-pressed={piece.pix === ed.pix}
            onClick={() => setEditor({ pix: piece.pix, color: null })}
          >
            {pieceName(renderer, profile, piece.pix)}
          </button>
        ))}
      </div>

      <div
        className="chv-ed-body"
        ref={(el) => {
          body.current = el;
          bodyBoxRef(el);
        }}
      >
        <div className="chv-ed-canvas-wrap">
          <div className="chv-ed-stack">
            <canvas ref={canvas} className="chv-ed-canvas" aria-hidden />
            <canvas
              ref={overlay}
              className="chv-ed-overlay"
              aria-label="Frame being edited"
              onPointerDown={(e) => {
                const p = pixelAt(e);
                if (!p) return;
                e.preventDefault();
                if (ed.tool === 'picker') return pickColour(p);
                e.currentTarget.setPointerCapture(e.pointerId);
                stroke.current = { pointer: e.pointerId, last: p };
                paint([p]);
              }}
              onPointerMove={(e) => {
                const p = pixelAt(e);
                setHover(p);
                const s = stroke.current;
                if (!s || e.pointerId !== s.pointer || !p) return;
                const points: [number, number][] = [];
                line(s.last, p, (x, y) => points.push([x, y]));
                s.last = p;
                paint(points);
              }}
              onPointerUp={(e) => {
                if (stroke.current?.pointer === e.pointerId) stroke.current = null;
              }}
              onPointerCancel={() => {
                stroke.current = null;
              }}
              onPointerLeave={() => setHover(null)}
            />
          </div>
          <div className="chv-ed-nav">
            <button type="button" className="chv-tool" onClick={() => stepFrame(-1)}>
              <PixelIcon name="prev" />
              <kbd>,</kbd>
            </button>
            <PixelText
              text={hover ? `x ${hover[0]} · y ${hover[1]}` : `${ed.frame + 1} / ${FRAME_COUNT}`}
            />
            <button type="button" className="chv-tool" onClick={() => stepFrame(1)}>
              <PixelIcon name="next" />
              <kbd>.</kbd>
            </button>
          </div>
        </div>

        <div className="chv-ed-tools">
          <div className="chv-toolrow" role="group" aria-label="Tool">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="chv-tool"
                aria-pressed={ed.tool === t.id}
                onClick={() => setEditor({ tool: t.id })}
              >
                {phone ? t.short : t.label}
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>
          <p className="chv-note">{tool.help}</p>

          <div className="chv-ed-current">
            <span className="chv-sw" style={{ background: shown(color) }} />
            <span>Painting with {shown(color)}</span>
            <label className="chv-custom">
              Custom
              <input
                type="color"
                value={color}
                onChange={(e) => setEditor({ color: e.target.value, tool: 'pencil' })}
              />
            </label>
          </div>
          <div className="chv-ed-palette" aria-label="This piece’s colours">
            {palette.map((hex) => (
              <button
                key={hex}
                type="button"
                className="chv-sw"
                style={{ background: shown(hex) }}
                title={shown(hex)}
                aria-label={`Paint with ${shown(hex)}`}
                aria-pressed={hex === color}
                onClick={() => setEditor({ color: hex, tool: 'pencil' })}
              />
            ))}
          </div>
          <p className="chv-note">
            These are the piece’s own colours. Everything you paint follows the piece’s colour
            sliders, so recolouring later still works.
          </p>

          <div className="chv-ed-opts">
            {(
              [
                ['fade', 'Fade other pieces'],
                ['front', 'Show this piece in front'],
              ] as const
            ).map(([key, label]) => (
              <Checkbox
                key={key}
                variant="inline"
                className="chv-check"
                boxClassName="chv-check-box"
                checked={ed[key]}
                onChange={() => setEditor({ [key]: !ed[key] })}
                label={label}
              />
            ))}
          </div>

          <div className="chv-toolrow">
            <button type="button" className="chv-tool" disabled={!cast.canUndo} onClick={undo}>
              <PixelIcon name="undo" />
              Undo<kbd>⌘Z</kbd>
            </button>
            <button type="button" className="chv-tool" disabled={!cast.canRedo} onClick={redo}>
              <PixelIcon name="redo" />
              Redo<kbd>⇧⌘Z</kbd>
            </button>
          </div>
          <div className="chv-toolrow">
            <ArmedButton
              className="chv-tool"
              label={phone ? 'Clear frame' : 'Clear this frame'}
              confirmLabel={phone ? 'Tap again' : 'Click again to confirm'}
              disabled={!frameEdited}
              onConfirm={() => studio.edit((p) => clearFrameEdits(p, ed.pix, ed.frame))}
            />
            <ArmedButton
              className="chv-tool"
              label={phone ? 'Clear piece' : 'Clear all edits to this piece'}
              confirmLabel={phone ? 'Tap again' : 'Click again to confirm'}
              disabled={!pieceEdited}
              onConfirm={() => studio.edit((p) => clearPieceEdits(p, ed.pix))}
            />
          </div>
          <p className="chv-note">
            Edits apply to this character only and to this one frame. Walking, typing and reading
            frames are separate, and the left-facing frames reuse the right-facing ones mirrored.
          </p>
          <ItemTools />
        </div>
      </div>
    </div>
  );
}
