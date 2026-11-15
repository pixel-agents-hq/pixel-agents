/**
 * The stage: the animated preview (one big figure and the four facings) over a floor,
 * and the 128x96 export sheet, whose frames open the pixel editor.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import {
  CHARACTER_ANIM_MS,
  CHARACTER_BLINK_FIRST_MS,
  CHARACTER_BLINK_GAP_MS,
  CHARACTER_BLINK_MS,
  CHARACTER_EDITOR_COLORS,
  CHARACTERS_PHONE_SCALES,
} from '../../constants.js';
import { useBoxSize } from '../../hooks/useBoxSize.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { SHEET_H, SHEET_W } from '../sheet.js';
import { canBlink, editsOf } from '../slots.js';
import {
  devicePixels,
  drawView,
  type Facing,
  FACINGS,
  fitScale,
  FRAME_H,
  FRAME_NAMES,
  FRAME_W,
  FRAMES_PER_ROW,
  ROW_NAMES,
  sizeCanvas,
  type SpriteView,
} from './pixelCanvas.js';
import { useStudio } from './studio.js';

type Anim = keyof typeof CHARACTER_ANIM_MS;
const ANIMS: readonly Anim[] = ['walk', 'type', 'read'];
const ANIM_FRAMES: Record<Anim, number[]> = { walk: [0, 1, 2, 1], type: [3, 4], read: [5, 6] };
/** A facing's (or sheet row's) name key. */
const facingKey = (f: string) => `characters.facing_${f}` as MessageKey;
/** A sheet column's frame name key. */
const frameKey = (f: string) => `characters.frame_${f}` as MessageKey;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The export sheet's edited-frame mark, in sprite pixels: its size and its inset from the corner. */
const EDIT_MARK = { size: 2, inset: 1 };

export interface StageScales {
  hero: number;
  turn: number;
  /** The export sheet's scale, or null to fit the box it is given (phones). */
  sheet: number | null;
}

function Segmented<T extends string>(props: {
  label: string;
  options: readonly T[];
  /** An option's shown name. */
  name: (option: T) => string;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="chv-seg" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={props.value === option}
          onClick={() => props.onChange(option)}
        >
          {props.name(option)}
        </button>
      ))}
    </div>
  );
}

