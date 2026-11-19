/**
 * What the Pixel Office MCP's tools may do to the office: the ONE seam between
 * the MCP module (route, tokens, tool table) and the runtime, split by
 * capability (OfficeCapabilities). composeOfficeMcp.ts builds them from the
 * surface's office facts — one module per capability (agentsView, layoutOps,
 * messaging, visitsOps, charactersView, directoryOps, lifecycle, pcShellOps) — and tools only ever call these, never the
 * store or the runtime directly.
 *
 * A later tool that needs a new operation adds it HERE (typed in office
 * terms) and its implementation in its capability's module.
 */

import type { FurnitureCatalog, OfficeLayout } from '../../../core/src/layout/index.js';
import type { MessageKey, ShellKey, TypedInput } from '../terminal/agentTerminals.js';
import type { LaunchAsks } from '../terminal/launchAsks.js';
import type { TutorialSkipOutcome, TutorialView } from '../tutorial/tutorial.js';

/** The named keys a Message may press (the office's word for them). */
export { MESSAGE_KEYS } from '../terminal/agentTerminals.js';
export type { MessageKey };
/** The named keys typed into a PC shell: a Message's, plus Ctrl+C and Ctrl+D. */
export { SHELL_KEYS } from '../terminal/agentTerminals.js';
export type { ShellKey };
import type { Facing, VisitSpot } from '../../../core/src/layout/index.js';
import type { CharacterOp } from './characterEditOps.js';
import type { CharacterEditOutcome, CharacterUndoOutcome } from './characterEdits.js';
import type { CharacterPreview, CharacterRef, OfficeCharacter } from './charactersView.js';
import type { DirectoryOp } from './directoryOps.js';
import type { LayoutOp } from './layoutEditOps.js';
import type { LayoutEditOutcome, LayoutUndoOutcome } from './layoutEdits.js';

/** An agent's status, as the office shows it. */
export type OfficeAgentStatus = 'active' | 'done' | 'waiting for input' | 'permission request';

/** One agent, as the Pixel Office MCP describes it (list_agents). */
export interface OfficeAgent {
  id: number;
  /** The Nickname it was launched with (launch_agent), or null. */
  nickname: string | null;
  /** The Directory it was launched into or adopted from: its name, and its path when the
   *  office knows that Directory. */
  directory: { name: string; path: string | null } | null;
  /** The folder its session runs in, when known. */
  workingDirectory: string | null;
  /** The Worktree it runs in, if any. */
  worktree: { name: string; branch: string } | null;
  status: OfficeAgentStatus;
  /** What it is doing right now (its newest running tool's label), if anything. */
  activity: string | null;
  /** Sub-agents it has running (foreground and unnamed background ones). */
  subagentsRunning: number;
  /** Its context window, once reported: the share left (0..1) and the tokens. */
  context: { leftShare: number; usedTokens: number; windowTokens: number } | null;
  /** Its conversation's title, as the CLI titles it; null until it has one. */
  conversationTitle: string | null;
  transcriptPath: string;
  /** Its Lead, when it is a Teammate. */
  leadId: number | null;
  /** Its Teammates, when it is a Lead. */
  teammates: Array<{ id: number; name: string | null }>;
  /** Its seat, the seat's tile, and the Area holding that tile. Null while the office
   *  has not seated it (no office open yet). */
  seat: { id: string; tile: { col: number; row: number } | null; area: string | null } | null;
  /** False while its character is on a Visit (then `visit` says where), else true. */
  atDesk: boolean;
  /** The Visit its character is on, if any: the tile it was sent to, the way it faces
   *  there, and whether it stays until its agent's next turn. `seat.tile` stays the seat's. */
  visit: { tile: { col: number; row: number }; facing: Facing; stay: boolean } | null;
  /** The character it wears: the roster label and palette index (plus which copy). */
  character: { label: string | null; palette: number; repeat: number } | null;
  /** Whether it has a terminal of ours that a message could be typed into. */
  messageable: boolean;
}

