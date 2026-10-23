/**
 * The fun phase's runtime (docs/office/DESIGN.md, phases E and F): festival
 * decorations, the 10:00 standup and 19:00 banner, whiteboard / library /
 * crowns, the week wall and growing plants, weather in the windows, the lo-fi
 * radio, smart pets, the fish tank, the printer, pizza and ping-pong — and
 * the limit break (limitBreak.ts): agents the session limit cut off pass the
 * time in the Lounge until it resets.
 *
 * OfficeState owns one and calls it at a few seams:
 *  - onMessage(msg)      every server message (useExtensionMessages)
 *  - update(dt)          once a frame; true = furniture frames changed
 *  - targetFor(ch)       a ritual / pastime borrowing the character (routeCharacter)
 *  - decorate(furniture) runtime-only items and type swaps (rebuildFurnitureInstances)
 *  - drivePet(pet, dt)   the smart pets (the pet loop)
 *  - handleTap(x, y)     a click on the radio (OfficeCanvas)
 * Everything it adds is runtime-only: nothing reaches the saved layout.
 */

import type { DailyStats, Weather, WeekDay } from '../../../core/src/messages.js';
import { isSettledAtZoneTarget } from '../office/engine/characters.js';
import { faceToward } from '../office/engine/npcs.js';
import { isSmoking } from '../office/engine/zoneEffects.js';
import {
  getAnimationFrames,
  getCatalogEntry,
  getOnStateType,
} from '../office/layout/furnitureCatalog.js';
import { isWalkable } from '../office/layout/tileMap.js';
import type {
  Character,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
  ZoneTarget,
} from '../office/types.js';
import { Direction, TILE_SIZE, TileType } from '../office/types.js';
import type { OfficeZones, ZonePlace } from '../office/zones.js';
import { spotKey, toZoneLabel, ZoneLabel } from '../office/zones.js';
import type { DecorInput, DecorPlacement, Festival } from './festivals.js';
import { festivalDecorations, festivalOn, freeSurfaceTiles, localDateKey } from './festivals.js';
import { getFunAudio } from './funAudio.js';
import {
  BREAK_ACTIVITY_MAX_SEC,
  BREAK_ACTIVITY_MIN_SEC,
  BREAK_CHAT_MAX_SEC,
  BREAK_CHAT_MIN_SEC,
  BREAK_LINE_SEC,
  BREAK_STAND_RADIUS_TILES,
  BUSY_WINDOW_MS,
  CLAUDIO_CELEBRATE_SEC,
  CLAUDIO_GREET_SEC,
  EVENING_BANNER_HOUR,
  EVENING_BANNER_MINUTE,
  EVENING_BANNER_SEC,
  FESTIVAL_FLICKER_FRAME_SEC,
  FESTIVAL_RECHECK_SEC,
  FUN_TYPE,
  GITCAT_FOLLOW_CHANCE,
  GITCAT_FOLLOW_COOLDOWN_SEC,
  GITCAT_FOLLOW_MAX_SEC,
  LIBRARY_LINGER_SEC,
  PASTIME_CHECK_SEC,
  PING_PONG_CHANCE,
  PING_PONG_COOLDOWN_SEC,
  PING_PONG_MAX_SEC,
  PING_PONG_MIN_SEC,
  PIZZA_MAX_TABLES,
  PIZZA_PRS,
  PIZZA_VISIT_CHANCE,
  PIZZA_VISIT_COOLDOWN_SEC,
  PIZZA_VISIT_SEC,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  PRINT_SEC,
  PRINTER_FRAME_SEC,
  RADIO_NOTE_COLORS,
  RADIO_NOTE_INTERVAL_SEC,
  RADIO_NOTE_LIFETIME_SEC,
  SHIP_ATTRIBUTION_MS,
  STANDUP_HOUR,
  STANDUP_MAX_SEC,
  STANDUP_MINUTE,
  STANDUP_SEATED_SEC,
  WEB_TOOLS,
} from './funConstants.js';
import type { ClaudioGoal, GitcatGoal, RallyCandidate } from './funRules.js';
import {
  busiestAgent,
  claudioGoal,
  eveningBannerText,
  fishFrameInterval,
  gitcatGoal,
  isShipStatus,
  mayFollowSmoker,
  pickRallyPair,
  plantStage,
  printsDocument,
  rallyEligible,
  ritualDue,
  weekPrCount,
} from './funRules.js';
import type { BreakActivity, BreakSpeaker } from './limitBreak.js';
import { breakLine, breakSignText, isBreakReason, pickBreakActivity } from './limitBreak.js';
import type { PetWorld } from './smartPets.js';
import { petRole, SmartPets } from './smartPets.js';

/** What the director reads from the office (OfficeState implements it). */
export interface FunHost {
  getLayout(): OfficeLayout;
  characters: Map<number, Character>;
  pets: Pet[];
  seats: Map<string, Seat>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  zones: OfficeZones;
  nowMs: () => number;
  zoneRandom: () => number;
  /** Can the character walk to that place from where it stands? */
  canReach(ch: Character, target: { col: number; row: number; sit: boolean }): boolean;
  /** The NPCs sitting with the limit break right now (they chat too). */
  breakGuests?(): BreakGuest[];
}

export type BorrowKind = 'standup' | 'whiteboard' | 'library' | 'pizza' | 'pingpong' | 'limitBreak';

/** An NPC sitting with the limit break. */
export type BreakGuest = 'ansh' | 'manager';

/** A line said on the limit break (director clock). */
export interface BreakLineShowing {
  who: BreakSpeaker;
  text: string;
  until: number;
}

/** A character a ritual or pastime has borrowed from the destination engine. */
export interface Borrow {
  kind: BorrowKind;
  target: ZoneTarget;
  /** The engine has pointed the character at it (lost again = give up). */
  issued: boolean;
  /** Seconds settled at the target. */
  settledFor: number;
  startedAt: number;
  /** Give up (director-clock seconds) — e.g. a standup that can't seat everyone. */
  until: number;
  /** Whiteboard: the board's uid (it shows a drawing while someone stands there). */
  itemUid?: string;
  /** Limit break: what it is doing, and for how long once there (seconds settled). */
  activity?: BreakActivity;
  staySec?: number;
}

interface PlacedItem {
  uid: string;
  type: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

/** What the renderer draws for the fun phase (read by funRender.ts). */
export interface FunRallyView {
  a: Character;
  b: Character;
  /** Seconds since both players settled. */
  t: number;
  table: PlacedItem;
}

export interface RadioNote {
  x: number;
  y: number;
  age: number;
  color: string;
  sway: number;
}

const ASK_USER_TOOL = 'AskUserQuestion';

export class FunDirector {
  /** Director clock (seconds of game time). */
  private clock = 0;
  readonly borrows = new Map<number, Borrow>();

  // ── From messages ──
  private readonly liveTools = new Map<number, Map<string, string | null>>();
  private readonly permission = new Set<number>();
  private readonly planning = new Set<number>();
  private readonly lastWebToolAt = new Map<number, number>();
  private readonly toolStarts = new Map<number, number[]>();
  private readonly lastShipAt = new Map<number, number>();
  private daily: DailyStats | null = null;
  week: WeekDay[] = [];
  weather: Weather | null = null;
  private printUntil = -1;

  // ── Rituals ──
  private standupRan: string | undefined;
  private bannerRan: string | undefined;
  /** The 19:00 banner on screen: its text and when it went up (director clock). */
  banner: { text: string; startedAt: number } | null = null;

