import type { AnshThoughtEntry, DailyStats } from '../../../../core/src/messages.js';
import { pickDiversePalette } from '../../../../core/src/paletteUtils.js';
import {
  ANSH_CHAT_STAY_SEC,
  ANSH_COFFEE_CUP_SEC,
  ANSH_PET_HEART_SEC,
  ANSH_STRETCH_RADIUS_TILES,
  ANSH_STRETCH_STAY_SEC,
  ANSH_VISIT_STAY_SEC,
  ANSH_WANDER_MIN_SEC,
  ANSH_WANDER_RANGE_SEC,
  ASHTRAY_BUTT_SLOTS,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_SITTING_OFFSET_PX,
  CIGARETTE_Z_SORT_OFFSET,
  COFFEE_RNG_SEED,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  FURNITURE_ANIM_INTERVAL_SEC,
  GREETER_ID,
  GREETER_TILE_MARGIN,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  MAX_PET_ID_LENGTH,
  PET_HIT_HALF_WIDTH,
  PET_HIT_HEIGHT,
  SMOKE_LIGHT_UP_SEC,
  SMOKE_STUB_OUT_SEC,
  TRANSIENT_SESSION_SEC,
  WAITING_BUBBLE_DURATION_SEC,
  ZONE_RETRY_INTERVAL_SEC,
} from '../../constants.js';
import type { BreakGuest } from '../../fun/funDirector.js';
import { FunDirector } from '../../fun/funDirector.js';
import { metricsOf } from '../agentLook.js';
import { findNpcPlaces } from '../anshOffice.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getPetCount, getPetName } from '../sprites/petSpriteData.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  PlacedPet,
  Seat,
  TileType as TileTypeVal,
  ZoneTarget,
} from '../types.js';
import { CharacterState, Direction, PetState, TILE_SIZE } from '../types.js';
import type { OfficeZones } from '../zones.js';
import { isRoutedZoneLabel, NO_ZONES, parseZones, toZoneLabel, ZoneLabel } from '../zones.js';
import { timeOfDay } from './ambience.js';
import type { ErrandOption, TimedLine } from './anshErrands.js';
import {
  AnshErrand,
  errandScript,
  faceToFaceSpot,
  furnitureErrand,
  linesShowing,
  pickErrand,
  scheduleLines,
  standSpotFor,
  tileBeside,
} from './anshErrands.js';
import { Celebrations } from './celebrations.js';
import { createCharacter, isSettledAtZoneTarget, updateCharacter } from './characters.js';
import type { CoffeeRunState } from './coffeeRuns.js';
import {
  carryingCup,
  NO_COFFEE_RUN,
  onCoffeeRun,
  seededRandom,
  stepCoffeeRun,
} from './coffeeRuns.js';
import { advanceMatrixEffect, startMatrixEffect } from './matrixEffectState.js';
import type { NpcKind } from './npcs.js';
import { faceToward, OfficeNpcs } from './npcs.js';
import {
  coffeeZones,
  furnitureAt,
  namePlateInstances,
  placeReceptionist,
  withLiveClocks,
} from './officeAmbience.js';
import { createPet, updateIdleAnimation, updatePet } from './petEntity.js';
import { waveFrame } from './receptionist.js';
import { anchorTile, closestFreeSeat, helperSeat } from './seatPlacement.js';
import type { SmokeBreakState } from './smokeBreaks.js';
import { NO_SMOKE_BREAK, onSmokeBreak, stepSmokeBreak } from './smokeBreaks.js';
import { withTrophies } from './trophyWall.js';
import { ASHTRAY_BUTT_SPRITE, ashtrayButtCount, isSmoking, socialFacing } from './zoneEffects.js';
import type {
  DestinationIntent,
  DestinationSignals,
  LiveTool,
  PlaceChoice,
} from './zoneRouting.js';
import {
  choosePlace,
  Destination,
  holdDestination,
  isSmokeDestination,
  liveToolSignals,
  pickDestination,
} from './zoneRouting.js';

/** A destination being acted on: placed yet, and when to look again if its room was full. */
interface RoutedIntent extends DestinationIntent {
  resolved: boolean;
  retryAt: number;
}

/** Per-agent activity the destination rules read, kept by id like sleepingAgents. */
interface AgentZoneSignals {
  /** Live (not done) tools by toolId. */
  tools: Map<string, LiveTool>;
  permission: boolean;
  phase?: string;
  /** agentProgress.waitingSince: when its current wait on the user began (epoch ms). */
  waitingSince?: number;
  /** The mid-work break scheduler (smokeBreaks.ts). */
  smokeBreak: SmokeBreakState;
  /** Paused by a usage limit (agentLimit, inbox/inboxStore.ts). */
  paused?: boolean;
  /** The Café coffee-run scheduler (coffeeRuns.ts). */
  coffeeRun: CoffeeRunState;
}

/** Where the Entrance door's leaving target is keyed (shared, never reserved). */
const DOOR_TARGET_KEY = 'door';

/** Internal helper: facing-tile coords for a seat. Returns null for invalid direction. */
function seatFacingOffset(direction: Direction): { dCol: number; dRow: number } {
  if (direction === Direction.RIGHT) return { dCol: 1, dRow: 0 };
  if (direction === Direction.LEFT) return { dCol: -1, dRow: 0 };
  if (direction === Direction.DOWN) return { dCol: 0, dRow: 1 };
  return { dCol: 0, dRow: -1 };
}

/** Where one of Ansh's errands takes him, what he looks at, and who with. */
interface AnshErrandTarget {
  near: { col: number; row: number };
  look: () => { col: number; row: number } | null;
  pet?: Pet;
  partner?: Character;
}