/** One seat of the layout (layoutToSeats), where it is, and who holds it. */
export interface OfficeSeat {
  /** The seat id (the chair's uid, `uid:1`, `uid:2`… for multi-seat chairs). */
  id: string;
  tile: { col: number; row: number };
  /** The label of the Area holding its tile, or null. */
  area: string | null;
  /** The agent whose seat it is, or null when free. */
  takenBy: number | null;
}

/** The office's layout as the MCP reads it (get_layout, and edit_layout's starting point). */
export interface OfficeLayoutSnapshot {
  /** The saved layout (or the default one), migrated to the current model. */
  layout: OfficeLayout;
  /** The furniture catalogue, or null when none is loaded (every type then unknown). */
  catalog: FurnitureCatalog | null;
  seats: OfficeSeat[];
  /** Area label → the Directories mapped to it (agents launched into them sit there). */
  areaDirectories: ReadonlyMap<string, Array<{ name: string; path: string | null }>>;
}

/** What the office can draw: furniture plus the counted looks a layout refers to by index. */
export interface OfficeAssets {
  catalog: FurnitureCatalog | null;
  /** Loaded floor patterns (floor_N.png); a floor tile's pattern is 1..floorPatterns. */
  floorPatterns: number;
  /** Loaded wall sets (wall_N.png), indexed 0..wallSets-1. */
  wallSets: number;
  /** Loaded carpet variants (carpet_N.png), indexed 0..carpets-1. */
  carpets: number;
  /** Loaded pets, by petType (the array index). */
  pets: Array<{ id: string; name: string }>;
}

/** Who is in the office (list_agents, and the caller check on every request). */
export interface AgentsView {
  /** Every agent in the office, sub-agents excluded (they are not agents of their own). */
  listAgents(): OfficeAgent[];
  /** Whether an agent with this id is in the office. */
  hasAgent(id: number): boolean;
}

/** The layout: read, described, and edited by agents. */
export interface LayoutOps {
  /** The layout with its seats and Area ↔ Directory mappings, or null when the office has none. */
  getLayout(): OfficeLayoutSnapshot | null;
  /** The furniture catalogue and the floor patterns, wall sets, carpets and pets loaded. */
  getAssets(): OfficeAssets;
  /** Apply `agentId`'s batch of layout ops: all or none, saved once, shown in every office
   *  (layoutEdits.ts). Refused while an office's layout editor has unsaved changes. */
  editLayout(agentId: number, ops: readonly LayoutOp[]): LayoutEditOutcome;
  /** Restore the layout before the newest agent edit; refused when it changed since, or
   *  while an office's layout editor has unsaved changes. */
  undoLayoutEdit(): LayoutUndoOutcome;
}

/** Messages: reading agents' terminals and typing into them. */
export interface Messaging {
  /** An agent's status, and its terminal screen when the office can show one. */
  readAgentTerminal(id: number): Promise<AgentTerminalRead>;
  /** Type a Message into each recipient's terminal, each checked by the surface's
   *  delivery guard; one refusal never blocks the others. */
  sendMessage(message: OfficeMessage): Promise<MessageDelivery[]>;
  /** Show a delivered Message in the office. Fire and forget: delivery never waits on it. */
  showMessage(show: MessageShow): void;
}

/** Visits: sending characters across the office. */
export interface VisitOps {
  /**
   * Send an agent's character on a Visit: to a tile (with a facing), or beside a
   * piece of furniture facing it. Resolved and checked on the layout — in the
   * grid, walkable, not another visit's tile, and reachable from the agent's
   * seat (an agent without a seat is only checked for a walkable tile) — then
   * every office is told. Refused with a reason the agent can act on. An
   * agent may send itself mid-turn (the visit outlasts that turn), but not
   * another agent that is working: work looks like work, at its desk.
   */
  visit(
    agentId: number,
    target: VisitTarget,
    opts: { stay: boolean; caller: number },
  ): VisitOutcome;
  /**
   * Where a visitor to agent `agentId` stands: the free walkable tile beside its
   * seat, facing it, reachable from `visitorId`'s seat when that one has a
   * seat. Null when the agent has no seat or nothing beside it qualifies.
   * Resolves only — `visit` with the spot's tile sends a character there.
   */
  spotBesideAgent(agentId: number, visitorId?: number): VisitSpot | null;
}

