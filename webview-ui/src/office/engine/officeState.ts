import {
  AGENT_NAME_MAX_LENGTH,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  FLOOR_NAME_MAX_LENGTH,
  FURNITURE_ANIM_INTERVAL_SEC,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  MAX_FLOORS,
  MAX_PET_ID_LENGTH,
  PET_HIT_HALF_WIDTH,
  PET_HIT_HEIGHT,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultDocument,
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  wrapLayoutAsDocument,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getPetCount, getPetName } from '../sprites/petSpriteData.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  OfficeDocument,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  PlacedPet,
  RosterEntry,
  Seat,
  TileType as TileTypeVal,
} from '../types.js';
import {
  CharacterState,
  Direction,
  MATRIX_EFFECT_DURATION,
  PetState,
  TILE_SIZE,
} from '../types.js';
import { createCharacter, updateCharacter } from './characters.js';
import { matrixEffectSeeds } from './matrixEffect.js';
import { createPet, updatePet } from './petEntity.js';

/** All derived per-floor game state. The active floor's runtime is exposed
 *  through OfficeState's layout/tileMap/seats/... getters so single-floor
 *  consumers (renderer, editor, hit-testing) work unchanged. */
interface FloorRuntime {
  id: string;
  name: string;
  /** Free-text manual notes for this floor's department board */
  notes: string;
  /** Static roster of subagent personas assigned to this floor */
  roster: RosterEntry[];
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  pets: Pet[];
}

export class OfficeState {
  private floorRuntimes: Map<string, FloorRuntime> = new Map();
  /** Floor ids in display order */
  floorOrder: string[] = [];
  /** Currently viewed floor. Change via setActiveFloor(). */
  activeFloorId = '';
  /** Preserved from the loaded document so getDocument() round-trips it */
  private documentLayoutRevision?: number;
  /** False until the first real loadDocument() after construction, so the
   *  persisted activeFloorId is applied once and later external reloads
   *  don't yank the user off the floor they are viewing. */
  private hasLoadedDocument = false;

  characters: Map<number, Character> = new Map();
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;
  /** Persistent subagent_type -> custom display name (e.g. "office-architect" -> "Paco"),
   *  loaded once from server state and edited via the Settings panel. */
  subagentTypeNames: Map<string, string> = new Map();
  /** subagentType -> floorId, derived from every floor's static `roster`. A
   *  subagent whose type is rostered to a floor always spawns there, regardless
   *  of the active floor or which floor its parent character happens to be on. */
  private rosterFloorByType: Map<string, string> = new Map();

  constructor(layout?: OfficeLayout) {
    this.loadDocument(layout ? wrapLayoutAsDocument(layout) : createDefaultDocument());
    // The constructor document is a placeholder — the first real layoutLoaded
    // should still apply the persisted activeFloorId.
    this.hasLoadedDocument = false;
  }

  // ── Active-floor accessors (single-floor consumers read these) ──

  private activeFloor(): FloorRuntime {
    return this.floorRuntimes.get(this.activeFloorId)!;
  }

  /** Runtime for a character's floor, falling back to the active floor */
  private floorRuntime(floorId: string): FloorRuntime {
    return this.floorRuntimes.get(floorId) ?? this.activeFloor();
  }

  get layout(): OfficeLayout {
    return this.activeFloor().layout;
  }

  get tileMap(): TileTypeVal[][] {
    return this.activeFloor().tileMap;
  }

  get seats(): Map<string, Seat> {
    return this.activeFloor().seats;
  }

  get blockedTiles(): Set<string> {
    return this.activeFloor().blockedTiles;
  }

  get furniture(): FurnitureInstance[] {
    return this.activeFloor().furniture;
  }

  get walkableTiles(): Array<{ col: number; row: number }> {
    return this.activeFloor().walkableTiles;
  }

  get pets(): Pet[] {
    return this.activeFloor().pets;
  }

  getLayout(): OfficeLayout {
    return this.activeFloor().layout;
  }

  // ── Floors ────────────────────────────────────────────────────