/** The preview: hero and turn figures animate together, blinking now and then. */
function Preview({ anim, facing, scales }: { anim: Anim; facing: Facing; scales: StageScales }) {
  const { renderer, profile, dpr } = useStudio();
  const t = useT();
  const hero = useRef<HTMLCanvasElement>(null);
  const turns = useRef<(HTMLCanvasElement | null)[]>([]);
  const live = useRef({ profile, anim, facing });
  live.current = { profile, anim, facing };
  const redraw = useRef(true);

  useLayoutEffect(() => {
    const frameView: SpriteView = { kind: 'frame', facing: 'down', frame: 0 };
    if (hero.current) sizeCanvas(hero.current, frameView, scales.hero, dpr);
    for (const c of turns.current) if (c) sizeCanvas(c, frameView, scales.turn, dpr);
    redraw.current = true;
  }, [scales.hero, scales.turn, dpr]);

  useEffect(() => {
    redraw.current = true;
  }, [profile, anim, facing]);

  useEffect(() => {
    let raf = 0;
    let tick = 0;
    let last = 0;
    let nextBlink = CHARACTER_BLINK_FIRST_MS;
    let blinkUntil = 0;
    let wasShut = false;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const { profile: p, anim: a, facing: f } = live.current;
      if (t >= nextBlink) {
        blinkUntil = t + CHARACTER_BLINK_MS;
        const [gapMin, gapMax] = CHARACTER_BLINK_GAP_MS;
        nextBlink = t + gapMin + Math.random() * (gapMax - gapMin);
      }
      const shut = t < blinkUntil && canBlink(p, a === 'read');
      const due = t - last >= CHARACTER_ANIM_MS[a];
      if (!due && shut === wasShut && !redraw.current) return;
      if (due) {
        last = t;
        tick++;
      }
      wasShut = shut;
      redraw.current = false;
      const seq = ANIM_FRAMES[a];
      const frame = seq[tick % seq.length];
      const sheet = renderer.sheet(shut ? { ...p, blink: true } : p);
      if (hero.current) drawView(hero.current, sheet, { kind: 'frame', facing: f, frame });
      FACINGS.forEach((dir, i) => {
        const c = turns.current[i];
        if (c) drawView(c, sheet, { kind: 'frame', facing: dir, frame });
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);

  return (
    <div className="chv-floor">
      <figure className="chv-hero">
        <canvas ref={hero} aria-label={t('characters.animatedPreview')} />
      </figure>
      <div className="chv-turn">
        {FACINGS.map((dir, i) => (
          <figure key={dir}>
            <canvas
              ref={(el) => {
                turns.current[i] = el;
              }}
              aria-hidden
            />
            <figcaption>{t(facingKey(dir))}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The phone sheet's scale: as big as fits the box its wrapper is given, beside its labels. */
function useFittedSheetScale(
  box: { width: number; height: number } | null,
  grid: React.RefObject<HTMLDivElement | null>,
  dpr: number,
): number | null {
  const [scale, setScale] = useState<number | null>(null);
  useLayoutEffect(() => {
    const g = grid.current;
    if (!box || !box.width || !g) return;
    // the grid's label column, and its header and note rows (resolved by the grid itself)
    const style = getComputedStyle(g);
    const cols = style.gridTemplateColumns.split(' ').map(parseFloat);
    const rows = style.gridTemplateRows.split(' ').map(parseFloat);
    const rowLabel = cols[0] || 0;
    const colLabel = rows[0] || 0;
    const note = rows[rows.length - 1] || 0;
    const fit = fitScale(SHEET_W, SHEET_H, box.width - rowLabel, box.height - colLabel - note, dpr);
    setScale(Math.max(CHARACTERS_PHONE_SCALES.sheetMinDevicePx / dpr, fit));
    // re-measured at the new scale too: tiny cells wrap the frame names (taller header),
    // so the fit only grows until it settles
  }, [box, grid, dpr, scale]);
  return scale;
}

/** The export sheet: 8 frames x 3 facings. Clicking a frame edits it; while editing it marks frames. */
function ExportSheet({ fixedScale }: { fixedScale: number | null }) {
  const { renderer, profile, dpr, editor, openEditor, setEditor, phone } = useStudio();
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [wrapRef, wrapBox] = useBoxSize<HTMLDivElement>();
  const fitted = useFittedSheetScale(fixedScale === null ? wrapBox : null, grid, dpr);
  const scale = fixedScale ?? fitted ?? 1;
  // device pixels per sprite pixel, known at render so the grid's cells match the canvas
  const n = devicePixels(scale, dpr);

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const devicePx = sizeCanvas(c, { kind: 'sheet' }, scale, dpr);
    drawView(c, renderer.sheet(profile), { kind: 'sheet' });
    if (!editor) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = CHARACTER_EDITOR_COLORS.edited;
    // a mark in the top right corner of every frame this piece has edits in
    for (const ci of Object.keys(editsOf(profile, editor.pix)?.cells ?? {})) {
      const row = Math.floor(+ci / FRAMES_PER_ROW);
      const f = +ci % FRAMES_PER_ROW;
      ctx.fillRect(
        ((f + 1) * FRAME_W - EDIT_MARK.inset - EDIT_MARK.size) * devicePx,
        (row * FRAME_H + EDIT_MARK.inset) * devicePx,
        EDIT_MARK.size * devicePx,
        EDIT_MARK.size * devicePx,
      );
    }
    const row = Math.floor(editor.frame / FRAMES_PER_ROW);
    const f = editor.frame % FRAMES_PER_ROW;
    const lw = Math.max(2, devicePx / 2);
    ctx.strokeStyle = CHARACTER_EDITOR_COLORS.frame;
    ctx.lineWidth = lw;
    ctx.strokeRect(
      f * FRAME_W * devicePx + lw / 2,
      row * FRAME_H * devicePx + lw / 2,
      FRAME_W * devicePx - lw,
      FRAME_H * devicePx - lw,
    );
  }, [renderer, profile, editor, scale, dpr]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.floor(((e.clientX - r.left) / r.width) * FRAMES_PER_ROW);
    const row = Math.floor(((e.clientY - r.top) / r.height) * ROW_NAMES.length);
    if (f < 0 || f >= FRAMES_PER_ROW || row < 0 || row >= ROW_NAMES.length) return;
    const frame = row * FRAMES_PER_ROW + f;
    if (editor) setEditor({ frame });
    else openEditor(frame);
  };

  const cell = { w: (FRAME_W * n) / dpr, h: (FRAME_H * n) / dpr };
  return (
    <div className="chv-sheetbox">
      <h2>{t('characters.exportSheet', { w: SHEET_W, h: SHEET_H })}</h2>
      <div className="chv-sheet-wrap" ref={wrapRef}>
        <div
          ref={grid}
          className="chv-sheet"
          style={{ '--cell-w': `${cell.w}px`, '--cell-h': `${cell.h}px` } as React.CSSProperties}
        >
          <div />
          {FRAME_NAMES.map((name) => (
            <div key={name} className="chv-sheet-col">
              {t(frameKey(name))}
            </div>
          ))}
          <div className="chv-sheet-row">{t(facingKey(ROW_NAMES[0]))}</div>
          <canvas
            ref={canvas}
            onClick={onClick}
            aria-label={t('characters.sheetAria')}
            title={t('characters.sheetTitle')}
          />
          {ROW_NAMES.slice(1).map((name) => (
            <div key={name} className="chv-sheet-row">
              {t(facingKey(name))}
            </div>
          ))}
          <div className="chv-sheet-note">
            {phone ? t('characters.sheetNoteTap') : t('characters.sheetNoteClick')}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The preview column; on phones its pinned bar and floor sit above the wardrobe. */
export function Stage({ scales, ref }: { scales: StageScales; ref?: React.Ref<HTMLElement> }) {
  const { phone, close } = useStudio();
  const t = useT();
  const [anim, setAnim] = useState<Anim>('walk');
  const [facing, setFacing] = useState<Facing>('down');
  return (
    <section ref={ref} className="chv-box chv-stage" aria-label={t('characters.preview')}>
      <div className="chv-pin">
        <div className="chv-stage-top">
          <Segmented
            label={t('characters.animation')}
            options={ANIMS}
            name={(a) => t(`characters.anim_${a}`)}
            value={anim}
            onChange={setAnim}
          />
          <Segmented
            label={t('characters.facing')}
            options={FACINGS}
            name={(f) => capitalize(t(facingKey(f)))}
            value={facing}
            onChange={setFacing}
          />
          {phone && (
            <Button
              variant="ghost"
              size="icon"
              className="chv-close"
              aria-label={t('characters.closeView')}
              onClick={close}
            >
              <PixelIcon name="close" />
            </Button>
          )}
        </div>
        <Preview anim={anim} facing={facing} scales={scales} />
      </div>
      <ExportSheet fixedScale={scales.sheet} />
    </section>
  );
}
