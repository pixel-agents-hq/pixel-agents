/**
 * Drawing for the fun phase: crowns on team leads, the week wall's calendar,
 * weather in the windows, the ping-pong ball and paddles, the radio's music
 * notes (all z-sorted with the scene), plus the 19:00 banner and dim pulse
 * (a screen overlay). Reads the live office's FunDirector (getActiveFun).
 */

import { CHARACTER_SITTING_OFFSET_PX, CHARACTER_Z_SORT_OFFSET } from '../constants.js';
import { metricsOf } from '../office/agentLook.js';
import { getCharacterSprite } from '../office/engine/characters.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import { characterSpritesFor } from '../office/sprites/agentSprites.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import type { Character, SpriteData } from '../office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../office/types.js';
import { isE2E } from '../runtime.js';
import { setFunAudio } from './funAudio.js';
import {
  BANNER_BG,
  BANNER_BORDER_COLOR,
  BANNER_FADE_SEC,
  BANNER_TEXT_COLOR,
  CALENDAR_CELL,
  CALENDAR_HEADER,
  CALENDAR_PR_COLOR,
  CALENDAR_PR_STRONG_COLOR,
  CALENDAR_TEXT_COLOR,
  CALENDAR_TODAY_COLOR,
  CHARACTER_FRAME_H,
  CHARACTER_FRAME_W,
  CROWN_ANCHOR_X,
  CROWN_ANCHOR_Y,
  CROWN_HEAD_TOP_Y,
  CROWN_SINK_PX,
  DIM_PULSE_COLOR,
  DIM_PULSE_MAX_ALPHA,
  DIM_PULSE_SEC,
  EVENING_BANNER_SEC,
  FUN_TYPE,
  PING_PONG_BALL_COLOR,
  PING_PONG_HANDLE_COLOR,
  PING_PONG_HIT_SEC,
  PING_PONG_PADDLE_COLOR,
  RADIO_NOTE_LIFETIME_SEC,
  RADIO_NOTE_RISE_PX_PER_SEC,
  WEATHER_CLOUD_COLOR,
  WEATHER_FLASH_COLOR,
  WEATHER_FOG_COLOR,
  WEATHER_RAIN_COLOR,
  WEATHER_SNOW_COLOR,
  WINDOW_PANES,
} from './funConstants.js';
import type { FunDirector } from './funDirector.js';
import { getActiveFun } from './funDirector.js';
import { calendarCells, monthLabel, weatherVisual } from './funRules.js';
import { browserFunAudio } from './lofiRadio.js';

// Only the browser bundle draws, so the browser's audio (the radio) plugs in here.
setFunAudio(browserFunAudio());

// e2e / visual checks drive the director directly (gated like the other test hooks).
if (isE2E) {
  (window as unknown as { __pixelAgentsFun?: () => FunDirector | null }).__pixelAgentsFun =
    getActiveFun;
}

export interface FunDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** Fill one sprite pixel (world px) at the current zoom. */
function px(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  zoom: number,
  x: number,
  y: number,
  w = 1,
  h = 1,
): void {
  c.fillRect(
    Math.round(ox + x * zoom),
    Math.round(oy + y * zoom),
    Math.ceil(w * zoom),
    Math.ceil(h * zoom),
  );
}

/** The z-sorted extras for this frame. */
export function funSceneDrawables(offsetX: number, offsetY: number, zoom: number): FunDrawable[] {
  const fun = getActiveFun();
  if (!fun) return [];
  const out: FunDrawable[] = [];
  crowns(fun, offsetX, offsetY, zoom, out);
  calendars(fun, offsetX, offsetY, zoom, out);
  windows(fun, offsetX, offsetY, zoom, out);
  pingPong(fun, offsetX, offsetY, zoom, out);
  notes(fun, offsetX, offsetY, zoom, out);
  return out;
}

// ── Crowns ─────────────────────────────────────────────────────