  // ── Layout scan + festival ──
  private scanned: OfficeLayout | null = null;
  private items: PlacedItem[] = [];
  private festival: Festival | null = null;
  private decorLayout: OfficeLayout | null = null;
  /** Force a festival (demos / visual checks); undefined = by date. */
  festivalOverride: Festival | null | undefined = undefined;
  private festivalCheckAt = -Infinity;
  private decor: PlacedFurniture[] = [];
  private pizzaDecor: PlacedFurniture[] = [];
  private pizzaKey = '';
  private pizzaTables: PlacedItem[] = [];

  // ── Pastimes ──
  private pastimeCheckAt = 0;
  private quickCheckAt = 0;
  private readonly lastPizzaVisit = new Map<number, number>();
  private lastRallyAt: number | null = null;
  private rally: {
    a: number;
    b: number;
    table: PlacedItem;
    endsAt: number;
    since: number | null;
  } | null = null;

  // ── Limit break ──
  /** Agents a session-type usage limit paused, with when it resets (epoch ms). */
  private readonly limited = new Map<number, number | undefined>();
  private readonly lastBreakActivity = new Map<number, BreakActivity>();
  /** No place for it right now: try again from this director-clock time. */
  private readonly breakRetryAt = new Map<number, number>();
  /** On the break with a cup in hand (a coffee). */
  private readonly breakCups = new Set<number>();
  /** Lounge seats the NPCs hold on the break (no agent is given one). */
  private readonly guestSeats = new Map<BreakGuest, ZoneTarget>();
  /** The break was on at the last update (the pizza goes up / comes down on a change). */
  private breakWasOn = false;
  private breakChatAt = 0;
  private lastBreakSpeaker: BreakSpeaker | null = null;
  /** What is being said on the break. */
  breakLines: BreakLineShowing[] = [];
  private breakPizzaDecor: PlacedFurniture[] = [];
  private breakPizzaTables: PlacedItem[] = [];

  // ── Pets ──
  private readonly pets = new SmartPets();
  private follow: { agentId: number; until: number } | null = null;
  private lastFollowAt: number | null = null;
  private readonly smokersSeen = new Set<number>();
  private greet: { agentId: number; until: number; hearted: boolean } | null = null;
  private celebrate: { agentId: number; until: number; hearted: boolean } | null = null;

  // ── Radio ──
  /** The viewer's toggle (remembered in localStorage by the browser audio, funAudio.ts). */
  radioOn = false;
  private radioLoaded = false;
  readonly notes: RadioNote[] = [];
  private noteIn = 0;

  // ── Frames ──
  private fishPhase = 0;
  private frameKey = '';
  private dirty = true;

  private readonly host: FunHost;

  constructor(host: FunHost) {
    this.host = host;
  }

  // ════════════════════════════════════════════════════════════
  // Messages
  // ════════════════════════════════════════════════════════════

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage(msg: any): void {
    if (!msg || typeof msg.type !== 'string') return;
    const id = typeof msg.id === 'number' ? (msg.id as number) : -1;
    switch (msg.type) {
      case 'agentToolStart': {
        const status = typeof msg.status === 'string' ? msg.status : '';
        const name: string | null =
          typeof msg.toolName === 'string' && msg.toolName ? msg.toolName : toolNameOf(status);
        let tools = this.liveTools.get(id);
        if (!tools) this.liveTools.set(id, (tools = new Map()));
        tools.set(String(msg.toolId), name);
        const now = this.host.nowMs();
        const starts = this.toolStarts.get(id) ?? [];
        starts.push(now);
        this.toolStarts.set(id, starts);
        if (msg.permissionActive === true) this.permission.add(id);
        if (name === PLAN_ENTER_TOOL) this.planning.add(id);
        if (name === PLAN_EXIT_TOOL) this.planning.delete(id);
        if (name !== null && WEB_TOOLS.includes(name)) this.lastWebToolAt.set(id, this.clock);
        if (isShipStatus(status)) this.lastShipAt.set(id, now);
        if (printsDocument(name, status)) {
          this.printUntil = this.clock + PRINT_SEC;
          this.dirty = true;
        }
        break;
      }
      case 'agentToolDone': {
        const tools = this.liveTools.get(id);
        const name = tools?.get(String(msg.toolId));
        if (name !== undefined && name !== null && WEB_TOOLS.includes(name)) {
          this.lastWebToolAt.set(id, this.clock);
        }
        tools?.delete(String(msg.toolId));
        break;
      }
      case 'agentToolsClear':
        this.noteWebToolsEnded(id);
        this.liveTools.delete(id);
        this.permission.delete(id);
        break;
      case 'agentToolPermission':
        this.permission.add(id);
        break;
      case 'agentToolPermissionClear':
        this.permission.delete(id);
        break;
      case 'agentCreated':
        if (msg.background !== true && msg.isTeammate !== true) {
          this.greet = {
            agentId: id,
            until: this.host.nowMs() + CLAUDIO_GREET_SEC * 1000,
            hearted: false,
          };
        }
        break;
      case 'agentClosed':
        this.forgetAgent(id);
        break;
      case 'agentLimit':
        if (msg.paused === true && isBreakReason(msg.reason)) {
          this.limited.set(id, typeof msg.resetsAt === 'number' ? msg.resetsAt : undefined);
        } else {
          this.limited.delete(id);
        }
        break;
      case 'dailyStats':
        this.onDailyStats(msg as DailyStats);
        break;
      case 'weekStats':
        if (Array.isArray(msg.days)) {
          this.week = (msg.days as WeekDay[]).filter((d) => typeof d?.date === 'string');
          this.dirty = true;
        }
        break;
      case 'weather':
        this.weather = msg as Weather;
        break;
    }
  }

  private noteWebToolsEnded(id: number): void {
    const tools = this.liveTools.get(id);
    if (!tools) return;
    for (const name of tools.values()) {
      if (name !== null && WEB_TOOLS.includes(name)) this.lastWebToolAt.set(id, this.clock);
    }
  }

  private forgetAgent(id: number): void {
    this.liveTools.delete(id);
    this.permission.delete(id);
    this.planning.delete(id);
    this.lastWebToolAt.delete(id);
    this.toolStarts.delete(id);
    this.lastShipAt.delete(id);
    this.lastPizzaVisit.delete(id);
    this.smokersSeen.delete(id);
    this.limited.delete(id);
    this.lastBreakActivity.delete(id);
    this.breakRetryAt.delete(id);
    this.breakCups.delete(id);
    this.borrows.delete(id);
    if (this.rally && (this.rally.a === id || this.rally.b === id)) this.endRally();
  }

  /** A push or PR landed (today's totals went up): Claudio celebrates with whoever shipped. */
  private onDailyStats(stats: DailyStats): void {
    const prev = this.daily;
    this.daily = stats;
    this.dirty = true;
    if (!prev || prev.date !== stats.date) return;
    const pushes = (s: DailyStats) => s.pushes.reduce((n, p) => n + (p.count || 0), 0);
    if (stats.prs.length <= prev.prs.length && pushes(stats) <= pushes(prev)) return;
    const shipper = this.shipper();
    if (shipper !== null) {
      this.celebrate = {
        agentId: shipper,
        until: this.host.nowMs() + CLAUDIO_CELEBRATE_SEC * 1000,
        hearted: false,
      };
    }
  }

  /** Who shipped: the agent whose shell pushed / opened a PR most recently, else the latest busy one. */
  private shipper(): number | null {
    const now = this.host.nowMs();
    let best: number | null = null;
    let bestAt = -Infinity;
    for (const [id, at] of this.lastShipAt) {
      if (now - at <= SHIP_ATTRIBUTION_MS && at > bestAt && this.host.characters.has(id)) {
        best = id;
        bestAt = at;
      }
    }
    if (best !== null) return best;
    for (const [id, starts] of this.toolStarts) {
      const at = starts[starts.length - 1] ?? -Infinity;
      const ch = this.host.characters.get(id);
      if (ch && !ch.isSubagent && at > bestAt) {
        best = id;
        bestAt = at;
      }
    }
    return best;
  }