/** The roster and the wardrobe (list_wardrobe, list_characters, edit_characters): needs no
 *  office open, the server draws characters itself. */
export interface CharacterOps {
  /** What characters are made of: parts per slot, colours per colour key, eyes, bodies, rules. */
  listWardrobe(): Record<string, unknown>;
  /** Every roster character, in palette order, and how many external character sprites
   *  (char_N.png) hold the palettes after them. */
  listCharacters(): { characters: OfficeCharacter[]; externalSprites: number };
  /** The roster character `ref` (id, exact name or palette index) as it is now, or the bare
   *  palette when it names none (an external sprite's palette, past the roster). */
  characterAt(
    ref: CharacterRef,
  ): { id: string; name: string; palette: number } | { palette: CharacterRef };
  /** Pictures of the named characters (each once, in the order named), at most
   *  CHARACTER_PREVIEW_LIMIT of them; `asked` counts the distinct characters named.
   *  Refused, with no picture, when any of them names no character or several. */
  previews(
    refs: readonly CharacterRef[],
  ): { ok: true; previews: CharacterPreview[]; asked: number } | { ok: false; reason: string };
  /** Apply `agentId`'s batch of character ops: all or none, saved through the Characters
   *  view's Save path and shown in every office (characterEdits.ts). Refused while an
   *  office's Characters view holds an unsaved draft. */
  editCharacters(agentId: number, ops: readonly CharacterOp[]): CharacterEditOutcome;
  /** Restore the roster and Directories' defaults from before the newest agent Character
   *  edit, while the office still holds exactly what it wrote (characterEdits.ts). */
  undoCharacterEdit(): CharacterUndoOutcome;
}

/** One Directory, as the Pixel Office MCP describes it (list_directories). */
export interface OfficeDirectory {
  name: string;
  path: string;
  /** `user`: one the user defined (editable). `host`: the folder the office runs in
   *  (VS Code: a workspace folder), which has no settings of its own. */
  source: 'user' | 'host';
  isRepo: boolean;
  /** The Areas its agents sit in (this office's Area mappings). */
  areas: string[];
  /** Its default characters, highest priority first. */
  characters: Array<{ id: string; name: string; palette: number }>;
  characterOrder: 'priority' | 'random';
  worktreeBase: 'head' | 'fresh';
  /** '' for none. */
  worktreeBranchPrefix: string;
}

/** What a batch of Directory ops came to: the Directories added or changed as they are
 *  now and the ones removed, or the failing op (`index`) and why — nothing written then. */
export type DirectoryEditOutcome =
  | {
      ok: true;
      changed: boolean;
      directories: OfficeDirectory[];
      removed: Array<{ name: string; path: string }>;
      notes: string[];
    }
  | { ok: false; index?: number; reason: string };

/** Directories (list_directories, edit_directories): what the Directory modal does. */
export interface DirectoryOps {
  /** Every Directory of the office: the user's own, then the host's. */
  listDirectories(): OfficeDirectory[];
  /** Apply a batch of Directory ops: all or none, written once, shown in every office
   *  (directoryOps.ts). */
  editDirectories(ops: readonly DirectoryOp[]): DirectoryEditOutcome;
}

/** Launching agents (launch_agent): a surface that can tell when its CLI joined. */
export interface Launching {
  /** Launch an agent (or resume a conversation) the way the office's drawer and
   *  conversation list do, and wait until it has joined. */
  launchAgent(request: OfficeLaunchRequest): Promise<OfficeLaunchResult>;
}

/** Closing agents (close_agent): a surface that can end its agents' terminals. */
export interface Closing {
  /** Close a main agent the way its card's × does (its Teammates go with it);
   *  refused for Teammates, and asked first when it would leave a Worktree of
   *  ours with uncommitted files that no answer given covers. */
  closeAgent(request: OfficeCloseRequest): Promise<OfficeCloseOutcome>;
}

/** PC shells (list_pc_shells, open_pc_shell, read_pc_shell, type_in_pc_shell,
 *  close_pc_shell): the plain terminals PCs open for the user, driven as an office
 *  drives them (pcShellOps.ts). Only a surface whose shells' terminals can be read
 *  and written supplies it (standalone). */