function crowns(fun: FunDirector, ox: number, oy: number, zoom: number, out: FunDrawable[]): void {
  const sprite = getCatalogEntry(FUN_TYPE.CROWN)?.sprite;
  if (!sprite) return;
  const cached = getCachedSprite(sprite, zoom);
  for (const ch of fun.characters()) {
    if (!ch.isTeamLead || ch.matrixEffect) continue;
    // The frame the renderer draws (a lead Clawd wears no accessory, so the
    // crown sits on its body's top row the way it sits on a chibi's hair).
    const frame = getCharacterSprite(ch, characterSpritesFor(ch));
    const frameW = frame[0]?.length ?? CHARACTER_FRAME_W;
    const frameH = frame.length || CHARACTER_FRAME_H;
    const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    // The frame is drawn bottom-centre at (x, y + sit), as the renderer does; the
    // crown's (8, 8) sits on the head's first row of pixels (the hair).
    const frameX = Math.round(ox + ch.x * zoom - (frameW * zoom) / 2);
    const frameY = Math.round(oy + (ch.y + sit) * zoom - frameH * zoom);
    const x = frameX + (frameW / 2 - CROWN_ANCHOR_X) * zoom;
    const y = frameY + (headTop(frame) + CROWN_SINK_PX - CROWN_ANCHOR_Y) * zoom;
    const alpha = ch.isSleeping ? 0.6 : 1;
    out.push({
      zY: ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET + 0.05,
      draw: (c) => {
        c.save();
        c.globalAlpha = alpha;
        c.drawImage(cached, x, y);
        c.restore();
      },
    });
  }
}

const headTops = new WeakMap<SpriteData, number>();

/** The first row of a character frame with any pixel in it (the top of the hair). */
function headTop(frame: SpriteData): number {
  let top = headTops.get(frame);
  if (top === undefined) {
    top = frame.findIndex((row) => row.some((px) => px !== ''));
    if (top < 0) top = CROWN_HEAD_TOP_Y;
    headTops.set(frame, top);
  }
  return top;
}

// ── Week wall ──────────────────────────────────────────────────

/** 3x5 glyphs for the month names. */
const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['#.#', '###', '###', '###', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
};

function drawText(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  zoom: number,
  text: string,
  x: number,
  y: number,
): void {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (let r = 0; r < g.length; r++) {
        for (let k = 0; k < g[r].length; k++)
          if (g[r][k] === '#') px(c, ox, oy, zoom, cx + k, y + r);
      }
    }
    cx += 4;
  }
}

function calendars(
  fun: FunDirector,
  ox: number,
  oy: number,
  zoom: number,
  out: FunDrawable[],
): void {
  const items = fun.itemsWhere((t) => t === FUN_TYPE.WALL_CALENDAR);
  if (items.length === 0) return;
  const now = fun.nowDate();
  const label = monthLabel(now);
  const cells = calendarCells(fun.week, now);
  for (const item of items) {
    const h = getCatalogEntry(item.type)?.sprite.length ?? 32;
    const bx = ox + item.col * TILE_SIZE * zoom;
    const by = oy + item.row * TILE_SIZE * zoom;
    out.push({
      zY: item.row * TILE_SIZE + h + 0.1,
      draw: (c) => {
        // Month in the red header, centred.
        c.fillStyle = CALENDAR_TEXT_COLOR;
        const width = label.length * 4 - 1;
        const hx =
          CALENDAR_HEADER.x0 +
          Math.floor((CALENDAR_HEADER.x1 - CALENDAR_HEADER.x0 + 1 - width) / 2);
        const hy =
          CALENDAR_HEADER.y0 + Math.floor((CALENDAR_HEADER.y1 - CALENDAR_HEADER.y0 + 1 - 5) / 2);
        drawText(c, bx, by, zoom, label, hx, hy);
        for (const cell of cells) {
          const x = CALENDAR_CELL.x0 + CALENDAR_CELL.dx * cell.col;
          const y = CALENDAR_CELL.y0 + CALENDAR_CELL.dy * cell.row;
          if (cell.prs > 0) {
            c.fillStyle = cell.streak ? CALENDAR_PR_STRONG_COLOR : CALENDAR_PR_COLOR;
            px(c, bx, by, zoom, x, y, CALENDAR_CELL.w, CALENDAR_CELL.h);
          }
          if (cell.today) {
            // Today: a gold dot (on top of the green when it has PRs too).
            c.fillStyle = CALENDAR_TODAY_COLOR;
            px(c, bx, by, zoom, x + CALENDAR_CELL.w - 1, y, 1, 1);
            if (cell.prs === 0) px(c, bx, by, zoom, x, y + CALENDAR_CELL.h - 1, CALENDAR_CELL.w, 1);
          }
        }
      },
    });
  }
}

