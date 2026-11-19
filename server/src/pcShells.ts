/**
 * PC shells (CONTEXT.md → Interactive Furniture → PC shell): the plain terminal
 * a PC opens on the host for the user. PcShellRegistry is the ONE owner of the
 * live shells, for every surface: their ids (an id space of their own, above
 * PC_SHELL_ID_BASE), open (a piece's live shell, else a new one in the folder
 * pcShellPlace.ts resolves, else the surface's fallback, else home), close (at
 * once, or — where the surface can tell a command runs — asked first), the
 * terminal's own end, and the list every office is told of (`pcShellsLoaded`).
 * What differs per surface is a small PcShellBackend: standalone runs a login
 * shell on the agents' terminal sessions (terminal/pcShells.ts), VS Code opens
 * an integrated terminal (adapters/vscode/vscodePcShells.ts).
 *
 * A shell is NOT an agent: it never enters the agent store, so nothing that
 * enumerates agents (list_agents, the agents' terminal tools) ever sees it.
 * Agents reach shells only through the Pixel Office MCP's own shell tools
 * (mcp/pcShellOps.ts, standalone only), which drive this registry like an
 * office does. And a shell outlives what it was opened from: its piece leaving
 * the layout or its Directory being removed ends nothing; only its terminal
 * ending does.
 */

import * as os from 'os';

import { PC_SHELL_ID_BASE } from '../../core/src/constants.js';
import { layoutFromJson } from '../../core/src/layout/index.js';
import type {
  PanelsInUse,
  PcShellCloseQuestion,
  PcShellReady,
  PcShellRejected,
  PcShellsLoaded,
} from '../../core/src/messages.js';
import { isPcShellId, type PersistedPcShell } from '../../core/src/pcShells.js';
import { catalogOf, type OfficePlaceFacts } from './officeFacts.js';
import { pcShellPiece, type PlaceDirectory, shellDirectory } from './pcShellPlace.js';

/** The shells as every office sees them: the list, and whether an id is one's card. */
export interface PcShellView {
  has(id: number): boolean;
  /** What every office is told: the whole list, oldest first, no folders. */
  message(): PcShellsLoaded;
  /** What a view-only office is told instead: which pieces are in use, no more. */
  inUseMessage(): PanelsInUse;
}

/** A shell's terminal as the registry drives it. */
export interface PcShellTerminal {
  /** Called once when the terminal ends, however it ends. */
  onEnd(listener: () => void): void;
  /** End it (the card's ×). */
  end(): void;
  /** Bring it to the front (where the surface shows terminals itself). */
  show?(): void;
}

/** What a surface brings to the PC shells. */
export interface PcShellBackend {
  /** Why no shell can open here now, or null. */
  unavailable(): string | null;
  /** Where a shell opens when its Area names no single Directory (null = home). */
  fallback(): PlaceDirectory | null;
  /** Start shell `id`'s terminal in `cwd`; throws when it can't. */
  start(shell: { id: number; cwd: string; directoryName?: string }): PcShellTerminal;
  /** What runs in shell `id` (null = idle): its × asks first while a command runs.
   *  Absent: the × closes at once. */
  busy?(id: number): Promise<{ command?: string } | null>;
}

export interface PcShellRegistryDeps {
  backend: PcShellBackend;
  /** The surface's layout, catalogue and Area mappings (its one OfficePlaceFacts). */
  facts: Pick<OfficePlaceFacts, 'layout' | 'catalog' | 'readAreaMappings'>;
  /** The Directories a shell may open in: the list every office is shown
   *  (`directoriesLoaded`), so a hidden host Directory is neither offered by
   *  the office's selector nor picked here. */
  directories: () => readonly PlaceDirectory[];
  /** Tell every open office (the store's broadcast). */
  broadcast: (message: PcShellsLoaded | PanelsInUse) => void;
  /** The list changed (standalone saves it beside the agents). */
  changed?: (records: PersistedPcShell[]) => void;
}

export type PcShellOpen =
  /** `existing`: the piece's live shell, not a new one. */
  { ok: true; id: number; existing: boolean } | { ok: false; reason: string };