export interface PcShellOps {
  /** Every live PC shell, and every piece of the layout that opens one. */
  listPcShells(): Promise<{ shells: OfficePcShell[]; pcs: OfficePc[] }>;
  /** The PC shell of piece `uid`: its live one, else a new one in `directory` (one of
   *  its Area's), else the Area's single Directory, else the home folder. */
  openPcShell(uid: string, directory?: string): PcShellOpenOutcome;
  /** A shell's visible screen as text, and its token. */
  readPcShell(
    id: number,
  ): Promise<{ ok: true; screen: AgentScreen } | { ok: false; reason: string }>;
  /** Type text (Enter after it when `submit`) or press keys in a shell. */
  typeInPcShell(
    id: number,
    input: ShellInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** End a shell as its card's × does: refused while a command runs, unless `confirmed`. */
  closePcShell(
    id: number,
    confirmed: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string; command?: string }>;
}

/** One live PC shell, as the Pixel Office MCP describes it. */
export interface OfficePcShell {
  id: number;
  /** The piece it was opened at, or null when that piece left the layout. */
  furnitureUid: string | null;
  /** The Directory it opened in, or null (the home folder). */
  directory: string | null;
  cwd: string;
  /** A command is running in it (its × would ask first). */
  busy: boolean;
  /** That command, when the office can tell. */
  command?: string;
}

/** A piece of the layout that opens a PC shell. */
export interface OfficePc {
  furnitureUid: string;
  area: string | null;
  /** The Directories a new shell there may open in. */
  directories: string[];
  /** Its live shell, or null. */
  shellId: number | null;
}

export type PcShellOpenOutcome =
  | { ok: true; id: number; cwd: string; directory: string | null; alreadyOpen: boolean }
  | { ok: false; reason: string };

/** What is typed into a PC shell: text (Enter after it when `submit`), or keys. */
export type ShellInput = { text: string; submit: boolean } | { keys: readonly ShellKey[] };

/** The tutorial (the Guide's hands-on tour): its progress as the caller sees
 *  it, and the Guide skipping a quest the user asked it to (tutorial/tutorial.ts). */
export interface TutorialOps {
  view(caller: number, opts?: { brief?: boolean }): TutorialView;
  skip(caller: number, questId: string): TutorialSkipOutcome;
}

/** Everything the tools may call, by capability: a tool names the ones it uses
 *  (`uses`), and the MCP offers a tool only where its surface supplies them. */
export interface OfficeCapabilities {
  agents: AgentsView;
  layout: LayoutOps;
  messaging: Messaging;
  visits: VisitOps;
  characters: CharacterOps;
  directories: DirectoryOps;
  launch: Launching;
  close: Closing;
  shells: PcShellOps;
  tutorial: TutorialOps;
}

export type Capability = keyof OfficeCapabilities;

/** What a surface's office supplies: every capability (the tutorial's too,
 *  even where it can't be started: its tool then says none runs) but launching,
 *  closing and PC shells, which only a surface that can do them has (standalone;
 *  VS Code doesn't list launch_agent / close_agent or the PC shell tools at all). */
export type OfficeOperations = Pick<
  OfficeCapabilities,
  'agents' | 'layout' | 'messaging' | 'visits' | 'characters' | 'directories' | 'tutorial'
> &
  Partial<Pick<OfficeCapabilities, 'launch' | 'close' | 'shells'>>;

// ── Launch (launch_agent) ───────────────────────────────────

/** A launch as an agent asks for it: only `directory` is required. */
export interface OfficeLaunchRequest {
  /** A Directory's name, or a folder's path. */
  directory: string;
  /** A character id, exact name or palette index (charactersView's resolver). */
  character?: string | number;
  /** A seat id (get_layout): taken when free, else the office picks one. */
  seat?: string;
  /** Launch into a new Worktree of the Directory: its name and the branch it
   *  starts from (absent = the Directory's own choices). */
  worktree?: { name?: string; from?: string };
  /** Resume this past conversation instead of starting a new one. */
  resumeSessionId?: string;
  /** Its Nickname, first message, model and permission mode (the seat is `seat`). */
  asks: Omit<LaunchAsks, 'seatId'>;
}

/** What the surface's launch gets, character and seat already checked. */
export interface AgentLaunch extends Omit<OfficeLaunchRequest, 'character' | 'seat' | 'asks'> {
  /** The palette the agent wears (absent = the Directory's defaults, else random). */
  palette?: number;
  /** Its asks, the seat (only when free) among them. */
  asks: LaunchAsks;
}

/** How the surface's launch went: the agent, joined, or why not. */
export type AgentLaunchOutcome = { ok: true; id: number } | { ok: false; reason: string };

/** What launch_agent answers. */
export type OfficeLaunchResult =
  | {
      ok: true;
      id: number;
      /** Its seat, when one is known yet (no office open = none yet). */
      seat: string | null;
      character: OfficeAgent['character'];
      /** Its CLI session id. */
      session: string;
      /** Anything the launch did differently from what was asked. */
      notes: string[];
    }
  | { ok: false; reason: string };

// ── Close (close_agent) ─────────────────────────────────────

/** What to do with a Worktree's uncommitted files when its agent leaves. */
export type CloseWorktreeChoice = 'save' | 'keep' | 'discard';

export interface OfficeCloseRequest {
  id: number;
  /** The agent asking (closing itself is allowed: it closes after the reply). */
  caller: number;
  worktreeChoice?: CloseWorktreeChoice;
  /** For a discard: the number of uncommitted files the user agreed to lose. */
  confirmedFiles?: number;
}

/** What closing an agent came to. */
export type OfficeCloseOutcome =
  | {
      ok: true;
      id: number;
      /** `ended`: its terminal of ours was ended (the CLI process stops).
       *  `dismissed`: no terminal of ours (adopted, headless): the office stops
       *  tracking it and won't adopt it again; its process runs on. */
      how: 'ended' | 'dismissed';
      /** It is the caller and its terminal is ended just after this reply. */
      afterReply: boolean;
      /** Its Teammates, closed with it. */
      teammates: number[];
      /** The Worktree answer kept for its leave, when one was needed. */
      worktree: { name: string; branch: string; choice: CloseWorktreeChoice } | null;
    }
  /** Refused; the Worktree question's reason carries the file count. */
  | { ok: false; reason: string };

// ── Messages (read_agent_terminal / send_message) ───────────

/** An agent's terminal screen as text, and its token (a hash of that text). */
export interface AgentScreen {
  text: string;
  token: string;
}

/** What reading an agent's terminal gives: its status, and its screen when the
 *  office can show one (else why not). */
export interface AgentTerminalRead {
  status: OfficeAgentStatus;
  screen: AgentScreen | null;
  /** Why there is no screen (no terminal of ours, or none this surface can read). */
  noScreen?: string;
}

/** A Message: text (Enter pressed after it when `submit`) or named keys. */
export type MessageContent = TypedInput;

/** One recipient of a Message, with the screen token its sender read (absent = never read). */
export interface MessageRecipient {
  id: number;
  screenToken: string | undefined;
}

/** One recipient's outcome. A refusal for a changed screen carries the new one. */
export type MessageDelivery =
  | { id: number; delivered: true }
  | { id: number; delivered: false; reason: string; screen?: AgentScreen };

export interface OfficeMessage {
  from: number;
  to: MessageRecipient[];
  content: MessageContent;
}

/** What the office shows of a Message: the sender walking to each recipient,
 *  the gist in its speech bubble. */
export interface MessageShow {
  fromId: number;
  toIds: number[];
  gist: string;
}

/** What a tool answers for an agent id that is not in the office. */
export function noAgentReason(id: number): string {
  return `There is no agent ${id} in the office: see list_agents for who is.`;
}

/** Where a visit goes: a tile and the way to face there, or a piece of furniture by uid. */
export type VisitTarget =
  { tile: { col: number; row: number }; facing: Facing } | { furnitureUid: string };

/** A visit sent (the spot it resolved to), or why not. */
export type VisitOutcome =
  { ok: true; spot: VisitSpot; stay: boolean } | { ok: false; reason: string };