  // ════════════════════════════════════════════════════════════
  // Per frame
  // ════════════════════════════════════════════════════════════

  /** Advance everything; true when the furniture needs rebuilding (frames, decor). */
  update(dt: number): boolean {
    this.clock += dt;
    setActiveFun(this);
    const nowMs = this.host.nowMs();
    const now = new Date(nowMs);
    this.rescanIfNeeded();

    if (this.clock >= this.festivalCheckAt) {
      this.festivalCheckAt = this.clock + FESTIVAL_RECHECK_SEC;
      this.refreshDecor(now);
      this.pruneToolStarts(nowMs);
    }

    this.updateBorrows(dt);
    this.updateLimitBreak(nowMs);
    this.updateRituals(now);
    if (this.clock >= this.quickCheckAt) {
      this.quickCheckAt = this.clock + 0.5;
      this.startWorkSpots();
      this.watchSmokers();
    }
    if (this.clock >= this.pastimeCheckAt) {
      this.pastimeCheckAt = this.clock + PASTIME_CHECK_SEC;
      this.startPastimes(now);
    }
    this.updateRadio(dt);
    if (this.banner && this.clock - this.banner.startedAt > EVENING_BANNER_SEC) this.banner = null;

    const key = this.frames(dt);
    const changed = this.dirty || key !== this.frameKey;
    this.frameKey = key;
    this.dirty = false;
    return changed;
  }

  /** Seconds of the director clock (render timing). */
  get time(): number {
    return this.clock;
  }

  /** The office's wall-clock time. */
  nowDate(): Date {
    return new Date(this.host.nowMs());
  }

  private pruneToolStarts(nowMs: number): void {
    for (const [id, starts] of this.toolStarts) {
      const kept = starts.filter((t) => nowMs - t <= BUSY_WINDOW_MS);
      if (kept.length === 0) this.toolStarts.delete(id);
      else this.toolStarts.set(id, kept);
    }
  }

  // ── Layout scan ──

  private rescanIfNeeded(): void {
    const layout = this.host.getLayout();
    if (layout === this.scanned) return;
    this.scanned = layout;
    this.items = [];
    for (const f of layout.furniture) {
      const entry = getCatalogEntry(f.type);
      if (!entry) continue;
      this.items.push({
        uid: f.uid,
        type: f.type,
        col: f.col,
        row: f.row,
        w: entry.footprintW,
        h: entry.footprintH,
      });
    }
    this.festivalCheckAt = -Infinity; // re-place decorations on the new layout
    this.pizzaKey = '';
    // The break's pizza goes back on the new layout's tables (if the break is on).
    this.breakWasOn = false;
    this.breakPizzaDecor = [];
    this.breakPizzaTables = [];
    this.dirty = true;
  }

  /** Placed items whose type passes the test. */
  itemsWhere(test: (type: string) => boolean): PlacedItem[] {
    this.rescanIfNeeded();
    return this.items.filter((i) => test(i.type));
  }

  zoneAt(col: number, row: number): string | null {
    const layout = this.host.getLayout();
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
    return toZoneLabel(layout.areaTiles?.[row * layout.cols + col] ?? null);
  }

  private decorInput(): DecorInput {
    const layout = this.host.getLayout();
    return {
      cols: layout.cols,
      rows: layout.rows,
      isWall: (col, row) => this.host.tileMap[row]?.[col] === TileType.WALL,
      zoneAt: (col, row) => this.zoneAt(col, row),
      furniture: layout.furniture,
      entry: (type) => {
        const e = getCatalogEntry(type);
        return e
          ? {
              w: e.footprintW,
              h: e.footprintH,
              isDesk: e.isDesk,
              onWall: e.canPlaceOnWalls ?? false,
              onSurface: e.canPlaceOnSurfaces ?? false,
            }
          : undefined;
      },
    };
  }

  // ── Festival + pizza decorations ──

  private refreshDecor(now: Date): void {
    const festival = this.festivalOverride !== undefined ? this.festivalOverride : festivalOn(now);
    if (festival !== this.festival || this.decorLayout !== this.scanned) {
      this.festival = festival;
      this.decorLayout = this.scanned;
      this.decor = toPlaced(festivalDecorations(festival, this.decorInput()));
      this.dirty = true;
    }
    this.refreshPizza(now);
  }

  /** Pizza is on after PIZZA_PRS PRs today, until midnight (the date check). */
  pizzaOn(now = new Date(this.host.nowMs())): boolean {
    const d = this.daily;
    return d !== null && d.date === localDateKey(now) && d.prs.length >= PIZZA_PRS;
  }

  private refreshPizza(now: Date): void {
    const on = this.pizzaOn(now);
    const key = on ? `on:${this.daily?.date}` : 'off';
    if (key === this.pizzaKey) return;
    this.pizzaKey = key;
    this.pizzaDecor = [];
    this.pizzaTables = [];
    this.dirty = true;
    if (!on) return;
    const input = this.decorInput();
    const free = freeSurfaceTiles(input, [ZoneLabel.CAFE]);
    const tables = this.items
      .filter(
        (i) => getCatalogEntry(i.type)?.isDesk && this.zoneAt(i.col, i.row) === ZoneLabel.CAFE,
      )
      .sort((a, b) => a.row - b.row || a.col - b.col);
    for (const table of tables) {
      if (this.pizzaTables.length >= PIZZA_MAX_TABLES) break;
      const tiles = free.filter(
        (t) =>
          t.col >= table.col &&
          t.col < table.col + table.w &&
          t.row >= table.row &&
          t.row < table.row + table.h,
      );
      if (tiles.length === 0) continue;
      this.pizzaTables.push(table);
      const placed: DecorPlacement[] = [{ type: FUN_TYPE.PIZZA_BOX_OPEN, ...tiles[0] }];
      if (tiles.length > 1) placed.push({ type: FUN_TYPE.PIZZA_BOX, ...tiles[tiles.length - 1] });
      this.pizzaDecor.push(...toPlaced(placed));
    }
  }

  // ════════════════════════════════════════════════════════════
  // Furniture: decorations and type swaps
  // ════════════════════════════════════════════════════════════

  /** The furniture to draw: the layout's, with swaps applied and runtime items appended. */
  decorate(furniture: PlacedFurniture[]): PlacedFurniture[] {
    const drawing = this.boardsInUse();
    const stage =
      this.week.length > 0 ? plantStage(weekPrCount(this.week, new Date(this.host.nowMs()))) : 1;
    let out: PlacedFurniture[] | null = null;
    for (let i = 0; i < furniture.length; i++) {
      const item = furniture[i];
      const type = this.swapType(item, drawing, stage);
      if (type === item.type) continue;
      if (!out) out = furniture.slice();
      out[i] = { ...item, type };
    }
    const extra = this.animatedDecor();
    if (extra.length === 0) return out ?? furniture;
    return [...(out ?? furniture), ...extra];
  }