// ── Weather in the windows ─────────────────────────────────────

function windows(fun: FunDirector, ox: number, oy: number, zoom: number, out: FunDrawable[]): void {
  const weather = fun.weather;
  if (!weather) return;
  const v = weatherVisual(weather.condition, weather.isDay);
  if (!v.particles && v.cloudAlpha === 0 && v.fogAlpha === 0 && !v.lightning) return;
  const t = fun.time;
  const items = fun.itemsWhere((type) => type.startsWith(FUN_TYPE.WINDOW_PREFIX));
  items.forEach((item, wi) => {
    const h = getCatalogEntry(item.type)?.sprite.length ?? 32;
    const bx = ox + item.col * TILE_SIZE * zoom;
    const by = oy + item.row * TILE_SIZE * zoom;
    const flash = v.lightning && (t + wi * 0.05) % 7.3 < 0.12;
    out.push({
      zY: item.row * TILE_SIZE + h + 0.1,
      draw: (c) => {
        c.save();
        WINDOW_PANES.forEach((pane, pi) => {
          if (v.cloudAlpha > 0) {
            c.globalAlpha = v.cloudAlpha;
            c.fillStyle = WEATHER_CLOUD_COLOR;
            px(c, bx, by, zoom, pane.x, pane.y, pane.w, pane.h);
          }
          if (v.fogAlpha > 0) {
            c.globalAlpha = v.fogAlpha;
            c.fillStyle = WEATHER_FOG_COLOR;
            px(c, bx, by, zoom, pane.x, pane.y, pane.w, pane.h);
          }
          if (v.particles) {
            c.globalAlpha = v.particles === 'snow' ? 0.95 : 0.8;
            c.fillStyle = v.particles === 'snow' ? WEATHER_SNOW_COLOR : WEATHER_RAIN_COLOR;
            const speed = v.particles === 'snow' ? 2.5 : 14;
            const len = v.particles === 'snow' ? 1 : 2;
            for (let i = 0; i < v.count; i++) {
              const seed = (wi * 31 + pi * 17 + i * 7) % 97;
              const fall = (t * speed + (seed * pane.h) / 13) % (pane.h + len);
              const sway = v.particles === 'snow' ? Math.round(Math.sin(t * 1.3 + seed) * 1) : 0;
              const x = pane.x + ((((seed * 5 + i * 3 + sway) % pane.w) + pane.w) % pane.w);
              const y0 = pane.y + Math.floor(fall) - len;
              const top = Math.max(pane.y, y0);
              const bottom = Math.min(pane.y + pane.h, y0 + len);
              if (bottom > top) px(c, bx, by, zoom, x, top, 1, bottom - top);
            }
          }
          if (flash) {
            c.globalAlpha = 0.75;
            c.fillStyle = WEATHER_FLASH_COLOR;
            px(c, bx, by, zoom, pane.x, pane.y, pane.w, pane.h);
          }
        });
        c.restore();
      },
    });
  });
}

// ── Ping-pong ──────────────────────────────────────────────────

/** The hand a player holds its paddle in, as a world-px point (per look: a
 *  Clawd's hand is lower and a px further out than a chibi's). */
function handOf(ch: Character): { x: number; y: number } {
  const m = metricsOf(ch);
  const side =
    ch.dir === Direction.RIGHT ? m.reachSide : ch.dir === Direction.LEFT ? -m.reachSide : 0;
  return { x: ch.x + side, y: ch.y - m.handRise };
}

