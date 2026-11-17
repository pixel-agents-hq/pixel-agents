/**
 * Interactive furniture in the office (CONTEXT.md → Interactive Furniture), as
 * OfficeState carries it (`os.pieces`): the facts the office holds about each
 * piece — the agent working at it, its live PC shell (from the server's
 * announced list, never the layout), the Directories mapped to its Area — and
 * what core's rules (furniture/pieceRules.ts) make of them: the state it is
 * drawn in, its Furniture label and its click. Also the piece under a pointer
 * (hover by mouse, two-step tap by touch) and where its overlays hang.
 *
 * The layout editor owns furniture while it is open: the canvas never asks
 * here then, and clears the hover as the editor opens (OfficeCanvas).
 */

import { agentLabelOf } from '../../../../core/src/agentLabel.js';
import { areaDirectories, pieceArea } from '../../../../core/src/furniture/piecePlaces.js';
import {
  type PieceClick,
  type PieceFacts,
  pieceState,
  type PieceUse,
  type PieceView,
  pieceView,
} from '../../../../core/src/furniture/pieceRules.js';
import type { PcShell } from '../../../../core/src/messages.js';
import { pcShellName } from '../../../../core/src/pcShells.js';
import { FURNITURE_LABEL_HOVER_GRACE_MS, UNNAMED_AGENT_LABEL } from '../../constants.js';
import { furnitureAt } from '../editor/editorActions.js';
import { activeCatalog, getCatalogEntry } from '../layout/furnitureCatalog.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
} from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';

/** Where a pointer on furniture is used: a read-only office offers no click. */
export interface PieceContext {
  readOnly: boolean;
}

/** What the pieces read of the office they stand in. */
export interface PiecesDeps {
  /** The office's layout (where a piece stands, its Area). */
  layout(): OfficeLayout;
  /** The layout as drawn now (during a Buildout, as built so far). */
  shownLayout(): OfficeLayout;
  /** The furniture as drawn now (where a piece's overlays hang). */
  furniture(): readonly FurnitureInstance[];
  characters: ReadonlyMap<number, Character>;
  seats(): ReadonlyMap<string, Seat>;
  /** Seat uid → the uid of the workstation that seat works at. */
  seatWorkstations(): ReadonlyMap<string, string>;
  /** Directory name → the Area labels it is mapped to. */
  areaMappings(): Record<string, string[]>;
  /** Something stands in front of the furniture at this world point (a character, a pet). */
  occupiedAt(worldX: number, worldY: number): boolean;
  /** The live PC shells changed: what the pieces show must be redrawn. */
  shellsChanged(): void;
}

export class PiecesController {
  private hoveredPiece: string | null = null;
  /** When the mouse left a piece whose label holds a button (its shell's ×): the
   *  hover lingers from then for FURNITURE_LABEL_HOVER_GRACE_MS, so the pointer can
   *  cross to the label. Null while the pointer is on the piece or its label. */
  private leftAt: number | null = null;
  private readonly hoverListeners = new Set<() => void>();
  /** Piece uid → its live PC shell, as the server announced them (pcShellsLoaded). */
  private shellsByPiece: ReadonlyMap<string, PcShell> = new Map();
  /** The pieces whose panel is in use, as every office is told (panelsInUse): all a
   *  view-only office knows of the shells. */
  private busyPieces: ReadonlySet<string> = new Set();
  /** The Directories' names, in the host's order (directoriesLoaded). */
  private directoryNames: readonly string[] = [];
  /** The name of the character at a palette (the cast). */
  private characterName: (palette: number) => string | undefined = () => undefined;

  private readonly deps: PiecesDeps;

  constructor(deps: PiecesDeps) {
    this.deps = deps;
  }

  /** The piece the pointer hovers (mouse) or the first tap picked (touch):
   *  outlined, with its Furniture label over it. */
  get hoveredUid(): string | null {
    return this.hoveredPiece;
  }
  private set hoveredUid(uid: string | null) {
    this.leftAt = null;
    if (this.hoveredPiece === uid) return;
    this.hoveredPiece = uid;
    for (const listener of this.hoverListeners) listener();
  }