  private swapType(item: PlacedFurniture, drawing: Set<string>, stage: 1 | 2 | 3): string {
    const t = item.type;
    if (t === FUN_TYPE.WHITEBOARD && drawing.has(item.uid)) {
      return getCatalogEntry(FUN_TYPE.WHITEBOARD_DRAWN) ? FUN_TYPE.WHITEBOARD_DRAWN : t;
    }
    if (t.startsWith(FUN_TYPE.PLANT_STAGE_PREFIX)) {
      const want = `${FUN_TYPE.PLANT_STAGE_PREFIX}${stage}`;
      return getCatalogEntry(want) ? want : t;
    }
    if (t.startsWith(FUN_TYPE.FISH_TANK)) {
      return this.frameOf(t, Math.floor(this.fishPhase));
    }
    if (t.startsWith(FUN_TYPE.PRINTER) && this.clock < this.printUntil) {
      return this.frameOf(t, Math.floor(this.clock / PRINTER_FRAME_SEC));
    }
    return t;
  }

  /** The `index`-th "on" animation frame of an item's type (its own type when it has none). */
  private frameOf(type: string, index: number): string {
    const on = getOnStateType(type);
    const frames = getAnimationFrames(on) ?? getAnimationFrames(type);
    if (!frames || frames.length === 0) return on;
    return frames[((index % frames.length) + frames.length) % frames.length];
  }

  private animatedDecor(): PlacedFurniture[] {
    const pizza =
      this.breakPizzaDecor.length > 0
        ? [...this.pizzaDecor, ...this.breakPizzaDecor]
        : this.pizzaDecor;
    if (this.decor.length === 0) return pizza;
    const flicker = Math.floor(this.clock / FESTIVAL_FLICKER_FRAME_SEC);
    const lit = this.decor.map((d, i) => {
      const frames = getAnimationFrames(d.type);
      return frames && frames.length > 1
        ? { ...d, type: frames[(flicker + i) % frames.length] }
        : d;
    });
    return pizza.length > 0 ? [...lit, ...pizza] : lit;
  }

  /** Whiteboards someone stands drawing at. */
  private boardsInUse(): Set<string> {
    const out = new Set<string>();
    for (const [id, b] of this.borrows) {
      if (b.kind !== 'whiteboard' || !b.itemUid) continue;
      const ch = this.host.characters.get(id);
      if (ch && isSettledAtZoneTarget(ch) && ch.zoneTarget?.key === b.target.key)
        out.add(b.itemUid);
    }
    return out;
  }

  /** Animation frame indices (fish, printer, flicker, boards) — a change means rebuild. */
  private frames(dt: number): string {
    let active = 0;
    for (const ch of this.host.characters.values()) {
      if (!ch.isSubagent && ch.isActive && !ch.isSleeping) active++;
    }
    this.fishPhase += dt / fishFrameInterval(active);
    const printing = this.clock < this.printUntil ? Math.floor(this.clock / PRINTER_FRAME_SEC) : -1;
    const flicker =
      this.decor.length > 0 ? Math.floor(this.clock / FESTIVAL_FLICKER_FRAME_SEC) : -1;
    const boards = [...this.boardsInUse()].join(',');
    return `${Math.floor(this.fishPhase)}|${printing}|${flicker}|${boards}`;
  }

  // ════════════════════════════════════════════════════════════
  // Borrowing characters (rituals and pastimes)
  // ════════════════════════════════════════════════════════════

  /** Where a ritual / pastime wants this character, or null (the destination engine decides). */
  targetFor(ch: Character): ZoneTarget | null {
    const b = this.borrows.get(ch.id);
    if (!b) return null;
    if (ch.zoneTarget?.key === b.target.key && ch.zoneTarget.zone === b.target.zone) {
      b.issued = true;
    } else if (b.issued) {
      // It was there and lost it (unreachable, a layout rebuild): let it go.
      this.release(ch.id);
      return null;
    }
    return b.target;
  }

  private borrow(
    ch: Character,
    kind: BorrowKind,
    target: ZoneTarget,
    extra: Partial<Borrow> = {},
  ): void {
    this.borrows.set(ch.id, {
      kind,
      target,
      issued: false,
      settledFor: 0,
      startedAt: this.clock,
      until: this.clock + 600,
      ...extra,
    });
  }

  private release(id: number): void {
    const b = this.borrows.get(id);
    this.borrows.delete(id);
    if (b?.kind === 'pingpong') this.endRally();
  }

  private endRally(): void {
    const r = this.rally;
    this.rally = null;
    if (!r) return;
    for (const id of [r.a, r.b]) {
      if (this.borrows.get(id)?.kind === 'pingpong') this.borrows.delete(id);
    }
  }

  /** Not working, not asleep, not leaving, nothing waiting on the user. */
  private free(ch: Character): boolean {
    return (
      !ch.isActive &&
      !ch.isSleeping &&
      !ch.leaving &&
      !ch.matrixEffect &&
      !this.permission.has(ch.id) &&
      !this.askingUser(ch.id)
    );
  }

  private askingUser(id: number): boolean {
    for (const name of this.liveTools.get(id)?.values() ?? [])
      if (name === ASK_USER_TOOL) return true;
    return false;
  }

  private webToolLive(id: number): boolean {
    for (const name of this.liveTools.get(id)?.values() ?? []) {
      if (name !== null && WEB_TOOLS.includes(name)) return true;
    }
    return false;
  }

  /** Free and up for a pastime: top-level, not borrowed, not already in a meeting. */
  private idleAwake(ch: Character): boolean {
    return (
      !ch.isSubagent &&
      this.free(ch) &&
      !this.borrows.has(ch.id) &&
      ch.zoneTarget?.zone !== ZoneLabel.MEETING
    );
  }

  /** Release borrows whose reason ended; count settled time. */
  private updateBorrows(dt: number): void {
    for (const [id, b] of [...this.borrows]) {
      const ch = this.host.characters.get(id);
      if (!ch) {
        this.release(id);
        continue;
      }
      if (isSettledAtZoneTarget(ch) && ch.zoneTarget?.key === b.target.key) b.settledFor += dt;
      if (b.kind === 'limitBreak') {
        // Asleep doesn't end a break: a long wait for the reset may well doze off.
        if (!this.onBreak(ch) || b.settledFor >= (b.staySec ?? 0)) this.release(id);
        continue;
      }
      let done = this.clock > b.until || !!ch.leaving || !!ch.isSleeping || this.permission.has(id);
      switch (b.kind) {
        case 'standup':
          done ||= !this.free(ch) || b.settledFor >= STANDUP_SEATED_SEC;
          break;
        case 'pizza':
          done ||= !this.free(ch) || b.settledFor >= PIZZA_VISIT_SEC;
          break;
        case 'pingpong':
          done ||= !this.free(ch) || (this.rally !== null && this.clock >= this.rally.endsAt);
          break;
        case 'whiteboard':
          done ||= !this.planning.has(id) || !ch.isActive;
          break;
        case 'library': {
          const lingering =
            this.clock - (this.lastWebToolAt.get(id) ?? -Infinity) <= LIBRARY_LINGER_SEC;
          done ||= this.planning.has(id) || (!this.webToolLive(id) && !lingering);
          break;
        }
      }
      if (done) this.release(id);
    }
    // The rally clock starts once both players stand at their ends.
    const r = this.rally;
    if (r && r.since === null) {
      const a = this.host.characters.get(r.a);
      const b = this.host.characters.get(r.b);
      if (a && b && isSettledAtZoneTarget(a) && isSettledAtZoneTarget(b)) r.since = this.clock;
    }
  }

  // ── Rituals ──

  private updateRituals(now: Date): void {
    if (ritualDue(now, STANDUP_HOUR, STANDUP_MINUTE, this.standupRan)) {
      if (this.startStandup()) this.standupRan = localDateKey(now);
    }
    if (ritualDue(now, EVENING_BANNER_HOUR, EVENING_BANNER_MINUTE, this.bannerRan)) {
      this.bannerRan = localDateKey(now);
      const today = this.daily?.date === localDateKey(now) ? this.daily : null;
      const pushes = today?.pushes.reduce((n, p) => n + (p.count || 0), 0) ?? 0;
      this.banner = {
        text: eveningBannerText(today?.prs.length ?? 0, pushes),
        startedAt: this.clock,
      };
    }
  }