/** A piece of the layout that opens a PC shell, and where a new one may open. */
export interface PcShellPc {
  uid: string;
  /** Its furniture type now. */
  type: string;
  /** The Area it stands in, or null. */
  area: string | null;
  /** The Directories a new shell there may open in (one: opened there; none or
   *  several without one named: the surface's fallback). */
  directories: PlaceDirectory[];
  /** Its live shell, or null. */
  shellId: number | null;
}

export type PcShellClose =
  | { closed: true }
  /** A command is running: asked first (`pcShellCloseQuestion`). */
  | { closed: false; question: { command?: string } }
  /** No such live shell. */
  | { closed: false; gone: true };

interface LiveShell {
  record: PersistedPcShell;
  terminal: PcShellTerminal;
}

export class PcShellRegistry implements PcShellView {
  private readonly shells = new Map<number, LiveShell>();
  private nextId = PC_SHELL_ID_BASE + 1;

  constructor(private readonly deps: PcShellRegistryDeps) {}

  has(id: number): boolean {
    return this.shells.has(id);
  }

  /** The live shells, oldest first (folders included: server-side only). */
  records(): PersistedPcShell[] {
    return [...this.shells.values()].map((shell) => shell.record);
  }

  message(): PcShellsLoaded {
    return {
      type: 'pcShellsLoaded',
      shells: this.records().map(({ id, uid, furnitureType, directoryName }) => ({
        id,
        uid,
        furnitureType,
        ...(directoryName !== undefined ? { directoryName } : {}),
      })),
    };
  }

  inUseMessage(): PanelsInUse {
    return { type: 'panelsInUse', uids: [...new Set(this.records().map((r) => r.uid))] };
  }

  /**
   * Open the PC shell of piece `uid`: its live one when it has one (shown),
   * else a new one in `directory` (the office's Directory selector: one of the
   * Directories mapped to the piece's Area), else the Area's single Directory,
   * else the surface's fallback, else the home folder. Refused where the
   * surface can't open one, for a piece that is not in the layout or opens no
   * terminal, and for a named Directory that is not one of its Area's.
   */
  open(uid: string, directory?: string): PcShellOpen {
    const unavailable = this.deps.backend.unavailable();
    if (unavailable !== null) return { ok: false, reason: unavailable };
    const live = [...this.shells.values()].find((shell) => shell.record.uid === uid);
    if (live) {
      live.terminal.show?.();
      return { ok: true, id: live.record.id, existing: true };
    }

    const piece = pcShellPiece({ ...this.places(), uid });
    if (!piece.ok) return piece;
    const chosen = shellDirectory(piece.directories, directory);
    if (!chosen.ok) return chosen;
    const place = chosen.directory ?? this.deps.backend.fallback();
    const cwd = place?.path ?? os.homedir();
    const named = place ? { directoryName: place.name } : {};

    const id = this.nextId;
    let terminal: PcShellTerminal;
    try {
      terminal = this.deps.backend.start({ id, cwd, ...named });
    } catch (err) {
      console.error(`[Pixel Agents] PC shell: the terminal failed to start: ${String(err)}`);
      return { ok: false, reason: `The shell could not start: ${String(err)}` };
    }
    this.nextId++;
    this.adopt({ id, uid, furnitureType: piece.type, cwd, ...named }, terminal);
    this.announce();
    console.log(`[Pixel Agents] PC shell ${id} - for piece ${uid} in ${cwd}`);
    return { ok: true, id, existing: false };
  }

  /**
   * Every piece of the layout that opens a PC shell (its furniture declares the
   * `terminal` panel: pcShellPiece decides, naming no furniture), with its Area,
   * the Directories a new shell there may open in, and its live shell.
   */
  pcs(): PcShellPc[] {
    const places = this.places();
    const live = new Map(this.records().map((r) => [r.uid, r.id]));
    return (places.layout?.furniture ?? []).flatMap((f) => {
      const piece = pcShellPiece({ ...places, uid: f.uid });
      if (!piece.ok) return [];
      const { type, area, directories } = piece;
      return [{ uid: f.uid, type, area, directories, shellId: live.get(f.uid) ?? null }];
    });
  }