  /** Observe which piece is hovered (the Furniture label follows only while one is). */
  readonly subscribeHover = (listener: () => void): (() => void) => {
    this.hoverListeners.add(listener);
    return () => this.hoverListeners.delete(listener);
  };

  /** How a Furniture label names the agent working at a piece by its character. */
  setCharacterName(name: (palette: number) => string | undefined): void {
    this.characterName = name;
  }

  /** The Directories the office is shown: where a PC in an Area mapped to
   *  several offers its Directory selector. */
  setDirectoryNames(names: readonly string[]): void {
    this.directoryNames = names;
  }

  /**
   * The live PC shells, the server's whole list (pcShellsLoaded: on every change and
   * in each connect's snapshot, so a list is the truth and a shell it leaves out has
   * ended). Their PCs show their state rules' "panel in use" state from now on; a
   * shell whose piece is no longer in the layout lights nothing.
   */
  setPcShells(shells: readonly PcShell[]): void {
    this.shellsByPiece = new Map(shells.map((shell) => [shell.uid, shell]));
    this.deps.shellsChanged();
  }

  /**
   * The pieces whose panel is in use (panelsInUse, the server's whole list): what an
   * office that isn't sent the shells shows — the PC on, its label "Busy".
   */
  setPanelsInUse(uids: readonly string[]): void {
    this.busyPieces = new Set(uids);
    this.deps.shellsChanged();
  }

  /** The live PC shell of a piece, or null. */
  shellOf(uid: string): PcShell | null {
    return this.shellsByPiece.get(uid) ?? null;
  }

  /** Whether a piece has a live PC shell (the user works there). */
  hasShell(uid: string): boolean {
    return this.shellsByPiece.has(uid);
  }

  /**
   * What the office knows about a piece, for core's pieceView: the agent working
   * at it, named by core's agentLabelOf (Nickname, else its character's name, else
   * its Directory), its panel in use — its live PC shell, named by its Directory
   * (or "Home") — and where a new one may open: the Directories mapped to the Area
   * it stands in (core's piecePlaces, as the server resolves an open).
   */
  facts(uid: string, readOnly: boolean): PieceFacts {
    return {
      ...this.use(uid, this.agentsAtWork(), this.agentsSeated()),
      places: this.places(uid),
      readOnly,
    };
  }

  /**
   * The piece a pointer at this world point is on, for hover and click: the layout
   * editor's own pick (furnitureAt: a surface item wins over the desk under it),
   * kept only when the rules give it something to show or offer (a Furniture label
   * or a click). Nothing under a character or a pet: they stand in front of the
   * furniture, and win.
   */
  at(worldX: number, worldY: number, ctx: PieceContext): string | null {
    if (this.deps.occupiedAt(worldX, worldY)) return null;
    const layout = this.deps.layout();
    const col = Math.floor(worldX / TILE_SIZE);
    const row = Math.floor(worldY / TILE_SIZE);
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
    const hit = furnitureAt(layout, col, row);
    if (!hit) return null;
    const view = this.viewOf(hit, ctx.readOnly);
    return view.label || view.click ? hit.uid : null;
  }

  /**
   * A mouse over this world point: the piece there becomes the hovered one (or
   * none). Returns its view, whose `click` decides the cursor.
   */
  hoverAt(
    worldX: number,
    worldY: number,
    ctx: PieceContext,
    now = performance.now(),
  ): PieceView | null {
    const uid = this.at(worldX, worldY, ctx);
    // Off a piece whose label holds a button: the hover lingers (see `leftAt`),
    // and nothing is under the pointer meanwhile.
    if (uid === null && this.lingers(ctx)) {
      this.leftAt ??= now;
      return null;
    }
    this.hoveredUid = uid;
    return this.hovered(ctx)?.view ?? null;
  }

  /** The pointer is on the hovered piece's label: the hover holds. */
  holdHover(): void {
    this.leftAt = null;
  }

  /** The pointer left the hovered piece's label for the office: the hover lingers from now. */
  releaseHover(now = performance.now()): void {
    if (this.hoveredPiece !== null) this.leftAt = now;
  }