  /** Everyone idle walks to a Meeting chair. False (try again in a moment) when nobody can go. */
  startStandup(): boolean {
    const meeting = this.host.zones.zones.get(ZoneLabel.MEETING);
    if (!meeting) return false;
    const chairs = meeting.places.filter((p) => p.sit && !this.host.seats.get(p.key)?.assigned);
    const taken = new Set<string>();
    let started = 0;
    for (const ch of this.host.characters.values()) {
      if (!this.idleAwake(ch)) continue;
      const place = this.nearestPlace(ch, chairs, taken);
      if (!place) continue;
      taken.add(place.key);
      this.borrow(ch, 'standup', { ...place }, { until: this.clock + STANDUP_MAX_SEC });
      started++;
    }
    return started > 0;
  }

  /** Show the 19:00 banner now (tests, demos). */
  showEveningBanner(text: string): void {
    this.banner = { text, startedAt: this.clock };
  }

  /** Decorate for a festival regardless of the date (null: none; undefined: back to the date). */
  forceFestival(festival: Festival | null | undefined): void {
    this.festivalOverride = festival;
    this.festivalCheckAt = -Infinity;
  }

  /** The free place nearest `from` (the character by default) that it can walk to. */
  private nearestPlace<T extends ZonePlace | ZoneTarget>(
    ch: Character,
    places: readonly T[],
    taken: ReadonlySet<string>,
    from: { col: number; row: number } = { col: ch.tileCol, row: ch.tileRow },
  ): T | null {
    const sorted = places
      .filter((p) => !taken.has(p.key) && !this.placeHeld(p, ch))
      .sort(
        (a, b) =>
          Math.abs(a.col - from.col) +
          Math.abs(a.row - from.row) -
          (Math.abs(b.col - from.col) + Math.abs(b.row - from.row)),
      );
    for (const p of sorted.slice(0, 6)) {
      if (this.host.canReach(ch, p)) return p;
    }
    return null;
  }

  /** Someone else is at / headed for / borrowing this place. */
  private placeHeld(place: { key: string }, ch: Character): boolean {
    for (const other of this.host.characters.values()) {
      if (other.id !== ch.id && other.zoneTarget?.key === place.key) return true;
    }
    for (const [id, b] of this.borrows) if (id !== ch.id && b.target.key === place.key) return true;
    for (const t of this.guestSeats.values()) if (t.key === place.key) return true;
    return false;
  }

  // ── Whiteboard + library (working agents) ──

  private startWorkSpots(): void {
    for (const ch of this.host.characters.values()) {
      if (ch.isSubagent || !ch.isActive || ch.isSleeping || ch.leaving || ch.matrixEffect) continue;
      if (this.permission.has(ch.id) || this.borrows.has(ch.id)) continue;
      if (this.planning.has(ch.id)) {
        this.startWhiteboard(ch);
      } else if (this.webToolLive(ch.id)) {
        this.startLibrary(ch);
      }
    }
  }

  private startWhiteboard(ch: Character): void {
    const boards = this.itemsWhere(
      (t) => t === FUN_TYPE.WHITEBOARD || t === FUN_TYPE.WHITEBOARD_DRAWN,
    );
    const spots: Array<ZoneTarget & { uid: string }> = [];
    for (const b of boards) {
      for (let dc = 0; dc < b.w; dc++) {
        const col = b.col + dc;
        const row = b.row + b.h;
        if (!isWalkable(col, row, this.host.tileMap, this.host.blockedTiles)) continue;
        spots.push({ ...standSpot('Whiteboard', col, row, Direction.UP), uid: b.uid });
      }
    }
    const spot = this.nearestPlace(ch, spots, new Set());
    if (spot) {
      const { uid, ...target } = spot;
      this.borrow(ch, 'whiteboard', target, { itemUid: uid });
    }
  }

  private startLibrary(ch: Character): void {
    const spot = this.nearestPlace(ch, this.shelfSpots(), new Set());
    if (spot) this.borrow(ch, 'library', spot);
  }

  /** Where one stands to read at a bookshelf (below or beside it); `zone` keeps to one room. */
  private shelfSpots(zone?: ZoneLabel): ZoneTarget[] {
    const shelves = this.itemsWhere((t) => t.includes(FUN_TYPE.BOOKSHELF_PART));
    const spots: ZoneTarget[] = [];
    for (const s of shelves) {
      const around = [
        ...Array.from({ length: s.w }, (_, dc) => ({
          col: s.col + dc,
          row: s.row + s.h,
          f: Direction.UP,
        })),
        ...Array.from({ length: s.h }, (_, dr) => ({
          col: s.col - 1,
          row: s.row + dr,
          f: Direction.RIGHT,
        })),
        ...Array.from({ length: s.h }, (_, dr) => ({
          col: s.col + s.w,
          row: s.row + dr,
          f: Direction.LEFT,
        })),
      ];
      for (const t of around) {
        if (!isWalkable(t.col, t.row, this.host.tileMap, this.host.blockedTiles)) continue;
        if (zone !== undefined && this.zoneAt(t.col, t.row) !== zone) continue;
        spots.push(standSpot('Library', t.col, t.row, t.f));
      }
    }
    return spots;
  }

  // ── Pastimes for idle agents ──

  private candidate(ch: Character): RallyCandidate {
    return {
      id: ch.id,
      idleAwake: this.idleAwake(ch),
      smokingSec: isSmoking(ch) ? (ch.zoneFxTimer ?? 0) : null,
      midWorkBreak: ch.smokeBreak !== undefined,
    };
  }

  private startPastimes(now: Date): void {
    const rng = this.host.zoneRandom;
    const candidates = [...this.host.characters.values()]
      .filter((ch) => !ch.isSubagent)
      .map((ch) => this.candidate(ch));
    if (!this.rally) {
      const pair = pickRallyPair(
        candidates,
        this.lastRallyAt,
        this.clock,
        PING_PONG_COOLDOWN_SEC,
        PING_PONG_CHANCE,
        rng,
      );
      if (pair) this.startRally(pair, rng);
    }
    if (this.pizzaOn(now) && this.pizzaTables.length > 0) {
      for (const c of candidates) {
        if (!rallyEligible(c) || this.borrows.has(c.id)) continue;
        const last = this.lastPizzaVisit.get(c.id);
        if (last !== undefined && this.clock - last < PIZZA_VISIT_COOLDOWN_SEC) continue;
        if (rng() >= PIZZA_VISIT_CHANCE) continue;
        const ch = this.host.characters.get(c.id);
        if (ch && this.startPizzaVisit(ch)) this.lastPizzaVisit.set(c.id, this.clock);
      }
    }
  }