const tileOf = (t: { tileCol: number; tileRow: number }) => ({ col: t.tileCol, row: t.tileRow });

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  pets: Pet[] = [];
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  private _selectedAgentId: number | null = null;
  private readonly selectionListeners = new Set<(id: number | null) => void>();
  get selectedAgentId(): number | null {
    return this._selectedAgentId;
  }
  set selectedAgentId(id: number | null) {
    if (this._selectedAgentId === id) return;
    this._selectedAgentId = id;
    for (const listener of this.selectionListeners) listener(id);
  }
  /** Observe selectedAgentId changes. React (the card bars) subscribes so
   *  imperative canvas selection can drive card highlights — everything else
   *  about selection stays out of React state. Returns the unsubscribe. */
  subscribeSelection(listener: (id: number | null) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  /** Agent ID → where a relayed remote session runs. Local agents are absent.
   *  Kept outside `characters` so it survives existingAgents buffering. */
  agentSources: Map<number, { label: string; kind: 'computer' | 'cloud' }> = new Map();
  /** Agents the server reports sleeping (agentSleep). By id, outside
   *  `characters`, for the same reason as agentSources: the message can arrive
   *  before the character does, and addAgent applies it on creation. */
  sleepingAgents: Set<number> = new Set();
  private nextSubagentId = -1;

  // ── Living office (docs/office/DESIGN.md) ───────────────────
  /** The layout's zones; empty in a layout without the reserved Area labels,
   *  which skips every living-office behaviour. */
  zones: OfficeZones = NO_ZONES;
  /** Seconds of game time (sum of update dt): the destination engine's clock. */
  private officeClock = 0;
  private readonly destinationIntents = new Map<number, RoutedIntent>();
  /** Standing spots in use: spot key → character id. Zone SEATS are reserved
   *  through `seat.assigned` instead, so no desk picker can hand them out. */
  private readonly reservedSpots = new Map<string, number>();
  private readonly agentZoneSignals = new Map<number, AgentZoneSignals>();
  /** Wall clock (epoch ms) for wait lengths (agentProgress.waitingSince). Tests replace it. */
  nowMs: () => number = () => Date.now();
  /** The mid-work break chance's RNG ([0, 1), like Math.random). Tests seed it. */
  zoneRandom: () => number = () => Math.random();
  /** Ansh's between-thoughts wander: when, and where. Tests replace it. */
  anshWanderRandom: () => number = () => Math.random();
  /** Seconds Ansh has sat at his desk, and how long he sits before wandering. */
  private anshDeskSec = 0;
  private anshWanderAfterSec: number | null = null;
  /** The limit break: an NPC that found no seat to join it tries again from then (office clock). */
  private readonly breakGuestRetryAt = new Map<BreakGuest, number>();
  /** The errand he did last (the next one is something else), and a count
   *  that tells one errand's lines from the next. */
  private anshLastErrand: AnshErrand | null = null;
  private anshErrandSeq = 0;
  /** What is said on his errands (his lines, the answers), on the office clock. */
  private anshLines: Array<TimedLine & { seq: number }> = [];
  /** The pet sitting still for him to pet it, by id; null when none. */
  private anshPetHold: string | null = null;
  /** Pets the fun director drove last frame: busy, not to be petted. */
  private readonly petsDriven = new Set<string>();
  /** Office-clock time the cup from the coffee machine is finished. */
  private anshCupUntil = 0;
  /** Office-clock time he began watering a plant, or null. */
  private anshWateringSince: number | null = null;
  /** Phase B: bells, confetti and the trophy wall's tally (celebrations.ts). */
  readonly celebrations = new Celebrations();

  // ── Living office: ambience (phase C, officeAmbience.ts) ────
  /** The local clock the windows and clocks read. Tests replace it. */
  ambienceNow: () => Date = () => new Date();
  /** The coffee runs' RNG: seeded, so an office's runs are reproducible. Tests replace it. */
  coffeeRandom: () => number = seededRandom(COFFEE_RNG_SEED);
  /** Where coffee runs go: the Café counter, as a Café-only OfficeZones. */
  private coffeeCounter: OfficeZones = NO_ZONES;
  /**
   * The Entrance receptionist, deliberately NOT in `characters` — for the
   * greeter's reasons (below): she is not an agent, so nothing that seats,
   * routes, counts, persists or hit-tests agents ever sees her. Drawn because
   * getCharacters() appends her. Null without an Entrance RECEPTION_DESK.
   */
  receptionist: Character | null = null;
  /** Office-clock time she began waving (an agent walked in), or null. */
  private receptionistWaveAt: number | null = null;

  /** Fun (phases E/F): rituals, pastimes, decorations, smart pets (fun/funDirector.ts). */
  readonly fun: FunDirector = new FunDirector(this);

  /**
   * directoryName → list of Area labels that Directory belongs to.
   * Populated by useExtensionMessages on `areaMappingsLoaded`. Consulted by
   * `findFreeSeat()` to bias new agents toward seats inside their Directory's Area.
   */
  areaMappings: Record<string, string[]> = {};

  /**
   * The first-run consent greeter, deliberately NOT in `characters`.
   *
   * `characters` means "agents": everything that iterates it — seat
   * assignment, palette diversity, the wander FSM, hit-testing, the seat
   * payload the webview persists — is asking an agent question the greeter has
   * no answer to. Holding it here instead of tagging it with a flag makes
   * every one of those loops correct by default, rather than correct as long
   * as each remembers an `isGreeter` guard. It is drawn because
   * `getCharacters()` appends it, and that is the only place it joins the
   * others.
   */
  greeter: Character | null = null;

  /** Phase M's NPCs (Ansh, the Manager): outside `characters` like the
   *  greeter, for the same reason. Absent without `Ansh`/`Manager` Areas. */
  npcs: OfficeNpcs = new OfficeNpcs();

  /** World-space point the camera drifts to while the greeter is up
   *  (the bubble overlay recomputes it every frame: the combined center of the
   *  character and its speech bubble). An explicit cameraFollowId outranks it. */
  greeterCameraTarget: { x: number; y: number } | null = null;
  /** Latched by a manual pan during the ask: the user took the camera, so the
   *  overlay's per-frame updates stop re-centering. Reset on spawn/despawn. */
  private greeterCameraCancelled = false;

  setAreaMappings(mappings: Record<string, string[]>): void {
    this.areaMappings = mappings;
  }

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.zones = this.buildZones();
    this.npcs = this.buildNpcs();
    this.npcs.reserveSeats(this.seats);
    this.coffeeCounter = coffeeZones(this);
    this.receptionist = placeReceptionist(this, null);
    // Pets are built last because they need walkableTiles populated for spawn.
    this.rebuildPetsFromLayout(this.layout);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.resetZoneRouting();
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.zones = this.buildZones();
    this.fun.forgetGuestSeats(); // the seats and the NPCs are new
    this.npcs = this.buildNpcs();
    this.resetAnshErrands();
    this.coffeeCounter = coffeeZones(this);

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Shift pet positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const pet of this.pets) {
        pet.tileCol += shift.col;
        pet.tileRow += shift.row;
        pet.x += shift.col * TILE_SIZE;
        pet.y += shift.row * TILE_SIZE;
        pet.path = [];
        pet.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }
    this.npcs.reserveSeats(this.seats); // never an agent's
    // The receptionist takes her chair before any agent picks a seat.
    this.receptionist = placeReceptionist(this, this.receptionist);

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats — agents before
    // helpers, so a smaller layout never seats a helper and strands an agent.
    const unseated = [...this.characters.values()].sort(
      (a, b) => Number(a.isSubagent) - Number(b.isSubagent),
    );
    for (const ch of unseated) {
      if (ch.seatId || ch.leaving) continue;
      const seatId = this.findFreeSeat(ch.directoryName);
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }

    // Relocate any pets that ended up outside bounds or on non-walkable tiles
    for (const pet of this.pets) {
      if (
        pet.tileCol < 0 ||
        pet.tileCol >= layout.cols ||
        pet.tileRow < 0 ||
        pet.tileRow >= layout.rows ||
        !isWalkable(pet.tileCol, pet.tileRow, this.tileMap, this.blockedTiles)
      ) {
        if (this.walkableTiles.length > 0) {
          const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
          pet.tileCol = spawn.col;
          pet.tileRow = spawn.row;
          pet.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
          pet.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
          pet.path = [];
          pet.moveProgress = 0;
          pet.state = PetState.IDLE;
          pet.frame = 0;
          pet.frameTimer = 0;
          pet.followTargetId = null;
        }
      }
    }

    // Reconcile pets against the layout roster (handles editor add/remove)
    this.rebuildPetsFromLayout(layout);
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  /** Collect every tile occupied by electronics furniture (PCs, monitors, etc.). */
  private buildElectronicsTileSet(): Set<string> {
    const out = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          out.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
    return out;
  }

  /** Find the area label assigned to a seat's tile, or null. Public for e2e
   *  observability (getAgentSeats hook reads a seated agent's area). */
  seatZone(uid: string): string | null {
    const seat = this.seats.get(uid);
    if (!seat) return null;
    const tiles = this.layout.areaTiles;
    if (!tiles || tiles.length === 0) return null;
    const idx = seat.seatRow * this.layout.cols + seat.seatCol;
    if (idx < 0 || idx >= tiles.length) return null;
    return tiles[idx] ?? null;
  }

  /**
   * Does this seat face an electronics tile (PC, monitor)? Mirrors the
   * forward-and-flanking scan used by furniture auto-state.
   */
  private isSeatFacingElectronics(seat: Seat, electronicsTiles: Set<string>): boolean {
    const { dCol, dRow } = seatFacingOffset(seat.facingDir);
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      const tileCol = seat.seatCol + dCol * d;
      const tileRow = seat.seatRow + dRow * d;
      if (electronicsTiles.has(`${tileCol},${tileRow}`)) return true;
      if (dCol !== 0) {
        if (
          electronicsTiles.has(`${tileCol},${tileRow - 1}`) ||
          electronicsTiles.has(`${tileCol},${tileRow + 1}`)
        ) {
          return true;
        }
      } else if (
        electronicsTiles.has(`${tileCol - 1},${tileRow}`) ||
        electronicsTiles.has(`${tileCol + 1},${tileRow}`)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Random-pick a seat from a candidate list, biased toward seats that face an
   * electronics tile. Returns null when the candidate list is empty.
   */
  private pickFromSeats(seatUids: string[], electronicsTiles: Set<string>): string | null {
    if (seatUids.length === 0) return null;
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const uid of seatUids) {
      const seat = this.seats.get(uid);
      if (!seat) continue;
      if (this.isSeatFacingElectronics(seat, electronicsTiles)) {
        pcSeats.push(uid);
      } else {
        otherSeats.push(uid);
      }
    }
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * 3-stage seat picker for top-level agents.
   *
   *   Stage 1: If `directoryName` is given and `areaMappings[directoryName]` lists
   *            Area labels, prefer free seats whose tile is labeled with one
   *            of those areas.
   *   Stage 2: Prefer free seats whose tile has NO area label (unzoned).
   *   Stage 3: Any free seat.
   *
   * Each stage routes through `pickFromSeats` for the PC-bias rule. Returns
   * null only when every seat is already occupied. Passing `undefined`
   * preserves pre-Areas single-stage behavior (skips Stage 1; Stage 2 picks
   * unzoned seats from a layout without `areaTiles`, which is every seat).
   */
  private findFreeSeat(directoryName?: string): string | null {
    const electronicsTiles = this.buildElectronicsTileSet();
    const freeSeats: string[] = [];
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned) freeSeats.push(uid);
    }
    if (freeSeats.length === 0) return null;

    const areaLabels = directoryName ? this.areaMappings[directoryName] : undefined;

    // Stage 1 — in-area seats for the Directory's mapped Area labels.
    if (areaLabels && areaLabels.length > 0) {
      const wanted = new Set(areaLabels);
      const inArea = freeSeats.filter((uid) => {
        const label = this.seatZone(uid);
        return label !== null && wanted.has(label);
      });
      const pick = this.pickFromSeats(inArea, electronicsTiles);
      if (pick) return pick;
    }

    // Stage 2 — unzoned seats (no area label, or layout has no areas at all).
    const unzoned = freeSeats.filter((uid) => this.seatZone(uid) === null);
    const pick2 = this.pickFromSeats(unzoned, electronicsTiles);
    if (pick2) return pick2;

    // Living office — desks before the rooms: seats outside every routed zone
    // (the Dev room), then the Cafe/Lounge overflow (DESIGN.md, Crowding). A
    // layout without zones goes straight on to stage 3, as it always has.
    if (this.zones.zones.size > 0) {
      const desks = freeSeats.filter(this.isDeskSeat);
      const deskPick = this.pickFromSeats(desks, electronicsTiles);
      if (deskPick) return deskPick;
      const overflow = freeSeats.filter((uid) => {
        const zone = toZoneLabel(this.seatZone(uid));
        return zone === ZoneLabel.CAFE || zone === ZoneLabel.LOUNGE;
      });
      const overflowPick = this.pickFromSeats(overflow, electronicsTiles);
      if (overflowPick) return overflowPick;
    }

    // Stage 3 — any free seat.
    return this.pickFromSeats(freeSeats, electronicsTiles);
  }

  /** Living office: is this seat a desk rather than a room's seat (sofa,
   *  meeting chair, café bench)? Every seat is, in a layout without zones. */
  private readonly isDeskSeat = (uid: string): boolean => !isRoutedZoneLabel(this.seatZone(uid));

  /** The desks-first preference for the nearest-seat pickers (helpers,
   *  teammates); undefined — no preference, as before — without zones. */
  private deskPreference(): ((uid: string) => boolean) | undefined {
    return this.zones.zones.size > 0 ? this.isDeskSeat : undefined;
  }

  /** Closest walkable tile to (col,row) not occupied by another character, or null. */
  private closestFreeWalkableTile(col: number, row: number): { col: number; row: number } | null {
    const occupied = new Set<string>();
    for (const ch of this.characters.values()) {
      occupied.add(`${ch.tileCol},${ch.tileRow}`);
    }
    let best: { col: number; row: number } | null = null;
    let bestDist = Infinity;
    for (const tile of this.walkableTiles) {
      if (occupied.has(`${tile.col},${tile.row}`)) continue;
      const d = Math.abs(tile.col - col) + Math.abs(tile.row - row);
      if (d < bestDist) {
        best = tile;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const paletteCount = getLoadedCharacterCount();
    const counts = new Array(paletteCount).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (ch.palette < paletteCount) counts[ch.palette]++;
    }
    return pickDiversePalette(paletteCount, counts);
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    directoryName?: string,
    nearAgentId?: number,
  ): void {
    const existing = this.characters.get(id);
    if (existing) {
      // An agent back before its old character finished walking out takes over.
      if (!existing.leaving) return;
      this.characters.delete(id);
    }

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then (for teammates) the seat closest to the
    // anchor agent, then any free seat. anchorTile resolves to the anchor's SEAT
    // (stable from creation) rather than its live tile, so a teammate placed while
    // the lead is still walking to its seat still clusters around the final seat.
    const anchor = nearAgentId !== undefined ? this.characters.get(nearAgentId) : undefined;
    const anchorAt = anchorTile(anchor, this.seats);
    let seatId: string | null = null;
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      } else {
        // A helper keeping the agent's own (restored) seat warm gives it back.
        seatId = this.reclaimHelperSeat(preferredSeatId);
      }
    }
    if (!seatId && anchorAt) {
      seatId = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row, this.deskPreference());
    }
    if (!seatId) {
      seatId = this.findFreeSeat(directoryName);
    }
    if (!seatId) {
      // Office full: agents outrank helpers, so take one of theirs.
      seatId = this.reclaimHelperSeat();
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
    } else {
      // No seats — teammates spawn beside their anchor, others at a random walkable tile
      let spawn = anchorAt ? this.closestFreeWalkableTile(anchorAt.col, anchorAt.row) : null;
      if (!spawn) {
        spawn =
          this.walkableTiles.length > 0
            ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
            : { col: 1, row: 1 };
      }
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (directoryName) {
      ch.directoryName = directoryName;
    }
    if (this.sleepingAgents.has(id)) {
      ch.isSleeping = true;
      this.idleIfAsleep(ch);
    }
    if (!skipSpawnEffect) {
      startMatrixEffect(ch, 'spawn');
    }
    this.characters.set(id, ch);
  }

  /**
   * Free a seat a helper (sub-agent) holds, for a top-level agent: `seatId`
   * when a helper sits there (the agent's own restored seat), else any
   * helper's seat (the office is full). Agents outrank helpers. The helper
   * moves to another free seat near its parent if there is one, else stands
   * beside the parent — where helpers stood before they took seats. Returns
   * the freed seat (now unassigned), or null when no helper holds one.
   */
  private reclaimHelperSeat(seatId?: string): string | null {
    let helper: Character | undefined;
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent || !ch.seatId || ch.matrixEffect === 'despawn') continue;
      if (seatId === undefined || ch.seatId === seatId) {
        helper = ch;
        break;
      }
    }
    if (!helper?.seatId) return null;
    const freed = helper.seatId;
    const parent =
      helper.parentAgentId !== null ? this.characters.get(helper.parentAgentId) : undefined;
    // Still marked assigned while choosing, so the helper can't pick it again.
    const next = helperSeat(parent, this.seats, this.deskPreference());
    let target: { col: number; row: number } | null;
    if (next) {
      const seat = this.seats.get(next)!;
      seat.assigned = true;
      helper.seatId = next;
      target = { col: seat.seatCol, row: seat.seatRow };
    } else {
      helper.seatId = null;
      const near = anchorTile(parent, this.seats) ?? { col: helper.tileCol, row: helper.tileRow };
      target = this.closestFreeWalkableTile(near.col, near.row);
    }
    const freedSeat = this.seats.get(freed);
    if (freedSeat) freedSeat.assigned = false;
    if (!target) return freed;
    // Off the chair it sits on (blocked to everyone now — findPath checks only
    // the tiles it steps onto, so it can leave one) to the new spot.
    const sub = helper;
    const to = target;
    const path = this.withOwnSeatUnblocked(sub, () =>
      findPath(sub.tileCol, sub.tileRow, to.col, to.row, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      sub.path = path;
      sub.moveProgress = 0;
      sub.state = CharacterState.WALK;
      sub.frame = 0;
      sub.frameTimer = 0;
    } else {
      // No way across: it simply reappears there.
      sub.tileCol = to.col;
      sub.tileRow = to.row;
      sub.x = to.col * TILE_SIZE + TILE_SIZE / 2;
      sub.y = to.row * TILE_SIZE + TILE_SIZE / 2;
      sub.path = [];
      if (next) sub.dir = this.seats.get(next)!.facingDir;
    }
    return freed;
  }

  // ── Greeter ───────────────────────────────────────────────────
  // The Intro is diegetic: a char_0 character stands near the office's
  // bottom-left corner and "speaks" the tour through a DOM bubble
  // (IntroBubble). It is not an agent — see the `greeter` field.

  /** Spawn the greeter near the office's bottom-left corner: target tile
   *  GREETER_TILE_MARGIN in from the left and bottom edges, falling
   *  back to the closest walkable tile when the target is a seat, furniture,
   *  a wall, or VOID (seat tiles are in blockedTiles, so closestFreeWalkableTile
   *  covers every one of those). Idempotent; a remount mid-despawn (StrictMode)
   *  revives it. */
  spawnGreeter(): void {
    this.greeterCameraCancelled = false;
    if (this.greeter) {
      if (this.greeter.matrixEffect === 'despawn') startMatrixEffect(this.greeter, 'spawn');
      return;
    }
    const spawn = this.closestFreeWalkableTile(
      GREETER_TILE_MARGIN,
      this.layout.rows - 1 - GREETER_TILE_MARGIN,
    );
    if (!spawn) return; // no walkable tile — IntroBubble falls back to a fixed panel
    const ch = createCharacter(GREETER_ID, 0, null, null, 0);
    ch.isGreeter = true;
    ch.state = CharacterState.IDLE;
    ch.isActive = false;
    ch.dir = Direction.DOWN;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    startMatrixEffect(ch, 'spawn');
    this.greeter = ch;
  }

  /** Start the greeter's despawn effect and release the greeter camera. The
   *  character is dropped once the effect finishes (see update()).
   *  Idempotent — every close path (answer, Escape, hooksStatus) funnels here. */
  despawnGreeter(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = false;
    if (!this.greeter || this.greeter.matrixEffect === 'despawn') return;
    startMatrixEffect(this.greeter, 'despawn');
  }

  /** Per-frame update from the bubble overlay; ignored once the user panned. */
  setGreeterCameraTarget(p: { x: number; y: number }): void {
    if (!this.greeterCameraCancelled) this.greeterCameraTarget = p;
  }

  /** Manual pan during the ask: stop re-centering until the next spawn. */
  cancelGreeterCamera(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = true;
  }

  /** Every manual pan (mouse, wheel, touch) takes the camera back from both
   *  automatic drivers: character follow and the greeter's ask. */
  breakCameraFollow(): void {
    this.cameraFollowId = null;
    this.cancelGreeterCamera();
  }

  /** Select an agent's character and have the camera follow it — what a card
   *  tap does to the office. No-op for an agent with no character. */
  selectAndFollow(id: number): void {
    if (!this.characters.has(id)) return;
    this.selectedAgentId = id;
    this.cameraFollowId = id;
  }

  /** The agent that owns `id`'s terminal: a sub-agent's parent, else itself. */
  terminalOwnerOf(id: number): number {
    return this.subagentMeta.get(id)?.parentAgentId ?? id;
  }

  removeAgent(id: number): void {
    this.agentZoneSignals.delete(id);
    this.destinationIntents.delete(id);
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn' || ch.leaving) return; // already despawning / leaving
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    this.releaseZoneTarget(ch);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    ch.bubbleType = null;
    // Living office: walk out through the Entrance door, despawning there.
    if (this.walkOut(ch)) return;
    // Start despawn animation instead of immediate delete
    startMatrixEffect(ch, 'despawn');
  }

  // ── Living office: entrance ───────────────────────────────────

  /**
   * A NEW agent (a live agentCreated, not a restore) comes in through the
   * Entrance door: it materializes there and walks to its desk. Without a
   * door, a seat, or a way from one to the other, it stays where addAgent put
   * it — at its desk, as before. Either way the arrival time is kept, so a
   * session that closes again within TRANSIENT_SESSION_SEC skips the walk out.
   */
  enterThroughDoor(id: number): void {
    const ch = this.characters.get(id);
    const door = this.zones.door;
    if (!ch || !door || ch.isSubagent || ch.leaving) return;
    ch.enteredAt = this.officeClock;
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(door.col, door.row, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return;
    ch.tileCol = door.col;
    ch.tileRow = door.row;
    ch.x = door.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = door.row * TILE_SIZE + TILE_SIZE / 2;
    ch.dir = door.inward;
    // The spawn effect plays at the door first (the FSM waits for it).
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    // ...and the receptionist waves it in.
    if (this.receptionist) this.receptionistWaveAt = this.officeClock;
  }

  /**
   * Send a removed agent out through the Entrance door; it despawns on
   * arrival (update()). False — despawn on the spot, as before — without a
   * door or a way to it, mid spawn effect, or for a transient session.
   */
  private walkOut(ch: Character): boolean {
    const door = this.zones.door;
    if (!door || ch.isSubagent || ch.matrixEffect) return false;
    if (ch.enteredAt !== undefined && this.officeClock - ch.enteredAt < TRANSIENT_SESSION_SEC) {
      return false;
    }
    const atDoor = ch.tileCol === door.col && ch.tileRow === door.row;
    const path = findPath(
      ch.tileCol,
      ch.tileRow,
      door.col,
      door.row,
      this.tileMap,
      this.blockedTiles,
    );
    if (path.length === 0 && !atDoor) return false;
    ch.seatId = null; // freed by removeAgent
    ch.leaving = true;
    ch.isActive = false;
    ch.zoneTarget = {
      zone: ZoneLabel.ENTRANCE,
      key: DOOR_TARGET_KEY,
      col: door.col,
      row: door.row,
      facing: door.outward,
      sit: false,
      shared: true,
    };
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = path.length > 0 ? CharacterState.WALK : CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /**
   * Move a just-linked teammate to the free seat closest to its lead, so teams
   * cluster. Only moves when that seat is strictly closer than the teammate's
   * current one — a teammate created as a plain external agent (seated by an
   * arbitrary findFreeSeat) and tagged as a teammate only after tag discovery
   * would otherwise keep its arbitrary seat, unlike an inline teammate seated
   * next to the lead at creation.
   */
  private reseatNextToLead(teammateId: number, leadId: number): void {
    const teammate = this.characters.get(teammateId);
    const lead = this.characters.get(leadId);
    if (!teammate || !lead) return;
    const anchorAt = anchorTile(lead, this.seats);
    if (!anchorAt) return;
    const target = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row, this.deskPreference());
    if (!target || target === teammate.seatId) return;
    const targetSeat = this.seats.get(target)!;
    const targetDist =
      Math.abs(targetSeat.seatCol - anchorAt.col) + Math.abs(targetSeat.seatRow - anchorAt.row);
    const currentSeat = teammate.seatId ? this.seats.get(teammate.seatId) : undefined;
    const currentDist = currentSeat
      ? Math.abs(currentSeat.seatCol - anchorAt.col) + Math.abs(currentSeat.seatRow - anchorAt.row)
      : Infinity;
    if (targetDist < currentDist) {
      this.reassignSeat(teammateId, target);
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /**
   * Create a sub-agent character with the parent's palette. Returns the sub-agent ID.
   *
   * A helper gets a desk of its own: it materializes beside its parent and
   * walks to the free seat nearest the parent's seat (seatPlacement.helperSeat),
   * where it types like any agent — instead of crowding the parent's desk. With
   * no seat free it stays beside the parent and types in place. Its seat is
   * freed by removeSubagent / removeAllSubagents, and handed over to a
   * top-level agent that finds the office full (reclaimHelperSeat).
   */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;

    // Find the closest walkable tile to the parent, avoiding tiles occupied by other characters
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    let spawn = { col: parentCol, row: parentRow };
    if (this.walkableTiles.length > 0) {
      spawn = this.closestFreeWalkableTile(parentCol, parentRow) ?? this.walkableTiles[0];
    }

    const ch = createCharacter(id, palette, null, null, hueShift);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;

    const seatId = helperSeat(parentCh, this.seats, this.deskPreference());
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch.seatId = seatId;
      const path = this.withOwnSeatUnblocked(ch, () =>
        findPath(spawn.col, spawn.row, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
      );
      if (path.length > 0) {
        // Walk over once the spawn effect has played (the FSM waits for it).
        ch.path = path;
        ch.state = CharacterState.WALK;
      } else {
        // No way there from beside the parent: appear in the seat instead.
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }
    startMatrixEffect(ch, 'spawn');
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      startMatrixEffect(ch, 'despawn');
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          startMatrixEffect(ch, 'despawn');
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        if (this.cameraFollowId === id) this.cameraFollowId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      if (!active) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (!seat) continue;
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        autoOnTiles.add(`${tileCol},${tileRow}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`);
          autoOnTiles.add(`${baseCol},${baseRow + 1}`);
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`);
          autoOnTiles.add(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    // Living office: the Server room's racks blink while someone works there.
    if (this.zones.rackTiles.length > 0) {
      for (const ch of this.characters.values()) {
        if (ch.zoneTarget?.zone === ZoneLabel.SERVER && isSettledAtZoneTarget(ch)) {
          for (const key of this.zones.rackTiles) autoOnTiles.add(key);
          break;
        }
      }
    }

    // ...and its ashtray fills with butts while people wait on the user.
    // Phase B: a celebration bell rings on a desk; trophies stand on the shelves.
    // Fun: festival decorations, pizza, growing plants, the fish tank, the printer...
    // Ambience (officeAmbience.ts): the windows show the time of day, the
    // clocks the time, and each occupied Dev desk its agent's name plate.
    const now = this.ambienceNow();
    const placed = furnitureAt(this.fun.decorate(this.placedWithTrophies()), now);
    const butts = [
      ...this.ashtrayButtInstances(),
      ...this.celebrations.bellInstances(),
      ...namePlateInstances(this, this.characters.values()),
    ];

    if (autoOnTiles.size === 0) {
      const plain = withLiveClocks(layoutToFurnitureInstances(placed), now);
      this.furniture = butts.length > 0 ? [...plain, ...butts] : plain;
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const modifiedFurniture: PlacedFurniture[] = placed.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            let onType = getOnStateType(item.type);
            if (onType !== item.type) {
              // Check if the on-state type has animation frames
              const frames = getAnimationFrames(onType);
              if (frames && frames.length > 1) {
                const frameIdx = animFrame % frames.length;
                onType = frames[frameIdx];
              }
              return { ...item, type: onType };
            }
            return item;
          }
        }
      }
      return item;
    });

    const instances = withLiveClocks(layoutToFurnitureInstances(modifiedFurniture), now);
    this.furniture = butts.length > 0 ? [...instances, ...butts] : instances;
  }

  // ── Living office phase B: celebrations (celebrations.ts) ──────
  /** A push or PR landed: bell + confetti at whoever shipped it; the trophy
   *  wall follows the day's tally. Returns how many new ship events there were. */
  celebrate(stats: DailyStats): number {
    const events = this.celebrations.onDailyStats(stats, {
      nowMs: this.nowMs(),
      characters: this.characters,
      seats: this.seats,
      furniture: this.layout.furniture,
      entryOf: getCatalogEntry,
    });
    this.rebuildFurnitureInstances();
    return events.length;
  }

  /** The layout's furniture plus today's trophies (runtime-only, never saved). */
  private placedWithTrophies(): PlacedFurniture[] {
    const footprint = (type: string) => {
      const e = getCatalogEntry(type);
      return e ? { w: e.footprintW, h: e.footprintH } : undefined;
    };
    const { prCount, pushCount } = this.celebrations;
    return withTrophies(this.layout, footprint, prCount, pushCount);
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
      // The Meeting-room signal, kept apart from the bubble: clicking the
      // bubble away doesn't answer the request.
      if (!ch.isSubagent) this.zoneSignalsFor(id).permission = true;
    }
  }

  clearPermissionBubble(id: number): void {
    const signals = this.agentZoneSignals.get(id);
    if (signals) signals.permission = false;
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number, awaitingInput = false): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.waitingAwaitingInput = awaitingInput;
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  // ── Pets ──────────────────────────────────────────────────────

  /**
   * Add a pet to the live runtime. Spawns at a uniformly-random walkable tile.
   * Mirror in `this.layout.pets` so debounced saveLayout serialises the roster.
   * Bounds-checks petType against the loaded sprite count to defend against stale layouts.
   */
  addPet(placedPet: PlacedPet): void {
    // Defensive guards (upstream 5e6c0a0)
    if (
      typeof placedPet.id !== 'string' ||
      placedPet.id.length === 0 ||
      placedPet.id.length > MAX_PET_ID_LENGTH
    ) {
      return;
    }
    if (
      !Number.isInteger(placedPet.petType) ||
      placedPet.petType < 0 ||
      placedPet.petType >= getPetCount()
    ) {
      return;
    }
    if (this.pets.some((p) => p.id === placedPet.id)) return; // de-dupe
    if (this.walkableTiles.length === 0) return; // no spawn space — silently drop

    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    const pet = createPet(placedPet.id, placedPet.petType, spawn.col, spawn.row);
    pet.name = getPetName(placedPet.petType);
    this.pets.push(pet);
    this.syncLayoutPets();
  }

  /** Remove a pet by id. Idempotent. */
  removePet(id: string): void {
    const before = this.pets.length;
    this.pets = this.pets.filter((p) => p.id !== id);
    if (this.pets.length !== before) {
      this.syncLayoutPets();
    }
  }

  /** Shallow snapshot for external consumers (renderer, hooks). */
  getPets(): Pet[] {
    return this.pets.slice();
  }

  /** Unique petType values currently placed. Used by the Pets toolbar to mark active rows. */
  getActivePetTypes(): number[] {
    const seen = new Set<number>();
    for (const p of this.pets) seen.add(p.petType);
    return Array.from(seen);
  }

  /**
   * Hit-test pets at a pixel world position. Sorts back-to-front (largest y wins on tie)
   * so the visually-frontmost pet receives the click.
   * Returns the pet id or null.
   */
  getPetAt(worldX: number, worldY: number): string | null {
    const ordered = this.pets.slice().sort((a, b) => b.y - a.y);
    for (const pet of ordered) {
      const left = pet.x - PET_HIT_HALF_WIDTH;
      const right = pet.x + PET_HIT_HALF_WIDTH;
      const top = pet.y - PET_HIT_HEIGHT;
      const bottom = pet.y;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return pet.id;
      }
    }
    return null;
  }

  /** Show the heart bubble on a pet for WAITING_BUBBLE_DURATION_SEC. */
  showPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet) return;
    pet.bubbleType = 'heart';
    pet.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  }

  /** Dismiss the heart bubble on click; collapses timer to a fast fade. */
  dismissPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet || !pet.bubbleType) return;
    pet.bubbleTimer = Math.min(pet.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
  }

  /**
   * Reconcile `this.pets` to match the layout's placed-pet roster.
   * - Pets in layout but not in runtime → spawn via addPet().
   * - Pets in runtime but not in layout → remove.
   * - Pets in both → keep existing runtime state (position, FSM).
   *
   * Called from constructor and rebuildFromLayout. Always runs AFTER walkableTiles
   * is populated.
   */
  private rebuildPetsFromLayout(layout: OfficeLayout): void {
    const placed = layout.pets ?? [];
    const placedIds = new Set(placed.map((p) => p.id));

    // 1. Remove pets no longer in layout
    this.pets = this.pets.filter((p) => placedIds.has(p.id));

    // 2. Add pets that exist in layout but not in runtime
    const existingIds = new Set(this.pets.map((p) => p.id));
    for (const p of placed) {
      if (existingIds.has(p.id)) continue;
      this.addPet(p); // pushes onto this.pets, calls syncLayoutPets()
    }
    // syncLayoutPets() inside addPet keeps this.layout.pets coherent; one final
    // sync handles the removal-only branch where addPet was never called.
    this.syncLayoutPets();
  }

  /**
   * Re-export the current pet roster into `this.layout.pets`. Called only from
   * mutating methods (addPet / removePet / rebuildPetsFromLayout) — NEVER from
   * getLayout(), which runs on every render frame.
   */
  private syncLayoutPets(): void {
    this.layout.pets = this.pets.map((p) => ({ id: p.id, petType: p.petType }));
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const wasUnlinked = ch.leadAgentId === undefined;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
    // A teammate is not a headless agent: clicking it focuses its lead's terminal.
    // Adopted sessions are marked headless at creation and only later discovered
    // to be teammates, so drop the mark once the link lands.
    if (leadAgentId !== undefined) {
      ch.isHeadless = false;
    }
    // A teammate discovered only after its plain external session was adopted is
    // linked here, not at creation, so it never went through the seat-next-to-lead
    // path addAgent runs for inline teammates. Cluster it now, once, on first link.
    if (wasUnlinked && leadAgentId !== undefined && !isTeamLead) {
      this.reseatNextToLead(id, leadAgentId);
    }
  }

  /** Mark an agent as headless (adopted, no terminal to focus). */
  setHeadless(id: number, headless: boolean): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.isHeadless = headless;
  }

  /**
   * Put an agent to sleep (session open but idle) or wake it. Remembered by
   * id even before the character exists. A sleeper that's up and wandering
   * heads back to its seat (the FSM keeps it there, dimmed, until it wakes);
   * waking takes effect on the next frame — the renderer and the FSM read
   * the flag live.
   */
  setAgentSleeping(id: number, sleeping: boolean): void {
    if (sleeping) this.sleepingAgents.add(id);
    else this.sleepingAgents.delete(id);
    const ch = this.characters.get(id);
    if (!ch || (ch.isSleeping ?? false) === sleeping) return;
    ch.isSleeping = sleeping;
    if (sleeping) this.idleIfAsleep(ch);
    // (A character the living office has sent somewhere is routed from there.)
    if (sleeping && !ch.isActive && ch.state !== CharacterState.TYPE && !ch.zoneTarget) {
      this.sendToSeat(id);
    }
  }

  /**
   * The server only reports a session asleep once Claude's own session list
   * calls it idle and its transcript has been quiet for a while, so asleep
   * means not working — even for a long-idle session adopted from the list,
   * which never sent an agentStatus and so still has the default
   * isActive=true. Live tools win: that's activity the wake hasn't reached yet.
   */
  private idleIfAsleep(ch: Character): void {
    if (this.zoneSignalsFor(ch.id).tools.size === 0) ch.isActive = false;
  }

  // ── Living office: the destination engine's signals ────────────
  // What the rules read beyond the character's own flags (isActive,
  // isSleeping): live tools, a pending permission, the stage-track phase.
  // Kept by agent id, like sleepingAgents — messages can precede the character.

  private zoneSignalsFor(id: number): AgentZoneSignals {
    let signals = this.agentZoneSignals.get(id);
    if (!signals) {
      signals = {
        tools: new Map(),
        permission: false,
        smokeBreak: NO_SMOKE_BREAK,
        coffeeRun: NO_COFFEE_RUN,
      };
      this.agentZoneSignals.set(id, signals);
    }
    return signals;
  }

  /** agentToolStart: a tool is live (permissionActive: it already waits on a permission). */
  noteToolStart(
    id: number,
    toolId: string,
    toolName: string | null,
    permissionActive: boolean,
  ): void {
    const signals = this.zoneSignalsFor(id);
    if (!signals.tools.has(toolId)) {
      signals.tools.set(toolId, { name: toolName, startedAt: this.officeClock });
    }
    if (permissionActive) signals.permission = true;
  }

  /** agentToolDone: the tool is no longer live. */
  noteToolDone(id: number, toolId: string): void {
    this.agentZoneSignals.get(id)?.tools.delete(toolId);
  }

  /** agentToolsClear: no tool is live any more. */
  clearAgentTools(id: number): void {
    this.agentZoneSignals.get(id)?.tools.clear();
  }

  /** agentProgress: the stage track's current phase (explore/build/test/ship),
   *  and when its current wait on the user began (epoch ms; undefined if not waiting). */
  setAgentProgress(id: number, phase: string | undefined, waitingSince?: number): void {
    const signals = this.zoneSignalsFor(id);
    signals.phase = phase;
    signals.waitingSince = waitingSince;
  }

  /** agentLimit: paused by a usage limit, it waits at its desk (not the Smoke spot). */
  setAgentPaused(id: number, paused: boolean): void {
    if (!paused && !this.agentZoneSignals.has(id)) return;
    this.zoneSignalsFor(id).paused = paused;
  }

  // ── Living office: the destination engine ──────────────────────
  // Per frame, for each top-level character: the rules pick a destination
  // (zoneRouting.pickDestination), hysteresis decides whether to switch to it
  // yet (holdDestination), and crowding picks the free place (choosePlace).
  // The character then walks there under the FSM's zone branch. Desk and idle
  // destinations hand it back to the desk FSM — today's behaviour.

  private buildZones(): OfficeZones {
    return parseZones({
      cols: this.layout.cols,
      rows: this.layout.rows,
      areaTiles: this.layout.areaTiles,
      furniture: this.layout.furniture,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      seats: this.seats,
      footprint: (type) => {
        const entry = getCatalogEntry(type);
        return entry
          ? { w: entry.footprintW, h: entry.footprintH, bgRows: entry.backgroundTiles ?? 0 }
          : undefined;
      },
    });
  }

  /** Before a layout rebuild: forget every route. Seats are rebuilt and
   *  reassigned wholesale, so nothing is released; characters on their way
   *  out finish leaving on the spot (their way out may be gone). */
  private resetZoneRouting(): void {
    this.destinationIntents.clear();
    this.reservedSpots.clear();
    for (const ch of this.characters.values()) {
      if (!ch.zoneTarget) continue;
      ch.zoneTarget = null;
      ch.path = [];
      ch.moveProgress = 0;
      if (ch.leaving) {
        if (!ch.matrixEffect) startMatrixEffect(ch, 'despawn');
        continue;
      }
      ch.state = CharacterState.IDLE;
      ch.frame = 0;
      ch.frameTimer = 0;
    }
  }

  /** The rules' inputs for a character, stepping its mid-work break scheduler (once a frame). */
  private destinationSignals(ch: Character): DestinationSignals {
    const signals = this.zoneSignalsFor(ch.id);
    const now = this.officeClock;
    const tools = liveToolSignals(signals.tools.values(), signals.phase, now);
    // Asleep only counts while not working — the desk FSM's reading too.
    const sleeping = (ch.isSleeping ?? false) && !ch.isActive;
    signals.smokeBreak = stepSmokeBreak(
      signals.smokeBreak,
      {
        now,
        active: ch.isActive,
        liveTools: signals.tools.size,
        blocked: signals.permission || tools.askingUser || sleeping,
        smokeFree: this.hasFreeSmokeSpot(ch),
      },
      this.zoneRandom,
    );
    const onBreak = onSmokeBreak(signals.smokeBreak, now);
    // A coffee run: never with someone needing the user, tests, sleep or a smoke.
    signals.coffeeRun = stepCoffeeRun(
      signals.coffeeRun,
      {
        now,
        active: ch.isActive,
        liveTools: signals.tools.size,
        blocked:
          signals.permission ||
          tools.askingUser ||
          tools.testing ||
          tools.longCommand ||
          onBreak ||
          sleeping,
        counterFree: this.hasFreeCounterPlace(ch),
        atCounterSec:
          ch.zoneTarget?.zone === ZoneLabel.CAFE && isSettledAtZoneTarget(ch)
            ? (ch.zoneFxTimer ?? 0)
            : 0,
      },
      this.coffeeRandom,
    );
    ch.carryingCup = carryingCup(signals.coffeeRun, now) || undefined;
    return {
      sleeping,
      permission: signals.permission,
      ...tools,
      onBreak,
      coffeeRun: onCoffeeRun(signals.coffeeRun),
      active: ch.isActive,
      waiting: !ch.isActive,
      paused: signals.paused === true,
    };
  }

  /** Is a Café counter place free for this character (its own counts)? */
  private hasFreeCounterPlace(ch: Character): boolean {
    const cafe = this.coffeeCounter.zones.get(ZoneLabel.CAFE);
    return cafe !== undefined && cafe.places.some((p) => !this.isPlaceTaken(p, ch));
  }

  /** Is a Smoke spot free for this character (its own counts)? */
  private hasFreeSmokeSpot(ch: Character): boolean {
    const smoke = this.zones.zones.get(ZoneLabel.SMOKE);
    return smoke !== undefined && smoke.places.some((p) => !this.isPlaceTaken(p, ch));
  }

  private routeCharacter(ch: Character): void {
    // Fun: a ritual or pastime (standup, whiteboard, ping-pong, ...) borrows it.
    const borrowed = this.fun.targetFor(ch);
    if (borrowed) {
      if (this.stubbingOut(ch)) return;
      this.destinationIntents.delete(ch.id); // routing starts afresh once it's let go
      ch.smokeBreak = undefined;
      this.setZoneTarget(ch, borrowed);
      return;
    }
    const signals = this.destinationSignals(ch);
    const anshDoor = (this.zones.zones.get(ZoneLabel.ANSH)?.places.length ?? 0) > 0;
    const intent = this.holdIntent(ch, pickDestination(signals, { anshDoor }));
    this.actOnIntent(ch, intent);
    // Mid-work smokers get a tag on their label; a smoke while waiting doesn't.
    ch.smokeBreak =
      intent.kind === Destination.BREAK && ch.isActive && ch.zoneTarget?.zone === ZoneLabel.SMOKE
        ? signals.longCommand
          ? 'command'
          : 'break'
        : undefined;
  }

  /** Hysteresis: the destination to act on now, given the one the rules want. */
  private holdIntent(ch: Character, wanted: Destination): RoutedIntent {
    const now = this.officeClock;
    const current = this.destinationIntents.get(ch.id);
    const next = holdDestination(current, wanted, now);
    if (current && next === current) return current;
    const intent: RoutedIntent = { ...next, resolved: false, retryAt: now };
    this.destinationIntents.set(ch.id, intent);
    return intent;
  }

  private actOnIntent(ch: Character, intent: RoutedIntent): void {
    const now = this.officeClock;
    if (now < intent.retryAt) return;
    if (isSmokeDestination(intent.kind)) {
      // Back for another before leaving the spot: light a fresh one.
      if (ch.smokeStubAt !== undefined) {
        ch.smokeStubAt = undefined;
        ch.zoneFxTimer = 0;
      }
    } else if (this.stubbingOut(ch)) {
      return; // called away: it puts the cigarette out first
    }
    if (intent.kind === Destination.DESK) {
      // Its own desk: the desk FSM while it works. Between turns — the switch
      // away still held back — it waits there, seated, rather than wandering.
      this.setZoneTarget(ch, ch.isActive || ch.isSleeping ? null : this.ownDeskTarget(ch));
      intent.resolved = true;
      return;
    }
    if (intent.resolved) return;
    this.resolveIntent(ch, intent);
  }

  /**
   * A smoker called away (work resumed, a meeting, ...) stubs its cigarette
   * out first: it turns to the ashtray beside its spot — every Smoke spot is
   * next to one — and the ember fades for SMOKE_STUB_OUT_SEC. True while that
   * is under way. Not lit yet (still at the lighter): it just goes.
   */
  private stubbingOut(ch: Character): boolean {
    if (!isSmoking(ch)) return false;
    const t = ch.zoneFxTimer ?? 0;
    if (ch.smokeStubAt === undefined) {
      if (t < SMOKE_LIGHT_UP_SEC) return false;
      ch.smokeStubAt = t;
    }
    return t - ch.smokeStubAt < SMOKE_STUB_OUT_SEC;
  }

  private resolveIntent(ch: Character, intent: RoutedIntent): void {
    const choice = this.choosePlaceFor(ch, intent.kind);
    if (choice.kind === 'absent') {
      // Desk, idle, or a room this layout doesn't have: the desk FSM.
      this.setZoneTarget(ch, null);
      intent.resolved = true;
      return;
    }
    if (choice.kind === 'full') {
      // Every place taken: stay at the desk. Working and sleeping agents do
      // under the desk FSM; a waiting one sits there, still, rather than
      // wandering off. Look again in a moment — a place may free up.
      this.setZoneTarget(ch, ch.isActive || ch.isSleeping ? null : this.ownDeskTarget(ch));
      intent.retryAt = this.officeClock + ZONE_RETRY_INTERVAL_SEC;
      return;
    }
    this.setZoneTarget(ch, { ...choice.place }, choice.path);
    intent.resolved = true;
  }

  /** choosePlace, skipping places this character can't walk to. */
  private choosePlaceFor(
    ch: Character,
    kind: Destination,
  ):
    | Exclude<PlaceChoice, { kind: 'place' }>
    | { kind: 'place'; place: ZoneTarget; path: Array<{ col: number; row: number }> } {
    const unreachable = new Set<string>();
    for (;;) {
      const choice = choosePlace(
        kind === Destination.COFFEE ? this.coffeeCounter : this.zones,
        kind,
        { col: ch.tileCol, row: ch.tileRow },
        (place) => unreachable.has(place.key) || this.isPlaceTaken(place, ch),
      );
      if (choice.kind !== 'place') return choice;
      const { place } = choice;
      const path = this.pathForTarget(ch, place);
      if (path.length > 0 || (ch.tileCol === place.col && ch.tileRow === place.row)) {
        return { kind: 'place', place, path };
      }
      unreachable.add(place.key);
    }
  }

  /** Can the character walk to that place from where it stands? (Fun picks places with it.) */
  canReach(ch: Character, target: { col: number; row: number; sit: boolean }): boolean {
    if (ch.tileCol === target.col && ch.tileRow === target.row) return true;
    return this.pathForTarget(ch, target).length > 0;
  }

  /** In use by someone else: a seat held as a desk or a destination, a reserved spot. */
  private isPlaceTaken(place: ZoneTarget, ch: Character): boolean {
    if (ch.zoneTarget?.key === place.key) return false; // its own
    if (place.sit) return this.seats.get(place.key)?.assigned ?? true;
    const holder = this.reservedSpots.get(place.key);
    return holder !== undefined && holder !== ch.id;
  }

  /** "Wait at your own desk" (every zone place taken), or null without a seat. */
  private ownDeskTarget(ch: Character): ZoneTarget | null {
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    if (!seat) return null;
    return {
      zone: null,
      key: seat.uid,
      col: seat.seatCol,
      row: seat.seatRow,
      facing: seat.facingDir,
      sit: true,
      shared: true,
    };
  }

  /**
   * Point a character at a zone target (reserving it) or back at the desk FSM
   * (null), releasing whatever it held. A no-op when nothing changes, so a
   * character the living office never sends anywhere is never touched.
   */
  private setZoneTarget(
    ch: Character,
    target: ZoneTarget | null,
    path?: Array<{ col: number; row: number }>,
  ): void {
    const current = ch.zoneTarget ?? null;
    if (current === null && target === null) return;
    if (current && target && current.key === target.key && current.zone === target.zone) return;
    this.releaseZoneTarget(ch);
    if (!target) {
      // Back to the desk FSM, standing where it is: it walks to its seat when
      // working (or asleep), or idles about as it always has.
      ch.path = [];
      ch.moveProgress = 0;
      ch.state = CharacterState.IDLE;
      ch.frame = 0;
      ch.frameTimer = 0;
      return;
    }
    if (!target.shared) {
      if (target.sit) {
        const seat = this.seats.get(target.key);
        if (seat) seat.assigned = true;
      } else {
        this.reservedSpots.set(target.key, ch.id);
      }
    }
    ch.zoneTarget = target;
    ch.zoneFxTimer = 0;
    ch.path = path ?? this.pathForTarget(ch, target);
    ch.moveProgress = 0;
    ch.state = ch.path.length > 0 ? CharacterState.WALK : CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
  }

  /** Drop the character's zone target, freeing its reservation. */
  /** Two or more at the Smoke spots: each turns to the nearest other one
   *  (zoneEffects.socialFacing). One stubbing out keeps facing the ashtray. */
  private faceFellowSmokers(): void {
    const smokers: Array<{ id: number; col: number; row: number }> = [];
    for (const ch of this.characters.values()) {
      if (isSmoking(ch) && ch.smokeStubAt === undefined) {
        smokers.push({ id: ch.id, col: ch.tileCol, row: ch.tileRow });
      }
    }
    if (smokers.length < 2) return;
    for (const [id, dir] of socialFacing(smokers)) {
      const ch = this.characters.get(id);
      if (ch) ch.dir = dir;
    }
  }

  /**
   * The ashtray fills with butts while people wait on the user: one per
   * ASHTRAY_BUTT_WAIT_SEC of the longest current wait among the smokers
   * waiting (agentProgress.waitingSince; without it, their time at the spot).
   * Mid-work smokers don't count. Drawn as tiny furniture on the bowl.
   */
  private ashtrayButtInstances(): FurnitureInstance[] {
    if (this.zones.ashtrays.length === 0) return [];
    let longest: number | null = null;
    for (const ch of this.characters.values()) {
      if (ch.zoneTarget?.zone !== ZoneLabel.SMOKE || ch.isActive || ch.leaving) continue;
      const since = this.agentZoneSignals.get(ch.id)?.waitingSince;
      const wait = since !== undefined ? (this.nowMs() - since) / 1000 : (ch.zoneFxTimer ?? 0);
      if (longest === null || wait > longest) longest = wait;
    }
    const count = ashtrayButtCount(longest);
    if (count === 0) return [];
    const butts: FurnitureInstance[] = [];
    for (const tray of this.zones.ashtrays) {
      const height = getCatalogEntry(tray.type)?.sprite.length ?? TILE_SIZE;
      const zY = tray.row * TILE_SIZE + height + CIGARETTE_Z_SORT_OFFSET; // just over the tray
      for (const slot of ASHTRAY_BUTT_SLOTS.slice(0, count)) {
        butts.push({
          sprite: ASHTRAY_BUTT_SPRITE,
          x: tray.col * TILE_SIZE + slot.x,
          y: tray.row * TILE_SIZE + slot.y,
          zY,
        });
      }
    }
    return butts;
  }

  private releaseZoneTarget(ch: Character): void {
    const target = ch.zoneTarget;
    ch.zoneTarget = null;
    ch.smokeStubAt = undefined;
    ch.smokeBreak = undefined;
    if (!target || target.shared) return;
    if (target.sit) {
      const seat = this.seats.get(target.key);
      if (seat) seat.assigned = false;
    } else if (this.reservedSpots.get(target.key) === ch.id) {
      this.reservedSpots.delete(target.key);
    }
  }

  /** After a zone step: settle effects, the door on the way out, a lost path. */
  private afterZoneStep(ch: Character, dt: number): void {
    const target = ch.zoneTarget;
    if (!target) return;
    if (target.unreachable) {
      if (ch.leaving) {
        ch.zoneTarget = null;
        startMatrixEffect(ch, 'despawn'); // can't reach the door: leave from here
        return;
      }
      this.setZoneTarget(ch, null);
      const intent = this.destinationIntents.get(ch.id);
      if (intent) {
        intent.resolved = false;
        intent.retryAt = this.officeClock + ZONE_RETRY_INTERVAL_SEC;
      }
      return;
    }
    if (!isSettledAtZoneTarget(ch)) return;
    if (ch.leaving) {
      startMatrixEffect(ch, 'despawn'); // out of the door
      return;
    }
    ch.zoneFxTimer = (ch.zoneFxTimer ?? 0) + dt;
  }

  /** Path from where the character stands to a target, its own seat and the
   *  target seat counted walkable (chairs are blocked to everyone else). */
  private pathForTarget(
    ch: Character,
    target: { col: number; row: number; sit: boolean },
  ): Array<{ col: number; row: number }> {
    return this.withTilesUnblocked(
      [this.ownSeatKey(ch), target.sit ? `${target.col},${target.row}` : null],
      () =>
        findPath(ch.tileCol, ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles),
    );
  }

  /** withOwnSeatUnblocked, plus the zone seat the character is headed for. */
  private withRouteUnblocked<T>(ch: Character, fn: () => T): T {
    const target = ch.zoneTarget;
    return this.withTilesUnblocked(
      [this.ownSeatKey(ch), target?.sit ? `${target.col},${target.row}` : null],
      fn,
    );
  }

  /** Run fn with these tiles out of blockedTiles; only the ones that were in it go back. */
  private withTilesUnblocked<T>(keys: Array<string | null>, fn: () => T): T {
    const removed: string[] = [];
    for (const key of keys) {
      if (key && this.blockedTiles.delete(key)) removed.push(key);
    }
    try {
      return fn();
    } finally {
      for (const key of removed) this.blockedTiles.add(key);
    }
  }

  setAgentContext(id: number, contextTokens: number, maxContextTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.contextTokens = contextTokens;
    ch.maxContextTokens = maxContextTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    // Phase B: a bell coming or going changes the furniture list too, and so
    // can the fun director (decorations, the printer, the fish tank).
    const funChanged = this.fun.update(dt);
    if (this.celebrations.update(dt) || newFrame !== prevFrame || funChanged) {
      this.rebuildFurnitureInstances();
    }
    this.officeClock += dt;

    // The greeter materializes and dematerializes like anyone else, but runs
    // no FSM — it stands where it spawned for as long as the ask is up.
    if (this.greeter && advanceMatrixEffect(this.greeter, dt) === 'despawned') {
      this.greeter = null;
    }
    // The receptionist runs no FSM either: she sits, and waves agents in.
    if (this.receptionist) {
      const since = this.receptionistWaveAt;
      this.receptionist.waveFrame =
        (since === null ? null : waveFrame(this.officeClock - since)) ?? undefined;
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      const effect = advanceMatrixEffect(ch, dt);
      if (effect !== 'none') {
        if (effect === 'despawned') toDelete.push(ch.id);
        continue; // skip normal FSM while the effect is (or just was) active
      }

      // Living office: pick (or keep) where the character should be.
      if (this.zones.zones.size > 0 && !ch.isSubagent && !ch.leaving) this.routeCharacter(ch);

      // Temporarily unblock own seat so character can pathfind to it
      const step = () =>
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles);
      if (ch.zoneTarget) {
        // ...and the zone seat it's headed for.
        this.withRouteUnblocked(ch, step);
        this.afterZoneStep(ch, dt);
      } else {
        this.withOwnSeatUnblocked(ch, step);
      }

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
    }

    // Living office: smokers in company face each other, not the ashtray.
    if (this.zones.zones.has(ZoneLabel.SMOKE)) this.faceFellowSmokers();

    // Phase M: Ansh at the desk, the Manager (and its report-time visit) —
    // or, while the session limit has agents on a break, both in the Lounge.
    this.syncBreakGuests();
    this.npcs.update(dt, this);
    this.tickAnshWander(dt);
    this.tickAnshErrand();

    // ── Pet FSM ────────────────────────────────────────────────
    for (const pet of this.pets) {
      if (pet.id === this.anshPetHold) {
        // Sitting still for Ansh, who is on his way to pet it (or petting it).
        updateIdleAnimation(pet, dt);
      } else if (this.fun.drivePet(pet, dt)) {
        // Fun: the smart pets go where they're needed...
        this.petsDriven.add(pet.id);
      } else {
        // ...otherwise their own FSM.
        this.petsDriven.delete(pet.id);
        updatePet(pet, dt, this.walkableTiles, this.characters, this.tileMap, this.blockedTiles);
      }

      // Tick heart bubble timer (mirrors character waiting-bubble pattern)
      if (pet.bubbleType) {
        pet.bubbleTimer -= dt;
        if (pet.bubbleTimer <= 0) {
          pet.bubbleType = null;
          pet.bubbleTimer = 0;
        }
      }
    }
  }

  /** The `saveAgentSeats` payload: palette, hue and seat for every agent worth
   *  restoring. Sub-agents are excluded because they are derived state the
   *  runtime re-materializes, and the greeter never reaches here at all —
   *  it is not in `characters`. */
  getPersistableSeats(): Record<
    number,
    { palette: number; hueShift: number; seatId: string | null }
  > {
    const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.leaving) continue;
      seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
    }
    return seats;
  }

  /** Everything the renderer draws: the agents plus, while the first-run ask
   *  is up, the consent greeter. This is the ONE place the greeter joins the
   *  agents — every other consumer reads `characters` and gets agents only. */
  getCharacters(): Character[] {
    const chars = Array.from(this.characters.values());
    if (this.greeter) chars.push(this.greeter);
    chars.push(...this.npcs.characters());
    if (this.receptionist) chars.push(this.receptionist); // likewise: a prop, not an agent
    return chars;
  }

  // ── Phase M: the NPCs ─────────────────────────────────────────

  /** The NPC under a world point (hover label, the Manager opens the Tasks
   *  board). Separate from getCharacterAt: NPCs are never selected or followed. */
  getNpcAt(worldX: number, worldY: number): NpcKind | null {
    return this.npcs.hitTest(worldX, worldY);
  }

  /** Report time: the Manager walks into Ansh's office and back. */
  startManagerVisit(): boolean {
    return this.npcs.startManagerVisit();
  }

  /**
   * One of Ansh's thoughts, acted out: walk over to the agent (`visit`), to
   * the Manager (`chatManager`) or somewhere nearby (`stretch`), stay a
   * moment, walk back. `stay` (or a target no longer here) keeps him seated;
   * the line shows in his bubble either way. Moves only: nothing is done to
   * an agent.
   */
  anshDo(thought: AnshThoughtEntry, random: () => number = Math.random): boolean {
    const ansh = this.npcs.ansh;
    if (!ansh) return false;
    const tileOf = (ch: Character | null | undefined) =>
      ch ? { col: ch.tileCol, row: ch.tileRow } : null;
    let near: { col: number; row: number } | null = null;
    let lookAt: () => { col: number; row: number } | null = () => null;
    let staySec = ANSH_VISIT_STAY_SEC;
    switch (thought.action) {
      case 'visit': {
        const id = thought.targetId;
        if (id === undefined || !this.characters.has(id)) return false;
        lookAt = () => tileOf(this.characters.get(id));
        near = lookAt();
        break;
      }
      case 'chatManager':
        lookAt = () => tileOf(this.npcs.manager);
        near = lookAt();
        staySec = ANSH_CHAT_STAY_SEC;
        break;
      case 'stretch':
        near = this.anshStretchSpot(ansh, random);
        staySec = ANSH_STRETCH_STAY_SEC;
        break;
      case 'stay':
        return false;
    }
    if (!near) return false;
    const spot = this.closestFreeWalkableTile(near.col, near.row);
    if (!spot) return false;
    return this.npcs.startAnshErrand(spot, staySec, lookAt);
  }

  /**
   * Between thoughts: an errand of his own (no claude) -- pet a pet, water a
   * plant, make a coffee, chat with the receptionist or the Manager, look out
   * of a window, read the whiteboard, feed the fish, or (quietly) go to the
   * Café, Lounge or Server room or stretch nearby -- drawn among what the
   * office has right now (anshErrands.ts). He stays a while, says his line
   * (the other side of a chat answers) and walks back. False (he stays
   * seated) without an Ansh or anything to do.
   */
  anshWander(random: () => number = this.anshWanderRandom): boolean {
    const ansh = this.npcs.ansh;
    if (!ansh) return false;
    const pick = pickErrand(this.anshErrandOptions(ansh, random), random, this.anshLastErrand);
    if (!pick || !this.startAnshErrandFor(pick.kind, pick.target, random)) return false;
    this.anshLastErrand = pick.kind;
    return true;
  }

  /** The limit break: the Manager and Ansh walk over to sit with it while it
   *  is on, and back to their desks once it is over. */
  private syncBreakGuests(): void {
    const on = this.fun.breakOn;
    for (const kind of ['manager', 'ansh'] as const) {
      const ch = this.npcs.characterOf(kind);
      if (!ch) continue;
      if (!on) {
        if (this.npcs.inHangout(kind) && !this.npcs.leavingHangout(kind)) {
          this.npcs.leaveHangout(kind);
          this.fun.releaseGuestSeat(kind);
        }
        continue;
      }
      if (this.npcs.inHangout(kind)) continue;
      if (this.officeClock < (this.breakGuestRetryAt.get(kind) ?? -Infinity)) continue;
      const seat = this.fun.claimGuestSeat(kind, ch);
      if (seat && this.npcs.joinHangout(kind, seat)) continue;
      if (seat) this.fun.releaseGuestSeat(kind);
      this.breakGuestRetryAt.set(kind, this.officeClock + 2);
    }
  }

  /** The NPCs sitting with the limit break right now (FunHost: they chat too). */
  breakGuests(): BreakGuest[] {
    return (['manager', 'ansh'] as const).filter((kind) => this.npcs.atHangout(kind));
  }

  /** What is said on the limit break right now, with who says it, for the speech overlay. */
  breakSpeechShowing(): Array<{
    key: string;
    ch: Character;
    text: string;
    npc: BreakGuest | null;
  }> {
    const out: Array<{ key: string; ch: Character; text: string; npc: BreakGuest | null }> = [];
    for (const line of this.fun.breakLinesShowing()) {
      const npc = typeof line.who === 'number' ? null : line.who;
      const ch = npc ? this.npcs.characterOf(npc) : this.characters.get(line.who as number);
      if (ch) out.push({ key: String(line.who), ch, text: line.text, npc });
    }
    return out;
  }

  /** The lines being said on Ansh's errands right now (one per speaker), for
   *  the NPC speech overlay. */
  npcLinesShowing(): TimedLine[] {
    return linesShowing(this.anshLines, this.officeClock);
  }

  /** Everything he could do now, with where he'd stand for each. */
  private anshErrandOptions(
    ansh: Character,
    random: () => number,
  ): Array<ErrandOption<AnshErrandTarget>> {
    const taken = new Set<string>();
    for (const ch of this.characters.values()) taken.add(`${ch.tileCol},${ch.tileRow}`);
    for (const ch of [this.receptionist, this.npcs.manager]) {
      if (ch) taken.add(`${ch.tileCol},${ch.tileRow}`);
    }
    const free = (col: number, row: number) =>
      !taken.has(`${col},${row}`) && isWalkable(col, row, this.tileMap, this.blockedTiles);
    const byKind = new Map<AnshErrand, AnshErrandTarget[]>();
    const add = (kind: AnshErrand, target: AnshErrandTarget) => {
      const list = byKind.get(kind);
      if (list) list.push(target);
      else byKind.set(kind, [target]);
    };

    // Furniture: plants, the coffee machine, windows, boards, the fish tank.
    for (const item of this.layout.furniture) {
      const kind = furnitureErrand(item.type);
      const entry = kind ? getCatalogEntry(item.type) : undefined;
      if (!kind || !entry) continue;
      const spot = standSpotFor(item, { w: entry.footprintW, h: entry.footprintH }, free);
      if (spot) add(kind, { near: spot, look: () => spot.look });
    }
    // The pets that aren't busy with something of their own.
    for (const pet of this.pets) {
      if (this.petsDriven.has(pet.id)) continue;
      const near = tileBeside(tileOf(pet), free);
      if (near) add(AnshErrand.PET, { near, look: () => tileOf(pet), pet });
    }
    // A chat across their desk (beside them when there's no way round).
    const partner = (kind: AnshErrand, ch: Character | null) => {
      if (!ch) return;
      const near =
        faceToFaceSpot({ ...tileOf(ch), facing: ch.dir }, free) ?? tileBeside(tileOf(ch), free);
      if (near) add(kind, { near, look: () => tileOf(ch), partner: ch });
    };
    partner(AnshErrand.RECEPTION, this.receptionist);
    if (!this.npcs.visiting) partner(AnshErrand.MANAGER, this.npcs.manager);
    // The quiet ones: a place in the Café, Lounge or Server room; a stretch.
    for (const z of [ZoneLabel.CAFE, ZoneLabel.LOUNGE, ZoneLabel.SERVER]) {
      for (const place of this.zones.zones.get(z)?.places ?? []) {
        const near = { col: place.col, row: place.row };
        add(AnshErrand.PLACE, { near, look: () => near });
      }
    }
    const stretch = this.anshStretchSpot(ansh, random);
    if (stretch) add(AnshErrand.STRETCH, { near: stretch, look: () => stretch });

    // In a fixed order, so a seeded pick is reproducible.
    const order: AnshErrand[] = [
      AnshErrand.PET,
      AnshErrand.PLANT,
      AnshErrand.COFFEE,
      AnshErrand.RECEPTION,
      AnshErrand.MANAGER,
      AnshErrand.WINDOW,
      AnshErrand.BOARD,
      AnshErrand.FISH,
      AnshErrand.PLACE,
      AnshErrand.STRETCH,
    ];
    return order.map((kind) => ({ kind, targets: byKind.get(kind) ?? [] }));
  }

  /** Set Ansh off on an errand: the walk, then what happens once there. */
  private startAnshErrandFor(
    kind: AnshErrand,
    target: AnshErrandTarget,
    random: () => number,
  ): boolean {
    const ansh = this.npcs.ansh;
    if (!ansh) return false;
    const spot =
      kind === AnshErrand.PLACE || kind === AnshErrand.STRETCH
        ? this.closestFreeWalkableTile(target.near.col, target.near.row)
        : target.near;
    if (!spot) return false;
    const script = errandScript(kind, random, {
      petName: target.pet?.name,
      timeOfDay: timeOfDay(this.ambienceNow()),
    });
    const seq = ++this.anshErrandSeq;
    const { pet, partner } = target;
    if (pet) this.holdPetForAnsh(pet);
    let partnerDir: Direction | null = null;
    const started = this.npcs.startAnshErrand(spot, script.staySec, target.look, {
      onArrive: () => {
        const lines = scheduleLines(script.lines, this.officeClock).map((l) => ({ ...l, seq }));
        this.anshLines = [...this.anshLines, ...lines];
        const here = tileOf(ansh);
        if (pet) {
          pet.dir = faceToward(tileOf(pet), here, pet.dir);
          pet.bubbleType = 'heart';
          pet.bubbleTimer = ANSH_PET_HEART_SEC;
        }
        if (partner) {
          partnerDir = partner.dir;
          partner.dir = faceToward(tileOf(partner), here, partner.dir);
        }
        if (kind === AnshErrand.PLANT) this.anshWateringSince = this.officeClock;
      },
      onLeave: (stayed) => {
        // Cut short (a thought, no way there): what was still to be said goes.
        if (!stayed) this.anshLines = this.anshLines.filter((l) => l.seq !== seq);
        if (pet && this.anshPetHold === pet.id) this.anshPetHold = null;
        // The Manager may have set off for Ansh's desk meanwhile: leave it be.
        const managerAway = partner === this.npcs.manager && this.npcs.visiting;
        if (partner && partnerDir !== null && !managerAway) partner.dir = partnerDir;
        this.anshWateringSince = null;
        if (stayed && kind === AnshErrand.COFFEE) {
          this.anshCupUntil = this.officeClock + ANSH_COFFEE_CUP_SEC;
        }
      },
    });
    if (!started && pet && this.anshPetHold === pet.id) this.anshPetHold = null;
    return started;
  }

  /** The pet stops where it is and sits for Ansh until he is done. */
  private holdPetForAnsh(pet: Pet): void {
    this.anshPetHold = pet.id;
    pet.state = PetState.IDLE;
    pet.path = [];
    pet.moveProgress = 0;
    pet.followTargetId = null;
    pet.x = pet.tileCol * TILE_SIZE + TILE_SIZE / 2;
    pet.y = pet.tileRow * TILE_SIZE + TILE_SIZE / 2;
    pet.frame = 0;
    pet.frameTimer = 0;
  }

  /** Per frame: the cup and the watering can in his hand; old lines dropped. */
  private tickAnshErrand(): void {
    const ansh = this.npcs.ansh;
    const now = this.officeClock;
    if (this.anshLines.length > 0) this.anshLines = this.anshLines.filter((l) => now < l.until);
    if (!ansh) return;
    const watering = this.anshWateringSince;
    ansh.wateringCan = watering === null ? undefined : now - watering;
    // The cup is put down while he waters.
    ansh.carryingCup = (watering === null && now < this.anshCupUntil) || undefined;
  }

  /** A new layout: errands under way are dropped (the NPCs are rebuilt). */
  private resetAnshErrands(): void {
    this.anshLines = [];
    this.anshPetHold = null;
    this.anshWateringSince = null;
    this.anshCupUntil = 0;
  }

  /** A walkable tile within ANSH_STRETCH_RADIUS_TILES of Ansh, or null. */
  private anshStretchSpot(
    ansh: Character,
    random: () => number,
  ): { col: number; row: number } | null {
    const r = ANSH_STRETCH_RADIUS_TILES;
    const around = this.walkableTiles.filter(
      (t) => Math.abs(t.col - ansh.tileCol) + Math.abs(t.row - ansh.tileRow) <= r,
    );
    return around.length > 0 ? around[Math.floor(random() * around.length)] : null;
  }

  /** Count Ansh's time at his desk; wander once he has sat long enough. Any
   *  errand (a thought's included) resets the count, and he stays put while
   *  the Manager is on its way to his desk. */
  private tickAnshWander(dt: number): void {
    if (!this.npcs.ansh || this.npcs.anshOut || this.npcs.visiting || this.npcs.inHangout('ansh')) {
      this.anshDeskSec = 0;
      return;
    }
    this.anshWanderAfterSec ??=
      ANSH_WANDER_MIN_SEC + this.anshWanderRandom() * ANSH_WANDER_RANGE_SEC;
    this.anshDeskSec += dt;
    if (this.anshDeskSec < this.anshWanderAfterSec) return;
    this.anshDeskSec = 0;
    this.anshWanderAfterSec = null;
    this.anshWander();
  }

  private buildNpcs(): OfficeNpcs {
    const tiles = this.layout.areaTiles;
    if (!tiles || tiles.length === 0) return new OfficeNpcs();
    const anshTiles: Array<{ col: number; row: number }> = [];
    const managerTiles: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < this.layout.rows; row++) {
      for (let col = 0; col < this.layout.cols; col++) {
        const zone = toZoneLabel(tiles[row * this.layout.cols + col]);
        if (zone === ZoneLabel.ANSH) anshTiles.push({ col, row });
        else if (zone === ZoneLabel.MANAGER) managerTiles.push({ col, row });
      }
    }
    if (anshTiles.length === 0 && managerTiles.length === 0) return new OfficeNpcs();
    const electronics = this.buildElectronicsTileSet();
    const footprints = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category === 'chairs') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++)
          footprints.add(`${item.col + dc},${item.row + dr}`);
      }
    }
    return new OfficeNpcs(
      findNpcPlaces({
        seats: this.seats,
        anshTiles,
        managerTiles,
        walkable: (col, row) => isWalkable(col, row, this.tileMap, this.blockedTiles),
        underFurniture: (col, row) => footprints.has(`${col},${row}`),
        facesElectronics: (seat) => this.isSeatFacingElectronics(seat, electronics),
      }),
    );
  }

  /** Get character at pixel position (for hit testing). Returns id or null.
   *  Agents only: clicks pass straight through the consent greeter, which is
   *  a prop, not something to select or follow. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = Array.from(this.characters.values()).sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning (or walking out to)
      if (ch.matrixEffect === 'despawn' || ch.leaving) continue;
      // The sprite is anchored bottom-center; the box is as tall as its look
      // (a Clawd is half a chibi). Apply sitting offset to match visual position.
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - metricsOf(ch).hitHeight;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