  /** Every frame a label shows: a lingering hover ends once its grace has run out. */
  expireHover(now = performance.now()): void {
    if (this.leftAt !== null && now - this.leftAt > FURNITURE_LABEL_HOVER_GRACE_MS) {
      this.hoveredUid = null;
    }
  }

  /** Whether the hovered piece's label holds something to press here (its live
   *  shell's ×, where this office may close it). */
  private lingers(ctx: PieceContext): boolean {
    return this.hoveredPiece !== null && !ctx.readOnly && this.hasShell(this.hoveredPiece);
  }

  /**
   * A click or tap at this world point, against furniture. Null = no piece there
   * (the hovered one is cleared: a tap elsewhere dismisses it). Two-step (touch):
   * the first tap on a piece only hovers it, `click: null`; a second on the same
   * piece answers its click, and clears the hover when it offers one. One step
   * (mouse): the click at once. `click` is null too where the piece offers none
   * (label only, or a read-only office).
   */
  tapAt(
    worldX: number,
    worldY: number,
    ctx: PieceContext & { twoStep: boolean },
  ): { uid: string; click: PieceClick | null } | null {
    const uid = this.at(worldX, worldY, ctx);
    const wasHovered = uid !== null && this.hoveredUid === uid;
    this.hoveredUid = uid;
    if (uid === null) return null;
    if (ctx.twoStep && !wasHovered) return { uid, click: null };
    const click = this.hovered(ctx)?.view.click ?? null;
    // Touch: the click opened something (a terminal page, the Directory selector),
    // so the label goes with it — back on the office the PC is a first tap again,
    // not a stale label left over it.
    if (ctx.twoStep && click) this.hoveredUid = null;
    return { uid, click };
  }

  /** Forget the hovered piece (the pointer left, the editor opened). */
  clearHover(): void {
    this.hoveredUid = null;
  }

  /**
   * The hovered piece as the office shows it now: its view under the current facts
   * (the label follows an agent sitting down) and where its Furniture label hangs —
   * the top edge of its sprite, centred, in world pixels. Null when nothing is
   * hovered or the piece is gone from the layout.
   */
  hovered(
    ctx: PieceContext,
  ): { uid: string; view: PieceView; anchor: { x: number; y: number } } | null {
    const uid = this.hoveredUid;
    return uid === null ? null : this.shown(uid, ctx);
  }

  /**
   * The pieces whose labels show with nobody hovering them, under Always Show
   * Labels: every piece whose panel is in use (a PC with a live shell — "Busy" in
   * an office that isn't sent the shells), as the office shows each now. A shell
   * whose piece left the layout has no label.
   */
  inUse(ctx: PieceContext): { uid: string; view: PieceView; anchor: { x: number; y: number } }[] {
    const uids = new Set([...this.shellsByPiece.keys(), ...this.busyPieces]);
    return [...uids].flatMap((uid) => {
      const piece = this.shown(uid, ctx);
      return piece?.view.label ? [piece] : [];
    });
  }

  /** A piece as the office shows it now and where its label hangs, or null when
   *  it is gone from the layout or has nothing to show or offer. */
  private shown(
    uid: string,
    ctx: PieceContext,
  ): { uid: string; view: PieceView; anchor: { x: number; y: number } } | null {
    const view = this.view(uid, ctx);
    const anchor = this.anchor(uid);
    if (!view || !anchor || (!view.label && !view.click)) return null;
    return { uid, view, anchor };
  }

  /** A piece's state, label and click as the office shows them now, or null
   *  when it is not in the layout. */
  view(uid: string, ctx: PieceContext): PieceView | null {
    const item = this.deps.layout().furniture.find((f) => f.uid === uid);
    return item ? this.viewOf(item, ctx.readOnly) : null;
  }

  /** Where a piece's overlays hang (its Furniture label, its Directory selector): the
   *  top edge of its sprite as drawn now, centred, in world pixels. Null once it is
   *  no longer drawn. */
  anchor(uid: string): { x: number; y: number } | null {
    const instance = this.deps.furniture().find((f) => f.uid === uid);
    if (!instance) return null;
    const width = instance.sprite[0]?.length ?? TILE_SIZE;
    return { x: instance.x + width / 2, y: instance.y };
  }