  /** Build all derived state for one floor. Pets spawn from layout.pets. */
  private buildFloorRuntime(
    id: string,
    name: string,
    layout: OfficeLayout,
    notes = '',
    roster: RosterEntry[] = [],
  ): FloorRuntime {
    const tileMap = layoutToTileMap(layout);
    const seats = layoutToSeats(layout.furniture);
    const blockedTiles = getBlockedTiles(layout.furniture);
    const furniture = layoutToFurnitureInstances(layout.furniture);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);
    const rt: FloorRuntime = {
      id,
      name,
      notes,
      roster,
      layout,
      tileMap,
      seats,
      blockedTiles,
      furniture,
      walkableTiles,
      pets: [],
    };
    this.rebuildPetsFromLayout(rt);
    return rt;
  }

  /**
   * Replace the whole multi-floor document (initial load, external file change,
   * reset). Existing characters are kept and re-homed: their seat is preserved
   * when it still exists on any floor, otherwise they get a free seat (or a
   * random walkable tile) on their floor.
   */
  loadDocument(doc: OfficeDocument): void {
    const prevActive = this.activeFloorId;
    this.floorRuntimes = new Map();
    this.floorOrder = [];
    for (const f of doc.floors) {
      if (this.floorRuntimes.has(f.id)) continue;
      this.floorRuntimes.set(
        f.id,
        this.buildFloorRuntime(f.id, f.name, f.layout, f.notes ?? '', f.roster ?? []),
      );
      this.floorOrder.push(f.id);
    }
    this.rosterFloorByType = new Map();
    for (const rt of this.floorRuntimes.values()) {
      for (const entry of rt.roster) {
        this.rosterFloorByType.set(entry.subagentType, rt.id);
      }
    }
    this.documentLayoutRevision = doc.layoutRevision;

    const docActive =
      doc.activeFloorId && this.floorRuntimes.has(doc.activeFloorId)
        ? doc.activeFloorId
        : this.floorOrder[0];
    this.activeFloorId =
      this.hasLoadedDocument && this.floorRuntimes.has(prevActive) ? prevActive : docActive;
    this.hasLoadedDocument = true;

    // Re-home existing characters
    for (const ch of this.characters.values()) {
      if (!this.floorRuntimes.has(ch.floorId)) {
        ch.floorId = this.activeFloorId;
        ch.seatId = null;
      }
    }
    // First pass: keep characters at their existing seats (seat uid may have
    // moved to a different floor via import — follow it).
    for (const ch of this.characters.values()) {
      if (!ch.seatId) continue;
      const owner = this.findSeatOwner(ch.seatId);
      if (owner && !owner.seat.assigned) {
        owner.seat.assigned = true;
        ch.floorId = owner.runtime.id;
        this.snapToSeat(ch, owner.seat);
      } else {
        ch.seatId = null;
      }
    }
    // Second pass: seat (or relocate) everyone else on their floor
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      const rt = this.floorRuntime(ch.floorId);
      const seatId = this.findFreeSeat(rt);
      if (seatId) {
        const seat = rt.seats.get(seatId)!;
        seat.assigned = true;
        ch.seatId = seatId;
        this.snapToSeat(ch, seat);
      } else {
        this.relocateCharacterToWalkable(ch, rt);
      }
    }

    this.ensureFollowOnActiveFloor();
    this.rebuildFurnitureInstances();
  }

  /** Serialize all floors back into a persistable v2 document */
  getDocument(): OfficeDocument {
    return {
      version: 2,
      activeFloorId: this.activeFloorId,
      ...(this.documentLayoutRevision !== undefined
        ? { layoutRevision: this.documentLayoutRevision }
        : {}),
      floors: this.floorOrder.map((id) => {
        const rt = this.floorRuntimes.get(id)!;
        return {
          id,
          name: rt.name,
          layout: rt.layout,
          ...(rt.notes ? { notes: rt.notes } : {}),
          ...(rt.roster.length > 0 ? { roster: rt.roster } : {}),
        };
      }),
    };
  }

  getFloors(): Array<{ id: string; name: string }> {
    return this.floorOrder.map((id) => {
      const rt = this.floorRuntimes.get(id)!;
      return { id, name: rt.name };
    });
  }

  /** Manual notes for a floor's department board, or '' if unset/unknown */
  getFloorNotes(id: string): string {
    return this.floorRuntimes.get(id)?.notes ?? '';
  }

  /** Static roster for a floor's department board, or [] if unset/unknown */
  getFloorRoster(id: string): RosterEntry[] {
    return this.floorRuntimes.get(id)?.roster ?? [];
  }

  /** Set a floor's manual notes. Returns false if the floor doesn't exist. */
  setFloorNotes(id: string, notes: string): boolean {
    const rt = this.floorRuntimes.get(id);
    if (!rt) return false;
    rt.notes = notes;
    return true;
  }

  /** Switch the viewed floor. Selection survives (enables cross-floor seat
   *  moves); camera follow and hover are cleared when they point off-floor. */
  setActiveFloor(id: string): boolean {
    if (id === this.activeFloorId || !this.floorRuntimes.has(id)) return false;
    this.activeFloorId = id;
    this.hoveredAgentId = null;
    this.hoveredTile = null;
    this.ensureFollowOnActiveFloor();
    this.rebuildFurnitureInstances();
    return true;
  }

  private ensureFollowOnActiveFloor(): void {
    if (this.cameraFollowId === null) return;
    const follow = this.characters.get(this.cameraFollowId);
    if (!follow || follow.floorId !== this.activeFloorId) {
      this.cameraFollowId = null;
    }
  }

  /** Add an empty floor and switch to it. Returns the new floor id, or null at MAX_FLOORS. */
  addFloor(name?: string): string | null {
    if (this.floorOrder.length >= MAX_FLOORS) return null;
    const id = `floor-${crypto.randomUUID().slice(0, 8)}`;
    const floorName = (name ?? `Floor ${this.floorOrder.length + 1}`).slice(
      0,
      FLOOR_NAME_MAX_LENGTH,
    );
    this.floorRuntimes.set(id, this.buildFloorRuntime(id, floorName, createDefaultLayout()));
    this.floorOrder.push(id);
    this.setActiveFloor(id);
    return id;
  }

  renameFloor(id: string, name: string): boolean {
    const rt = this.floorRuntimes.get(id);
    const trimmed = name.trim().slice(0, FLOOR_NAME_MAX_LENGTH);
    if (!rt || trimmed.length === 0 || rt.name === trimmed) return false;
    rt.name = trimmed;
    return true;
  }

  /** Set a custom display name for an agent character, or clear it (empty
   *  string) to fall back to agentName / "Agent N". Subagents are transient
   *  (re-keyed on every invocation) so they have no stable identity to name
   *  -- see renameSubagentType for naming a whole subagent_type instead. */
  renameAgent(id: number, name: string): boolean {
    const ch = this.characters.get(id);
    if (!ch || ch.isSubagent) return false;
    const trimmed = name.trim().slice(0, AGENT_NAME_MAX_LENGTH);
    const next = trimmed.length === 0 ? undefined : trimmed;
    if (ch.name === next) return false;
    ch.name = next;
    return true;
  }

  /** Replace the full subagent_type -> custom name map (called once from the
   *  existingAgents snapshot on connect). */
  loadSubagentTypeNames(names: Record<string, string>): void {
    this.subagentTypeNames = new Map(Object.entries(names));
  }

  /** Current subagent_type -> custom name map, for the Settings panel. */
  getSubagentTypeNames(): Record<string, string> {
    return Object.fromEntries(this.subagentTypeNames);
  }

  /** Set (or clear, with an empty string) the persistent display name for a
   *  whole subagent_type -- e.g. every future "office-architect" spawn shows
   *  as "Paco", not just the one currently running. Immediately relabels any
   *  currently-live subagents of that type too. */
  renameSubagentType(subagentType: string, name: string): boolean {
    const trimmed = name.trim().slice(0, AGENT_NAME_MAX_LENGTH);
    if (trimmed.length === 0) {
      if (!this.subagentTypeNames.has(subagentType)) return false;
      this.subagentTypeNames.delete(subagentType);
    } else {
      if (this.subagentTypeNames.get(subagentType) === trimmed) return false;
      this.subagentTypeNames.set(subagentType, trimmed);
    }
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent || ch.subagentType !== subagentType) continue;
      const parentCh =
        ch.parentAgentId !== null ? this.characters.get(ch.parentAgentId) : undefined;
      ch.name =
        this.subagentTypeNames.get(subagentType) ??
        (parentCh?.name ? `${parentCh.name} (Task)` : 'Subagent');
    }
    return true;
  }

  /** Delete a floor. Characters on it move to the first remaining floor;
   *  its pets are removed with it. Refuses to delete the last floor. */
  removeFloor(id: string): boolean {
    if (!this.floorRuntimes.has(id) || this.floorOrder.length <= 1) return false;
    this.floorRuntimes.delete(id);
    this.floorOrder = this.floorOrder.filter((f) => f !== id);
    const fallbackId = this.floorOrder[0];
    const fallback = this.floorRuntimes.get(fallbackId)!;
    for (const ch of this.characters.values()) {
      if (ch.floorId !== id) continue;
      ch.floorId = fallbackId;
      ch.seatId = null;
      ch.path = [];
      ch.moveProgress = 0;
      const seatId = this.findFreeSeat(fallback);
      if (seatId) {
        const seat = fallback.seats.get(seatId)!;
        seat.assigned = true;
        ch.seatId = seatId;
        this.snapToSeat(ch, seat);
      } else {
        this.relocateCharacterToWalkable(ch, fallback);
      }
    }
    if (this.activeFloorId === id) {
      this.activeFloorId = fallbackId;
      this.hoveredAgentId = null;
      this.hoveredTile = null;
      this.ensureFollowOnActiveFloor();
    }
    this.rebuildFurnitureInstances();
    return true;
  }

  /** Find a seat by uid across all floors */
  private findSeatOwner(seatId: string): { runtime: FloorRuntime; seat: Seat } | null {
    for (const rt of this.floorRuntimes.values()) {
      const seat = rt.seats.get(seatId);
      if (seat) return { runtime: rt, seat };
    }
    return null;
  }

  private snapToSeat(ch: Character, seat: Seat): void {
    ch.tileCol = seat.seatCol;
    ch.tileRow = seat.seatRow;
    ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
    ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
    ch.dir = seat.facingDir;
    ch.path = [];
    ch.moveProgress = 0;
  }

  /** Rebuild the ACTIVE floor's derived state from a new layout (editor edits).
   *  Reassigns this floor's characters; other floors are untouched.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    const rt = this.activeFloor();
    rt.layout = layout;
    rt.tileMap = layoutToTileMap(layout);
    rt.seats = layoutToSeats(layout.furniture);
    rt.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    rt.walkableTiles = getWalkableTiles(rt.tileMap, rt.blockedTiles);

    const floorChars: Character[] = [];
    for (const ch of this.characters.values()) {
      if (ch.floorId === rt.id) floorChars.push(ch);
    }

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of floorChars) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
      for (const pet of rt.pets) {
        pet.tileCol += shift.col;
        pet.tileRow += shift.row;
        pet.x += shift.col * TILE_SIZE;
        pet.y += shift.row * TILE_SIZE;
        pet.path = [];
        pet.moveProgress = 0;
      }
    }

    // Reassign this floor's characters to new seats, preserving existing
    // assignments when possible
    for (const seat of rt.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of floorChars) {
      if (ch.seatId && rt.seats.has(ch.seatId)) {
        const seat = rt.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          this.snapToSeat(ch, seat);
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of floorChars) {
      if (ch.seatId) continue;
      const seatId = this.findFreeSeat(rt);
      if (seatId) {
        const seat = rt.seats.get(seatId)!;
        seat.assigned = true;
        ch.seatId = seatId;
        this.snapToSeat(ch, seat);
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of floorChars) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch, rt);
      }
    }

    // Relocate any pets that ended up outside bounds or on non-walkable tiles
    for (const pet of rt.pets) {
      if (
        pet.tileCol < 0 ||
        pet.tileCol >= layout.cols ||
        pet.tileRow < 0 ||
        pet.tileRow >= layout.rows ||
        !isWalkable(pet.tileCol, pet.tileRow, rt.tileMap, rt.blockedTiles)
      ) {
        if (rt.walkableTiles.length > 0) {
          const spawn = rt.walkableTiles[Math.floor(Math.random() * rt.walkableTiles.length)];
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
    this.rebuildPetsFromLayout(rt);
  }

  /** Move a character to a random walkable tile on the given floor */
  private relocateCharacterToWalkable(ch: Character, rt: FloorRuntime): void {
    if (rt.walkableTiles.length === 0) return;
    const spawn = rt.walkableTiles[Math.floor(Math.random() * rt.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.floorRuntime(ch.floorId).seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat (on its floor), run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const blocked = this.floorRuntime(ch.floorId).blockedTiles;
    const key = this.ownSeatKey(ch);
    if (key) blocked.delete(key);
    const result = fn();
    if (key) blocked.add(key);
    return result;
  }

  private findFreeSeat(rt: FloorRuntime): string | null {
    // Build set of tiles occupied by electronics (PCs, monitors, etc.)
    const electronicsTiles = new Set<string>();
    for (const item of rt.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          electronicsTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }

    // Collect free seats, split into those facing electronics and the rest
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const [uid, seat] of rt.seats) {
      if (seat.assigned) continue;

      // Check if this seat faces electronics (same logic as auto-state detection)
      let facesPC = false;
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH && !facesPC; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        if (electronicsTiles.has(`${tileCol},${tileRow}`)) {
          facesPC = true;
          break;
        }
        if (dCol !== 0) {
          if (
            electronicsTiles.has(`${tileCol},${tileRow - 1}`) ||
            electronicsTiles.has(`${tileCol},${tileRow + 1}`)
          ) {
            facesPC = true;
            break;
          }
        } else {
          if (
            electronicsTiles.has(`${tileCol - 1},${tileRow}`) ||
            electronicsTiles.has(`${tileCol + 1},${tileRow}`)
          ) {
            facesPC = true;
            break;
          }
        }
      }
      (facesPC ? pcSeats : otherSeats).push(uid);
    }

    // Pick randomly: prefer PC seats, then any seat
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
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
    const minCount = Math.min(...counts);
    // Available = palettes at the minimum count (least used)
    const available: number[] = [];
    for (let i = 0; i < paletteCount; i++) {
      if (counts[i] === minCount) available.push(i);
    }
    const palette = available[Math.floor(Math.random() * available.length)];
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { palette, hueShift };
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
    name?: string,
  ): void {
    if (this.characters.has(id)) return;

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

    // Try the preferred seat first — it may live on any floor (restored agents
    // return to the floor their seat is on) — then any free seat on the
    // active (viewed) floor.
    let seatId: string | null = null;
    let seatFloor: FloorRuntime | null = null;
    if (preferredSeatId) {
      const owner = this.findSeatOwner(preferredSeatId);
      if (owner && !owner.seat.assigned) {
        seatId = preferredSeatId;
        seatFloor = owner.runtime;
      }
    }
    if (!seatId) {
      const rt = this.activeFloor();
      seatId = this.findFreeSeat(rt);
      seatFloor = seatId ? rt : null;
    }

    let ch: Character;
    if (seatId && seatFloor) {
      const seat = seatFloor.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift, seatFloor.id);
    } else {
      // No seats — spawn at random walkable tile on the active floor
      const rt = this.activeFloor();
      const spawn =
        rt.walkableTiles.length > 0
          ? rt.walkableTiles[Math.floor(Math.random() * rt.walkableTiles.length)]
          : { col: 1, row: 1 };
      ch = createCharacter(id, palette, null, null, hueShift, rt.id);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (folderName) {
      ch.folderName = folderName;
    }

    if (name) {
      ch.name = name;
    }

    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.floorRuntime(ch.floorId).seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.bubbleType = null;
  }

  /** Find seat uid at a given tile position on the active floor, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.activeFloor().seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent to a seat on the active floor. When the agent lives on
   *  another floor it teleports over (matrix spawn effect) — there is no
   *  cross-floor pathfinding. */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    const rt = this.activeFloor();
    const seat = rt.seats.get(seatId);
    if (!seat || seat.assigned) return;
    // Unassign old seat (possibly on another floor)
    if (ch.seatId) {
      const old = this.floorRuntime(ch.floorId).seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    seat.assigned = true;
    ch.seatId = seatId;

    if (ch.floorId !== rt.id) {
      // Cross-floor move: teleport to the new floor's seat
      ch.floorId = rt.id;
      this.snapToSeat(ch, seat);
      ch.state = CharacterState.TYPE;
      ch.frame = 0;
      ch.frameTimer = 0;
      ch.matrixEffect = 'spawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
      this.rebuildFurnitureInstances();
      return;
    }

    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, rt.tileMap, rt.blockedTiles),
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

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    const rt = this.floorRuntime(ch.floorId);
    const seat = rt.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, rt.tileMap, rt.blockedTiles),
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

  /** Walk an agent to an arbitrary walkable tile (right-click command).
   *  Only works on the floor currently being viewed. */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (ch.floorId !== this.activeFloorId) return false;
    const rt = this.activeFloor();
    if (!isWalkable(col, row, rt.tileMap, rt.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, rt.tileMap, rt.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the
   *  sub-agent ID. `subagentType` (the Task tool's subagent_type argument,
   *  e.g. "office-architect") is looked up against subagentTypeNames for a
   *  persistent custom name; falls back to the generic "<parent> (Task)"
   *  label when absent or unnamed. It is also looked up against
   *  rosterFloorByType: a subagent whose type is rostered to a floor (e.g.
   *  "zegion-security" on The Five Retainers) always spawns there, regardless
   *  of which floor its parent is on or which floor is active — otherwise it
   *  falls back to the parent's floor. */
  addSubagent(parentAgentId: number, parentToolId: string, subagentType?: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;
    const homeFloorId = subagentType ? this.rosterFloorByType.get(subagentType) : undefined;
    const rt = homeFloorId
      ? this.floorRuntime(homeFloorId)
      : parentCh
        ? this.floorRuntime(parentCh.floorId)
        : this.activeFloor();

    // Find the closest walkable tile to the parent, avoiding tiles occupied by
    // other characters on the same floor
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    const dist = (c: number, r: number) => Math.abs(c - parentCol) + Math.abs(r - parentRow);

    // Build set of tiles occupied by existing characters on this floor
    const occupiedTiles = new Set<string>();
    for (const [, other] of this.characters) {
      if (other.floorId !== rt.id) continue;
      occupiedTiles.add(`${other.tileCol},${other.tileRow}`);
    }

    let spawn = { col: parentCol, row: parentRow };
    if (rt.walkableTiles.length > 0) {
      let closest = rt.walkableTiles[0];
      let closestDist = Infinity;
      for (const tile of rt.walkableTiles) {
        if (occupiedTiles.has(`${tile.col},${tile.row}`)) continue;
        const d = dist(tile.col, tile.row);
        if (d < closestDist) {
          closest = tile;
          closestDist = d;
        }
      }
      spawn = closest;
    }

    const ch = createCharacter(id, palette, null, null, hueShift, rt.id);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;

    // A persistent per-type name (set via Settings) wins; otherwise subagents
    // inherit the parent's display name.
    const customName = subagentType ? this.subagentTypeNames.get(subagentType) : undefined;
    ch.name = customName ?? (parentCh?.name ? `${parentCh.name} (Task)` : 'Subagent');

    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    ch.subagentType = subagentType;
    ch.matrixEffect = 'spawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
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
        const seat = this.floorRuntime(ch.floorId).seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
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
            const seat = this.floorRuntime(ch.floorId).seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn';
          ch.matrixEffectTimer = 0;
          ch.matrixEffectSeeds = matrixEffectSeeds();
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

  /** Rebuild the active floor's furniture instances with auto-state applied
   *  (active agents on this floor turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    const rt = this.activeFloor();
    // Collect tiles where active agents on this floor face desks
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId || ch.floorId !== rt.id) continue;
      const seat = rt.seats.get(ch.seatId);
      if (!seat) continue;
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 deep)
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

    if (autoOnTiles.size === 0) {
      rt.furniture = layoutToFurnitureInstances(rt.layout.furniture);
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const modifiedFurniture: PlacedFurniture[] = rt.layout.furniture.map((item) => {
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

    rt.furniture = layoutToFurnitureInstances(modifiedFurniture);
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
    }
  }

  clearPermissionBubble(id: number): void {
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
   * Add a pet to the ACTIVE floor. Spawns at a uniformly-random walkable tile.
   * Mirror in the floor's layout.pets so debounced saveLayout serialises the roster.
   * Bounds-checks petType against the loaded sprite count to defend against stale layouts.
   */
  addPet(placedPet: PlacedPet): void {
    this.addPetTo(this.activeFloor(), placedPet);
  }

  private addPetTo(rt: FloorRuntime, placedPet: PlacedPet): void {
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
    if (rt.pets.some((p) => p.id === placedPet.id)) return; // de-dupe
    if (rt.walkableTiles.length === 0) return; // no spawn space — silently drop

    const spawn = rt.walkableTiles[Math.floor(Math.random() * rt.walkableTiles.length)];
    const pet = createPet(placedPet.id, placedPet.petType, spawn.col, spawn.row);
    pet.name = getPetName(placedPet.petType);
    rt.pets.push(pet);
    this.syncLayoutPets(rt);
  }

  /** Remove a pet by id from the active floor. Idempotent. */
  removePet(id: string): void {
    const rt = this.activeFloor();
    const before = rt.pets.length;
    rt.pets = rt.pets.filter((p) => p.id !== id);
    if (rt.pets.length !== before) {
      this.syncLayoutPets(rt);
    }
  }

  /** Shallow snapshot of the active floor's pets (renderer, hooks). */
  getPets(): Pet[] {
    return this.activeFloor().pets.slice();
  }

  /** Unique petType values placed on the ACTIVE floor. Used by the Pets
   *  toolbar to mark active rows (pets are placed per floor). */
  getActivePetTypes(): number[] {
    const seen = new Set<number>();
    for (const p of this.activeFloor().pets) seen.add(p.petType);
    return Array.from(seen);
  }

  /**
   * Hit-test the active floor's pets at a pixel world position. Sorts
   * back-to-front (largest y wins on tie) so the visually-frontmost pet
   * receives the click. Returns the pet id or null.
   */
  getPetAt(worldX: number, worldY: number): string | null {
    const ordered = this.activeFloor()
      .pets.slice()
      .sort((a, b) => b.y - a.y);
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
    const pet = this.activeFloor().pets.find((p) => p.id === petId);
    if (!pet) return;
    pet.bubbleType = 'heart';
    pet.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  }

  /** Dismiss the heart bubble on click; collapses timer to a fast fade. */
  dismissPetBubble(petId: string): void {
    const pet = this.activeFloor().pets.find((p) => p.id === petId);
    if (!pet || !pet.bubbleType) return;
    pet.bubbleTimer = Math.min(pet.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
  }

  /**
   * Reconcile a floor's pets to match its layout's placed-pet roster.
   * - Pets in layout but not in runtime → spawn via addPetTo().
   * - Pets in runtime but not in layout → remove.
   * - Pets in both → keep existing runtime state (position, FSM).
   *
   * Called from buildFloorRuntime and rebuildFromLayout. Always runs AFTER
   * walkableTiles is populated.
   */
  private rebuildPetsFromLayout(rt: FloorRuntime): void {
    const placed = rt.layout.pets ?? [];
    const placedIds = new Set(placed.map((p) => p.id));

    // 1. Remove pets no longer in layout
    rt.pets = rt.pets.filter((p) => placedIds.has(p.id));

    // 2. Add pets that exist in layout but not in runtime
    const existingIds = new Set(rt.pets.map((p) => p.id));
    for (const p of placed) {
      if (existingIds.has(p.id)) continue;
      this.addPetTo(rt, p); // pushes onto rt.pets, calls syncLayoutPets()
    }
    // syncLayoutPets() inside addPetTo keeps rt.layout.pets coherent; one final
    // sync handles the removal-only branch where addPetTo was never called.
    this.syncLayoutPets(rt);
  }

  /**
   * Re-export a floor's pet roster into its layout.pets. Called only from
   * mutating methods (addPetTo / removePet / rebuildPetsFromLayout) — NEVER
   * from getLayout(), which runs on every render frame.
   */
  private syncLayoutPets(rt: FloorRuntime): void {
    rt.layout.pets = rt.pets.map((p) => ({ id: p.id, petType: p.petType }));
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
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
  }

  setAgentTokens(id: number, inputTokens: number, outputTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.inputTokens = inputTokens;
    ch.outputTokens = outputTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling (active floor)
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.matrixEffectSeeds = [];
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id);
          }
        }
        continue; // skip normal FSM while effect is active
      }

      // Tick the FSM with the character's own floor's structures — characters
      // on non-active floors keep living while another floor is viewed.
      const rt = this.floorRuntime(ch.floorId);
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, rt.walkableTiles, rt.seats, rt.tileMap, rt.blockedTiles),
      );

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

    // ── Pet FSM (all floors; follow targets are same-floor characters) ──
    for (const rt of this.floorRuntimes.values()) {
      if (rt.pets.length === 0) continue;
      const floorCharacters = new Map<number, Character>();
      for (const [id, ch] of this.characters) {
        if (ch.floorId === rt.id) floorCharacters.set(id, ch);
      }
      for (const pet of rt.pets) {
        updatePet(pet, dt, rt.walkableTiles, floorCharacters, rt.tileMap, rt.blockedTiles);

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
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  /** Characters on the active floor — what the renderer draws */
  getVisibleCharacters(): Character[] {
    const visible: Character[] = [];
    for (const ch of this.characters.values()) {
      if (ch.floorId === this.activeFloorId) visible.push(ch);
    }
    return visible;
  }

  /** Get character at pixel position on the active floor (for hit testing).
   *  Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getVisibleCharacters().sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
