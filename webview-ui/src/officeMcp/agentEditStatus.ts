/**
 * What an "Undo <agent>'s edit" button would revert, as this office hears it,
 * outside React (like officeMcpStore.ts): one store per kind of agent edit —
 * the layout editor's (agentLayoutEditStatus, agentLayoutEdits.ts) and the
 * Characters view's (agentCharacterEditStatus, agentCharacterEdits.ts).
 *
 * The server sends the newest agent edit while the office still holds what it
 * wrote (nothing = no button), with `refused` to the office whose press it
 * refused, and — Character edits — `landed` as an edit lands. Every message
 * makes a new entry, so a view can show each landing or refusal once.
 */

export interface AgentEditEntry {
  /** The agent whose edit an undo would revert (and what it did), or null when there is none. */
  undoable: { agentId: number; agentName: string; summary: string | null } | null;
  /** Why this office's last undo press was refused, until the next status. */
  refused: string | null;
  /** This message announced an edit landing ("<agent> <summary>"). */
  landed: string | null;
}

export interface AgentEditStatusStore {
  /** Take a status message; returns whether it was this store's. */
  handle(msg: { type?: unknown; [key: string]: unknown }): boolean;
  entry(): AgentEditEntry;
  subscribe(listener: () => void): () => void;
  /** Tests only: forget everything. */
  reset(): void;
}

const EMPTY: AgentEditEntry = { undoable: null, refused: null, landed: null };

export function createAgentEditStatus(
  type: 'agentLayoutEditStatus' | 'agentCharacterEditStatus',
): AgentEditStatusStore {
  let entry = EMPTY;
  const listeners = new Set<() => void>();
  return {
    handle(msg) {
      if (msg.type !== type) return false;
      const undoable =
        typeof msg.agentId === 'number'
          ? {
              agentId: msg.agentId,
              agentName: typeof msg.agentName === 'string' ? msg.agentName : `agent ${msg.agentId}`,
              summary: typeof msg.summary === 'string' ? msg.summary : null,
            }
          : null;
      entry = {
        undoable,
        refused: typeof msg.refused === 'string' ? msg.refused : null,
        landed:
          msg.landed === true && undoable
            ? [undoable.agentName, undoable.summary].filter(Boolean).join(' ')
            : null,
      };
      for (const l of listeners) l();
      return true;
    },
    entry: () => entry,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      entry = EMPTY;
    },
  };
}

/** The undo button's label, or null when there is nothing to undo. */
export function undoButtonLabel(e: AgentEditEntry): string | null {
  return e.undoable ? `Undo ${e.undoable.agentName}'s edit` : null;
}