  /** Start a rally on a ping-pong table (true when both players were sent); `zone` keeps to one room. */
  startRally(
    pair: [number, number],
    rng: () => number = this.host.zoneRandom,
    zone?: ZoneLabel,
  ): boolean {
    const a = this.host.characters.get(pair[0]);
    const b = this.host.characters.get(pair[1]);
    if (!a || !b) return false;
    for (const table of this.pingPongTables(zone)) {
      for (let dr = table.h - 1; dr >= 0; dr--) {
        const row = table.row + dr;
        const left = standSpot('PingPong', table.col - 1, row, Direction.RIGHT);
        const right = standSpot('PingPong', table.col + table.w, row, Direction.LEFT);
        const walk = (t: ZoneTarget) =>
          isWalkable(t.col, t.row, this.host.tileMap, this.host.blockedTiles);
        if (!walk(left) || !walk(right) || this.placeHeld(left, a) || this.placeHeld(right, b))
          continue;
        // Whoever is nearer the left end takes it.
        const aLeft =
          Math.abs(a.tileCol - left.col) + Math.abs(b.tileCol - right.col) <=
          Math.abs(b.tileCol - left.col) + Math.abs(a.tileCol - right.col);
        const [pl, pr] = aLeft ? [a, b] : [b, a];
        if (!this.host.canReach(pl, left) || !this.host.canReach(pr, right)) continue;
        const duration = PING_PONG_MIN_SEC + rng() * (PING_PONG_MAX_SEC - PING_PONG_MIN_SEC);
        const walkAllowance = 30;
        this.rally = {
          a: pl.id,
          b: pr.id,
          table,
          endsAt: this.clock + walkAllowance + duration,
          since: null,
        };
        this.lastRallyAt = this.clock;
        this.borrow(pl, 'pingpong', left, { until: this.rally.endsAt + 1 });
        this.borrow(pr, 'pingpong', right, { until: this.rally.endsAt + 1 });
        return true;
      }
    }
    return false;
  }

  private pingPongTables(zone?: ZoneLabel): PlacedItem[] {
    return this.itemsWhere((t) => t === FUN_TYPE.PING_PONG_TABLE).filter(
      (t) => zone === undefined || this.zoneAt(t.col, t.row) === zone,
    );
  }

  private startPizzaVisit(ch: Character): boolean {
    const cafe = this.host.zones.zones.get(ZoneLabel.CAFE);
    if (!cafe) return false;
    // Cafe seats nearest a pizza table.
    const near = (p: ZonePlace) =>
      Math.min(
        ...this.pizzaTables.map(
          (t) => Math.abs(p.col - (t.col + t.w / 2)) + Math.abs(p.row - (t.row + t.h / 2)),
        ),
      );
    const seats = cafe.places
      .filter((p) => p.sit && !this.host.seats.get(p.key)?.assigned && !this.placeHeld(p, ch))
      .sort((a, b) => near(a) - near(b))
      .slice(0, 3);
    for (const seat of seats) {
      if (!this.host.canReach(ch, seat)) continue;
      this.borrow(ch, 'pizza', { ...seat });
      return true;
    }
    return false;
  }

  /** The rally on screen (both players at their ends), for the renderer. */
  rallyView(): FunRallyView | null {
    const r = this.rally;
    if (!r || r.since === null) return null;
    const a = this.host.characters.get(r.a);
    const b = this.host.characters.get(r.b);
    if (!a || !b) return null;
    return { a, b, t: this.clock - r.since, table: r.table };
  }

  // ════════════════════════════════════════════════════════════
  // The limit break (limitBreak.ts)
  // ════════════════════════════════════════════════════════════

  /** On the break: paused by a session limit, top-level, and wanted by nothing else. */
  private onBreak(ch: Character): boolean {
    return (
      this.limited.has(ch.id) &&
      !ch.isSubagent &&
      !ch.isActive &&
      !ch.leaving &&
      !ch.matrixEffect &&
      !this.permission.has(ch.id) &&
      !this.askingUser(ch.id)
    );
  }

  /** The agents on the break right now (none without a Lounge). */
  breakMembers(): Character[] {
    if (!this.host.zones.zones.has(ZoneLabel.LOUNGE)) return [];
    return [...this.host.characters.values()].filter((ch) => this.onBreak(ch));
  }

  /** The break is on: someone the session limit cut off is here, and there is a Lounge. */
  get breakOn(): boolean {
    return this.breakWasOn;
  }

  /** When the earliest of the break's limits resets (epoch ms), if any says. */
  breakResetsAt(): number | undefined {
    let earliest: number | undefined;
    for (const ch of this.breakMembers()) {
      const at = this.limited.get(ch.id);
      if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at;
    }
    return earliest;
  }

  /** The sign over the Lounge while the break is on: its text, and the top
   *  middle of the room (tile units; `col` may be half a tile). */
  breakSign(): { text: string; col: number; row: number } | null {
    if (!this.breakWasOn) return null;
    const tiles = this.host.zones.zones.get(ZoneLabel.LOUNGE)?.tiles ?? [];
    if (tiles.length === 0) return null;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    for (const t of tiles) {
      left = Math.min(left, t.col);
      right = Math.max(right, t.col);
      top = Math.min(top, t.row);
    }
    return {
      text: breakSignText(this.breakResetsAt(), this.host.nowMs()),
      col: (left + right + 1) / 2,
      row: top,
    };
  }

  /** What is being said on the break right now. */
  breakLinesShowing(): BreakLineShowing[] {
    return this.breakLines.filter((l) => this.clock < l.until);
  }

  /**
   * A Lounge seat near the group for an NPC joining the break, held for it
   * (marked taken, so no agent is routed onto it) until releaseGuestSeat.
   * The one it holds already, if any; null when the break is off or no seat
   * is free and reachable.
   */
  claimGuestSeat(who: BreakGuest, ch: Character): ZoneTarget | null {
    const held = this.guestSeats.get(who);
    if (held) return held;
    const lounge = this.host.zones.zones.get(ZoneLabel.LOUNGE);
    if (!lounge || !this.breakWasOn) return null;
    const seats = lounge.places.filter((p) => p.sit && !this.seatTaken(p, ch));
    const seat = this.nearestPlace(ch, seats, new Set(), this.breakHub(ch));
    if (!seat) return null;
    this.guestSeats.set(who, seat);
    const s = this.host.seats.get(seat.key);
    if (s) s.assigned = true;
    return seat;
  }

  releaseGuestSeat(who: BreakGuest): void {
    const t = this.guestSeats.get(who);
    if (!t) return;
    this.guestSeats.delete(who);
    const s = this.host.seats.get(t.key);
    if (s) s.assigned = false;
  }

  /** A new layout: the seats and the NPCs are rebuilt, so nothing is held. */
  forgetGuestSeats(): void {
    this.guestSeats.clear();
  }

  /** Per frame: who is on the break, their next activity, the cups, the pizza, the chat. */
  private updateLimitBreak(nowMs: number): void {
    const members = this.breakMembers();
    const on = members.length > 0;
    if (on !== this.breakWasOn) {
      this.breakWasOn = on;
      this.refreshBreakPizza(on);
      if (!on) {
        this.breakLines = [];
        this.lastBreakSpeaker = null;
      }
    }
    for (const id of [...this.breakCups]) {
      const b = this.borrows.get(id);
      const ch = this.host.characters.get(id);
      if (b?.kind === 'limitBreak' && b.activity === 'coffee') {
        // In hand once sat down with it.
        if (ch) ch.carryingCup = isSettledAtZoneTarget(ch) || undefined;
      } else {
        this.breakCups.delete(id);
        if (ch) ch.carryingCup = undefined;
      }
    }
    if (!on) return;
    for (const ch of members) {
      if (this.borrows.has(ch.id)) continue;
      if (this.clock < (this.breakRetryAt.get(ch.id) ?? -Infinity)) continue;
      if (!this.startBreakActivity(ch, members)) {
        this.breakRetryAt.set(ch.id, this.clock + 2);
      }
    }
    this.updateBreakChat(members, nowMs);
  }