  /**
   * What runs in shell `id`, as its × would see it: null = idle, else the
   * command when the surface can tell. Undefined where the surface can't tell
   * a command runs at all (its × closes at once).
   */
  async running(id: number): Promise<{ command?: string } | null | undefined> {
    const { busy } = this.deps.backend;
    return busy ? busy(id) : undefined;
  }

  /**
   * End shell `id` (its card's ×). Where the surface can tell a command runs
   * and one does, it is not closed unless `confirmed`, and answers with the
   * question instead; otherwise it ends at once.
   */
  async close(id: number, confirmed: boolean): Promise<PcShellClose> {
    if (!this.shells.has(id)) return { closed: false, gone: true };
    const { busy } = this.deps.backend;
    if (!confirmed && busy) {
      const running = await busy(id);
      if (running) return { closed: false, question: running };
    }
    const shell = this.shells.get(id);
    // It may have ended while we looked.
    if (!shell) return { closed: true };
    // Forgotten first, so the end that follows finds nothing to announce.
    this.forget(id);
    shell.terminal.end();
    return { closed: true };
  }

  /** Show shell `id`'s terminal (its card pressed), where the surface shows terminals. */
  show(id: number): void {
    this.shells.get(id)?.terminal.show?.();
  }

  /** Never hand a new shell `id` or below (a terminal still holds it). */
  reserve(id: number): void {
    if (id >= this.nextId) this.nextId = id + 1;
  }

  /**
   * A live shell joins (a new one, or one a restore brought back): kept, and
   * forgotten when its terminal ends. Announce once the list is complete.
   */
  adopt(record: PersistedPcShell, terminal: PcShellTerminal): void {
    this.reserve(record.id);
    this.shells.set(record.id, { record, terminal });
    terminal.onEnd(() => this.forget(record.id));
  }

  /** The list changed: saved where the surface saves it, and every office told. */
  announce(): void {
    this.deps.changed?.(this.records());
    this.deps.broadcast(this.message());
    this.deps.broadcast(this.inUseMessage());
  }

  /** The layout, catalogue, mappings and Directories a shell's place is read from. */
  private places() {
    return {
      layout: layoutFromJson(this.deps.facts.layout()),
      catalog: catalogOf(this.deps.facts.catalog()),
      areaMappings: this.deps.facts.readAreaMappings(),
      directories: this.deps.directories(),
    };
  }

  private forget(id: number): void {
    if (!this.shells.delete(id)) return;
    this.announce();
  }
}

type PcShellReply = PcShellReady | PcShellRejected | PcShellCloseQuestion;

/**
 * An office's PC shell message, the same on every surface: `openPcShell`
 * (answered `pcShellReady` / `pcShellRejected` on `send`), `closePcShell`
 * (answered `pcShellCloseQuestion` while a command runs), and `focusAgent`
 * naming a shell (its terminal shown, where the surface shows terminals).
 * False for any other message (an agent's focus included). Privilege is the
 * caller's to check first: over /ws, the read-only gate above every message.
 */
export function handlePcShellMessage(
  registry: PcShellRegistry,
  received: object,
  send: (reply: PcShellReply) => void,
): boolean {
  const message = received as { readonly type?: unknown; readonly [key: string]: unknown };
  switch (message.type) {
    case 'openPcShell': {
      const { uid } = message;
      if (typeof uid !== 'string') return true;
      const directory = typeof message.directory === 'string' ? message.directory : undefined;
      const opened = registry.open(uid, directory);
      send(
        opened.ok
          ? { type: 'pcShellReady', id: opened.id }
          : { type: 'pcShellRejected', uid, reason: opened.reason },
      );
      return true;
    }
    case 'closePcShell': {
      const { id } = message;
      if (typeof id !== 'number') return true;
      void registry
        .close(id, message.confirmed === true)
        .then((outcome) => {
          if (!outcome.closed && 'question' in outcome) {
            send({ type: 'pcShellCloseQuestion', id, ...outcome.question });
          }
        })
        .catch((err: unknown) => console.error('[Pixel Agents] PC shell: close failed:', err));
      return true;
    }
    case 'focusAgent':
      if (typeof message.id !== 'number' || !isPcShellId(message.id)) return false;
      registry.show(message.id);
      return true;
    default:
      return false;
  }
}
