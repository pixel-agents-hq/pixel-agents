// webview-ui/src/office/engine/existingAgents.ts
//
// Pure reconciliation for the `existingAgents` restore message. Extracted from
// useExtensionMessages so it can be unit-tested without React (mirrors
// officeCanvasCursor.ts). The deliberate e2e-over-unit policy forbids unit
// tests against the React message handler itself.
//
// The webview must handle BOTH orders in which the two restore messages arrive:
//   - existingAgents before layoutLoaded → buffer, flush on the next layoutLoaded
//   - layoutLoaded before existingAgents → layout + seats already built, add now
// Depending on layoutLoaded always arriving last stranded restored agents on any
// surface that sends layout first (e.g. the VS Code no-assets path), issue #334.

/** Per-agent seat metadata carried by the existingAgents message. */
export interface ExistingAgentMeta {
  palette?: number;
  repeat?: number;
  seatId?: string;
}

/** An agent buffered until the layout (and its seats) has been built. */
export interface PendingAgent {
  id: number;
  palette?: number;
  repeat?: number;
  seatId?: string;
  directoryName?: string;
  isHeadless?: boolean;
}

/** Minimal structural view of OfficeState this reconciler needs. */
export interface ExistingAgentsOffice {
  characters: { has: (id: number) => boolean };
  addAgent: (
    id: number,
    preferredPalette?: number,
    preferredRepeat?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    directoryName?: string,
  ) => void;
  setHeadless: (id: number, headless: boolean) => void;
  /** Start an agent at rest: not working, resting in its chair if it has one. */
  restAgent: (id: number) => void;
  /** Give an agent the office already shows the server's look and seat. */
  syncAgent: (id: number, palette?: number, repeat?: number, seatId?: string) => void;
}

/**
 * Put a restored agent in the office, at once and at rest. The snapshot doesn't say who
 * is working: the replay that follows it does (a running tool makes its agent active), so
 * an agent starts out idle, resting in its chair, instead of typing at a turn long over.
 */
export function restoreAgent(os: ExistingAgentsOffice, p: PendingAgent): void {
  os.addAgent(p.id, p.palette, p.repeat, p.seatId, true, p.directoryName);
  if (p.isHeadless) os.setHeadless(p.id, true);
  os.restAgent(p.id);
}

/**
 * Reconcile an `existingAgents` payload into the office. When the layout is
 * already built, agents are added immediately (skipping the matrix spawn effect,
 * as restored agents do) unless they already exist; otherwise they are pushed
 * onto `pending` to be flushed by the next `layoutLoaded`. An agent the office
 * already shows takes the snapshot's look and seat. Returns true if any
 * agent was added directly, so the caller can persist seat assignments.
 */
export function reconcileExistingAgents(
  os: ExistingAgentsOffice,
  incoming: number[],
  meta: Record<number, ExistingAgentMeta>,
  directoryNames: Record<number, string>,
  layoutReady: boolean,
  pending: PendingAgent[],
  headlessAgents: Record<number, boolean> = {},
): boolean {
  let addedDirectly = false;
  for (const id of incoming) {
    const m = meta[id];
    const p: PendingAgent = {
      id,
      palette: m?.palette,
      repeat: m?.repeat,
      seatId: m?.seatId,
      directoryName: directoryNames[id],
      isHeadless: headlessAgents[id] === true,
    };
    if (layoutReady) {
      if (!os.characters.has(p.id)) {
        restoreAgent(os, p);
        addedDirectly = true;
      } else {
        // Already shown (a reconnect): the snapshot is the truth. Keeping the
        // office's own look and seat and saving them back reshuffled the
        // office for every other viewer.
        os.syncAgent(p.id, p.palette, p.repeat, p.seatId);
      }
    } else {
      pending.push(p);
    }
  }
  return addedDirectly;
}

/**
 * Agents the office shows that a resync snapshot no longer lists. The snapshot
 * is the server's whole truth, so these were closed while the client was
 * disconnected and their agentClosed never arrived. Sub-agents (negative ids)
 * are not agents of the snapshot and never count.
 */
export function staleAgentIds(shown: Iterable<number>, incoming: number[]): number[] {
  const live = new Set(incoming);
  return [...shown].filter((id) => id > 0 && !live.has(id));
}