function pingPong(
  fun: FunDirector,
  ox: number,
  oy: number,
  zoom: number,
  out: FunDrawable[],
): void {
  const rally = fun.rallyView();
  if (!rally) return;
  const ha = handOf(rally.a);
  const hb = handOf(rally.b);
  const hit = Math.floor(rally.t / PING_PONG_HIT_SEC);
  const f = (rally.t % PING_PONG_HIT_SEC) / PING_PONG_HIT_SEC;
  const [from, to] = hit % 2 === 0 ? [ha, hb] : [hb, ha];
  const tableTop = rally.table.row * TILE_SIZE + 8;
  const bx = from.x + (to.x - from.x) * f;
  // One bounce on the table mid-way: two arcs.
  const arc = f < 0.5 ? Math.sin(f * 2 * Math.PI) : Math.sin((f - 0.5) * 2 * Math.PI);
  const base = from.y + (tableTop - from.y) * Math.min(1, f * 2);
  const by = (f < 0.5 ? base : tableTop + (to.y - tableTop) * (f - 0.5) * 2) - Math.abs(arc) * 5;
  const tableZ = (rally.table.row + rally.table.h) * TILE_SIZE;
  out.push({
    zY: tableZ + 0.3,
    draw: (c) => {
      c.fillStyle = PING_PONG_BALL_COLOR;
      px(c, ox, oy, zoom, Math.round(bx), Math.round(by), 1, 1);
    },
  });
  for (const [ch, hand, swing] of [
    [rally.a, ha, hit % 2 === 0 ? f : 1 - f],
    [rally.b, hb, hit % 2 === 1 ? f : 1 - f],
  ] as const) {
    const lift = swing < 0.15 ? -1 : 0; // a flick on the hit
    out.push({
      zY: ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET + 0.06,
      draw: (c) => {
        c.fillStyle = PING_PONG_PADDLE_COLOR;
        px(c, ox, oy, zoom, Math.round(hand.x) - 1, Math.round(hand.y) - 1 + lift, 2, 2);
        c.fillStyle = PING_PONG_HANDLE_COLOR;
        const handleX = Math.round(hand.x) - 1 + (ch.dir === Direction.LEFT ? 1 : 0);
        px(c, ox, oy, zoom, handleX, Math.round(hand.y) + 1 + lift, 1, 1);
      },
    });
  }
}

// ── Radio notes ────────────────────────────────────────────────

const NOTE = ['..##', '..#.', '..#.', '###.', '##..'];

function notes(fun: FunDirector, ox: number, oy: number, zoom: number, out: FunDrawable[]): void {
  if (fun.notes.length === 0) return;
  const list = fun.notes.map((n) => ({ ...n }));
  out.push({
    zY: Number.MAX_SAFE_INTEGER,
    draw: (c) => {
      c.save();
      for (const n of list) {
        const life = n.age / RADIO_NOTE_LIFETIME_SEC;
        c.globalAlpha = Math.max(0, 1 - life) * 0.9;
        c.fillStyle = n.color;
        const x = Math.round(n.x + Math.sin(n.sway + n.age * 2.4) * 2);
        const y = Math.round(n.y - n.age * RADIO_NOTE_RISE_PX_PER_SEC) - NOTE.length;
        for (let r = 0; r < NOTE.length; r++) {
          for (let k = 0; k < NOTE[r].length; k++)
            if (NOTE[r][k] === '#') px(c, ox, oy, zoom, x + k, y + r);
        }
      }
      c.restore();
    },
  });
}

// ── Screen overlay: the 19:00 banner and dim pulse ─────────────

export function renderFunOverlay(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
): void {
  const fun = getActiveFun();
  const banner = fun?.banner;
  if (!fun || !banner) return;
  const t = fun.time - banner.startedAt;
  if (t < 0 || t > EVENING_BANNER_SEC) return;
  ctx.save();
  if (t < DIM_PULSE_SEC) {
    ctx.globalAlpha = Math.sin((Math.PI * t) / DIM_PULSE_SEC) * DIM_PULSE_MAX_ALPHA;
    ctx.fillStyle = DIM_PULSE_COLOR;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }
  const fade = Math.min(1, t / BANNER_FADE_SEC, (EVENING_BANNER_SEC - t) / BANNER_FADE_SEC);
  const size = Math.max(20, Math.round(zoom * 8));
  ctx.globalAlpha = Math.max(0, fade);
  ctx.font = `${size}px "FS Pixel Sans", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(banner.text).width + size * 2;
  const h = size * 2;
  const x = Math.round(canvasWidth / 2 - w / 2);
  const y = Math.round(size * 1.2);
  ctx.fillStyle = BANNER_BG;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = BANNER_BORDER_COLOR;
  ctx.lineWidth = Math.max(2, Math.round(zoom / 2));
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = BANNER_TEXT_COLOR;
  ctx.fillText(banner.text, canvasWidth / 2, y + h / 2 + 1);
  ctx.restore();
}