  /** The middle of a piece's sprite as drawn now, in world pixels: where the camera
   *  centres on a clicked piece. Null once it is no longer drawn. */
  center(uid: string): { x: number; y: number } | null {
    const instance = this.deps.furniture().find((f) => f.uid === uid);
    if (!instance) return null;
    const width = instance.sprite[0]?.length ?? TILE_SIZE;
    return { x: instance.x + width / 2, y: instance.y + instance.sprite.length / 2 };
  }

  /** Each piece whose state rules hold a declared state now: piece uid → that state.
   *  Every frame: only the state is worked out (core's pieceState). */
  showingStates(): Map<string, string> {
    const shown = new Map<string, string>();
    const atWork = this.agentsAtWork();
    const seated = this.agentsSeated();
    for (const item of this.deps.shownLayout().furniture) {
      const interactive = getCatalogEntry(item.type)?.interactive;
      if (!interactive?.states) continue;
      const state = pieceState(interactive, this.use(item.uid, atWork, seated));
      if (state) shown.set(item.uid, state);
    }
    return shown;
  }

  private viewOf(item: PlacedFurniture, readOnly: boolean): PieceView {
    return pieceView(getCatalogEntry(item.type)?.interactive, this.facts(item.uid, readOnly));
  }

  /** Who and what is using a piece: the agent working at it, the one seated at it,
   *  its live PC shell. */
  private use(
    uid: string,
    atWork: ReadonlyMap<string, Character>,
    seated: ReadonlyMap<string, Character>,
  ): PieceUse {
    const ch = atWork.get(uid);
    const owner = ch ?? seated.get(uid);
    const shell = this.shellsByPiece.get(uid);
    return {
      agentAtWork: ch ? { id: ch.id, name: this.agentName(ch) } : null,
      agentSeated: owner ? { id: owner.id, name: this.agentName(owner) } : null,
      panelInUse: shell
        ? { name: pcShellName(shell) }
        : this.busyPieces.has(uid)
          ? { name: null }
          : null,
    };
  }

  /**
   * Piece uid → the agent working at it: active, sitting in the piece's
   * workstation seat and typing. Walking to the seat, resting there between
   * turns, or standing beside it does not count.
   */
  private agentsAtWork(): Map<string, Character> {
    const atWork = new Map<string, Character>();
    const seats = this.deps.seats();
    const workstations = this.deps.seatWorkstations();
    for (const ch of this.deps.characters.values()) {
      if (!ch.isActive || !ch.seatId || ch.state !== CharacterState.TYPE || ch.matrixEffect) {
        continue;
      }
      const seat = seats.get(ch.seatId);
      if (!seat || ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow) continue;
      const piece = workstations.get(ch.seatId);
      if (piece) atWork.set(piece, ch);
    }
    return atWork;
  }

  /**
   * Piece uid → the agent whose seat is its workstation seat, working or idle,
   * wherever it is standing now (a desk is its agent's between turns too). Not one
   * leaving the office (despawning).
   */
  private agentsSeated(): Map<string, Character> {
    const seated = new Map<string, Character>();
    const workstations = this.deps.seatWorkstations();
    for (const ch of this.deps.characters.values()) {
      if (!ch.seatId || ch.matrixEffect === 'despawn') continue;
      const piece = workstations.get(ch.seatId);
      if (piece && !seated.has(piece)) seated.set(piece, ch);
    }
    return seated;
  }

  /** The Directories mapped to the Area a piece stands in, by name (none without one,
   *  or once the piece left the layout). */
  places(uid: string): string[] {
    const layout = this.deps.layout();
    const item = layout.furniture.find((f) => f.uid === uid);
    if (!item) return [];
    const area = pieceArea(layout, activeCatalog(), item);
    const named = this.directoryNames.map((name) => ({ name }));
    return areaDirectories(area, named, this.deps.areaMappings()).map((d) => d.name);
  }

  /** How the office names an agent to the user (core's agentLabelOf). */
  private agentName(ch: Character): string {
    return (
      agentLabelOf({
        nickname: ch.nickname,
        characterName: this.characterName(ch.palette),
        directoryName: ch.directoryName,
      }) ?? UNNAMED_AGENT_LABEL
    );
  }
}