  /** Send an agent on the break to its next activity. False: nowhere to go right now. */
  private startBreakActivity(ch: Character, members: readonly Character[]): boolean {
    const lounge = this.host.zones.zones.get(ZoneLabel.LOUNGE);
    if (!lounge) return false;
    const rng = this.host.zoneRandom;
    const seats = lounge.places.filter((p) => p.sit && !this.seatTaken(p, ch));
    const send = (activity: BreakActivity, target: ZoneTarget | null): boolean => {
      if (!target) return false;
      const staySec =
        BREAK_ACTIVITY_MIN_SEC + rng() * (BREAK_ACTIVITY_MAX_SEC - BREAK_ACTIVITY_MIN_SEC);
      this.borrow(ch, 'limitBreak', { ...target }, { activity, staySec, until: Infinity });
      this.lastBreakActivity.set(ch.id, activity);
      if (activity === 'coffee') this.breakCups.add(ch.id);
      return true;
    };
    const seatNear = (at: { col: number; row: number }) =>
      this.nearestPlace(ch, seats, new Set(), at);

    const tries = new Map<BreakActivity, () => boolean>();
    tries.set('sofa', () => {
      const hub = this.breakHub(ch);
      return send('sofa', seatNear(hub) ?? this.standNear(ch, lounge.tiles, hub));
    });
    const table = this.breakPizzaTables[0];
    if (table && seats.length > 0) {
      tries.set('pizza', () =>
        send('pizza', seatNear({ col: table.col + table.w / 2, row: table.row + table.h / 2 })),
      );
    }
    const mug = this.itemsWhere((t) => t === FUN_TYPE.COFFEE_MUG)
      .filter((m) => this.zoneAt(m.col, m.row) === ZoneLabel.LOUNGE)
      .sort(
        (a, b) =>
          Math.abs(a.col - ch.tileCol) +
          Math.abs(a.row - ch.tileRow) -
          (Math.abs(b.col - ch.tileCol) + Math.abs(b.row - ch.tileRow)),
      )[0];
    if (mug && seats.length > 0) tries.set('coffee', () => send('coffee', seatNear(mug)));
    const shelves = this.shelfSpots(ZoneLabel.LOUNGE);
    if (shelves.length > 0) {
      tries.set('shelves', () => send('shelves', this.nearestPlace(ch, shelves, new Set())));
    }
    // A rally takes two: someone else on the break who is free or just sitting about.
    const partner = members.find((o) => {
      if (o.id === ch.id || !this.free(o)) return false;
      const b = this.borrows.get(o.id);
      return !b || (b.kind === 'limitBreak' && b.activity === 'sofa');
    });
    if (partner && this.free(ch) && this.pingPongTables(ZoneLabel.LOUNGE).length > 0) {
      tries.set('pingpong', () => {
        const held = this.borrows.get(partner.id);
        this.borrows.delete(partner.id);
        if (this.startRally([ch.id, partner.id], rng, ZoneLabel.LOUNGE)) {
          this.lastBreakActivity.set(ch.id, 'pingpong');
          this.lastBreakActivity.set(partner.id, 'pingpong');
          return true;
        }
        if (held) this.borrows.set(partner.id, held);
        return false;
      });
    }

    const available = new Set(tries.keys());
    while (available.size > 0) {
      const pick = pickBreakActivity(available, this.lastBreakActivity.get(ch.id), rng);
      if (!pick) break;
      if (tries.get(pick)?.()) return true;
      available.delete(pick);
    }
    return false;
  }

  /** A seat someone holds (its desk, a destination, an NPC on the break) — not its own. */
  private seatTaken(place: ZoneTarget, ch: Character): boolean {
    return (this.host.seats.get(place.key)?.assigned ?? false) && ch.zoneTarget?.key !== place.key;
  }

  /** Where the break gathers: around the seats already taken on it (agents
   *  on the sofas, the NPCs), else wherever this one is. */
  private breakHub(ch: Character): { col: number; row: number } {
    const at: Array<{ col: number; row: number }> = [];
    for (const [id, b] of this.borrows) {
      if (id !== ch.id && b.kind === 'limitBreak' && b.activity === 'sofa') at.push(b.target);
    }
    for (const t of this.guestSeats.values()) at.push(t);
    if (at.length === 0) return { col: ch.tileCol, row: ch.tileRow };
    return {
      col: Math.round(at.reduce((n, p) => n + p.col, 0) / at.length),
      row: Math.round(at.reduce((n, p) => n + p.row, 0) / at.length),
    };
  }

  /** No seat left: a spot to stand with the group, facing it. */
  private standNear(
    ch: Character,
    tiles: ReadonlyArray<{ col: number; row: number }>,
    hub: { col: number; row: number },
  ): ZoneTarget | null {
    const spots = tiles
      .filter(
        (t) =>
          Math.abs(t.col - hub.col) + Math.abs(t.row - hub.row) <= BREAK_STAND_RADIUS_TILES &&
          (t.col !== hub.col || t.row !== hub.row) &&
          isWalkable(t.col, t.row, this.host.tileMap, this.host.blockedTiles),
      )
      .map((t) => standSpot(ZoneLabel.LOUNGE, t.col, t.row, faceToward(t, hub, Direction.DOWN)));
    return this.nearestPlace(ch, spots, new Set(), hub);
  }

  /** The break's pizza: one open box on a Lounge table with room, for as long as it lasts. */
  private refreshBreakPizza(on: boolean): void {
    this.breakPizzaDecor = [];
    this.breakPizzaTables = [];
    this.dirty = true;
    if (!on) return;
    const free = freeSurfaceTiles(this.decorInput(), [ZoneLabel.LOUNGE]);
    const tables = this.items
      .filter(
        (i) => getCatalogEntry(i.type)?.isDesk && this.zoneAt(i.col, i.row) === ZoneLabel.LOUNGE,
      )
      .sort((a, b) => a.row - b.row || a.col - b.col);
    for (const table of tables) {
      const tile = free.find(
        (t) =>
          t.col >= table.col &&
          t.col < table.col + table.w &&
          t.row >= table.row &&
          t.row < table.row + table.h,
      );
      if (!tile) continue;
      this.breakPizzaTables = [table];
      this.breakPizzaDecor = toPlaced([{ type: FUN_TYPE.PIZZA_BOX_OPEN, ...tile }]);
      return;
    }
  }

  /** Now and then someone settled on the break (or an NPC with it) says something. */
  private updateBreakChat(members: readonly Character[], nowMs: number): void {
    this.breakLines = this.breakLines.filter((l) => this.clock < l.until);
    if (this.clock < this.breakChatAt) return;
    const rng = this.host.zoneRandom;
    this.breakChatAt =
      this.clock + BREAK_CHAT_MIN_SEC + rng() * (BREAK_CHAT_MAX_SEC - BREAK_CHAT_MIN_SEC);
    const speakers: BreakSpeaker[] = [];
    for (const ch of members) {
      const b = this.borrows.get(ch.id);
      if (b?.kind === 'limitBreak' && b.activity !== 'shelves' && b.settledFor > 0) {
        speakers.push(ch.id);
      }
    }
    speakers.push(...(this.host.breakGuests?.() ?? []));
    if (speakers.length < 2) return; // nobody to talk to
    const options = speakers.filter(
      (s) => s !== this.lastBreakSpeaker && !this.breakLines.some((l) => l.who === s),
    );
    if (options.length === 0) return;
    const who = options[Math.floor(rng() * options.length) % options.length];
    this.lastBreakSpeaker = who;
    this.breakLines.push({
      who,
      text: breakLine(who, this.breakResetsAt(), nowMs, rng),
      until: this.clock + BREAK_LINE_SEC,
    });
  }

  // ════════════════════════════════════════════════════════════
  // Smart pets
  // ════════════════════════════════════════════════════════════

  /** Gitcat follows a smoker heading out now and then (at most hourly). */
  private watchSmokers(): void {
    const smokers = new Set<number>();
    for (const ch of this.host.characters.values()) {
      if (ch.zoneTarget?.zone === ZoneLabel.SMOKE && !ch.leaving) smokers.add(ch.id);
    }
    for (const id of smokers) {
      if (this.smokersSeen.has(id) || this.follow) continue;
      if (
        mayFollowSmoker(
          this.lastFollowAt,
          this.clock,
          GITCAT_FOLLOW_COOLDOWN_SEC,
          GITCAT_FOLLOW_CHANCE,
          this.host.zoneRandom,
        )
      ) {
        this.follow = { agentId: id, until: this.clock + GITCAT_FOLLOW_MAX_SEC };
        this.lastFollowAt = this.clock;
      }
    }
    this.smokersSeen.clear();
    for (const id of smokers) this.smokersSeen.add(id);
    if (this.follow && (this.clock > this.follow.until || !smokers.has(this.follow.agentId))) {
      this.follow = null;
    }
  }

  /** The pet's goal now (null: not one of the smart pets). */
  petGoal(pet: Pet): GitcatGoal | ClaudioGoal | null {
    const role = petRole(pet);
    const now = this.host.nowMs();
    if (role === 'gitcat') {
      const chars = this.host.characters;
      const sleepers: number[] = [];
      let anyoneBusy = false;
      for (const ch of chars.values()) {
        if (ch.isSubagent || ch.leaving) continue;
        if (ch.isActive && !ch.isSleeping) anyoneBusy = true;
        if (ch.isSleeping && !ch.isActive) sleepers.push(ch.id);
      }
      const busiest = busiestAgent(this.toolStarts, now, BUSY_WINDOW_MS, (id) => {
        const ch = chars.get(id);
        return !!ch && !ch.isSubagent && ch.isActive && !ch.leaving && ch.seatId !== null;
      });
      return gitcatGoal({ following: this.follow?.agentId ?? null, busiest, anyoneBusy, sleepers });
    }
    if (role === 'claudio') {
      return claudioGoal({ celebrate: this.celebrate, greet: this.greet }, now);
    }
    return null;
  }

  /** Drive a smart pet this frame; false lets its own FSM run. */
  drivePet(pet: Pet, dt: number): boolean {
    if (petRole(pet) === null) return false;
    const world: PetWorld = {
      characters: this.host.characters,
      seats: this.host.seats,
      tileMap: this.host.tileMap,
      blockedTiles: this.host.blockedTiles,
      deskAt: (col, row) => this.deskAt(col, row),
      zoneAt: (col, row) => this.zoneAt(col, row),
      door: this.host.zones.door,
    };
    const driven = this.pets.drive(pet, dt, world, (p) => this.petGoal(p));
    if (driven && petRole(pet) === 'claudio') this.heartsFor(pet);
    return driven;
  }

  /** Claudio shows a heart once when the newcomer passes, and when it starts celebrating. */
  private heartsFor(pet: Pet): void {
    for (const event of [this.greet, this.celebrate]) {
      if (!event || event.hearted || this.host.nowMs() >= event.until) continue;
      const ch = this.host.characters.get(event.agentId);
      if (!ch) continue;
      if (Math.abs(ch.tileCol - pet.tileCol) + Math.abs(ch.tileRow - pet.tileRow) <= 2) {
        event.hearted = true;
        pet.bubbleType = 'heart';
        pet.bubbleTimer = 2;
      }
    }
  }

  private deskAt(
    col: number,
    row: number,
  ): { col: number; row: number; w: number; h: number } | null {
    for (const i of this.items) {
      if (col < i.col || col >= i.col + i.w || row < i.row || row >= i.row + i.h) continue;
      if (getCatalogEntry(i.type)?.isDesk) return i;
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════
  // Radio
  // ════════════════════════════════════════════════════════════

  /** A click on the office (world px): toggles the radio when it hits one. */
  handleTap(worldX: number, worldY: number): boolean {
    const hit = this.itemsWhere((t) => t === FUN_TYPE.RADIO).some((r) => {
      const h = getCatalogEntry(r.type)?.sprite.length ?? TILE_SIZE;
      const x0 = r.col * TILE_SIZE;
      const y1 = r.row * TILE_SIZE + h;
      return worldX >= x0 && worldX < x0 + r.w * TILE_SIZE && worldY >= y1 - h && worldY < y1;
    });
    if (!hit) return false;
    this.loadRadioToggle();
    this.radioOn = !this.radioOn;
    getFunAudio()?.saveRadioOn(this.radioOn);
    return true;
  }

  /** Playing: toggled on, the global sound setting on, and a radio in the office. */
  get radioPlaying(): boolean {
    return getFunAudio()?.radio.playing ?? false;
  }

  /** The viewer's remembered toggle, read once the browser audio is plugged in. */
  private loadRadioToggle(): void {
    const audio = getFunAudio();
    if (this.radioLoaded || !audio) return;
    this.radioLoaded = true;
    this.radioOn = audio.loadRadioOn();
  }

  private updateRadio(dt: number): void {
    const radios = this.itemsWhere((t) => t === FUN_TYPE.RADIO);
    this.loadRadioToggle();
    const audio = getFunAudio();
    const allowed = this.radioOn && radios.length > 0 && (audio?.soundEnabled() ?? false);
    if (audio && allowed && !audio.radio.playing) audio.radio.start();
    else if (audio && !allowed && audio.radio.playing) audio.radio.stop();

    for (const n of this.notes) {
      n.age += dt;
    }
    while (this.notes.length > 0 && this.notes[0].age > RADIO_NOTE_LIFETIME_SEC) this.notes.shift();
    // On the break the radio is on for the eyes (the sound stays the viewer's toggle).
    if ((!this.radioPlaying && !this.breakWasOn) || radios.length === 0) return;
    this.noteIn -= dt;
    if (this.noteIn > 0) return;
    this.noteIn = RADIO_NOTE_INTERVAL_SEC;
    const r = radios[0];
    const rng = this.host.zoneRandom;
    this.notes.push({
      x: r.col * TILE_SIZE + 4 + rng() * 8,
      y: r.row * TILE_SIZE + 4,
      age: 0,
      color:
        RADIO_NOTE_COLORS[Math.floor(rng() * RADIO_NOTE_COLORS.length) % RADIO_NOTE_COLORS.length],
      sway: rng() * Math.PI * 2,
    });
  }

  // ── Characters (for the renderer) ──

  characters(): IterableIterator<Character> {
    return this.host.characters.values();
  }

  /** The office it runs in (e2e / visual checks). */
  get office(): FunHost {
    return this.host;
  }
}

// ── Helpers ────────────────────────────────────────────────────

function toolNameOf(status: string): string | null {
  if (status.startsWith('Writing ')) return 'Write';
  if (status === 'Searching the web') return 'WebSearch';
  if (status === 'Fetching web content') return 'WebFetch';
  if (status === 'Planning') return PLAN_ENTER_TOOL;
  return null;
}

function standSpot(zone: string, col: number, row: number, facing: Direction): ZoneTarget {
  return { zone, key: spotKey(col, row), col, row, facing, sit: false };
}

function toPlaced(items: DecorPlacement[]): PlacedFurniture[] {
  return items.map((d) => ({ uid: `fun:${d.type}:${d.col},${d.row}`, ...d }));
}

/** The director the renderer draws (the live office's; set every update). */
let activeFun: FunDirector | null = null;

function setActiveFun(fun: FunDirector): void {
  activeFun = fun;
}

export function getActiveFun(): FunDirector | null {
  return activeFun;
}
