/**
 * The office's "useful signals" as the server sends them (docs/office/DESIGN.md,
 * phase D): trouble (desk fire / alarm lamp), loops ("🌀 going in circles?"),
 * today's tokens, the notice board and the last requested timelines.
 *
 * DOM-free and transport-free so it runs on the Node test runner; feed.ts wires
 * it to the transport. Snapshots are immutable (a new object per change) for
 * useSyncExternalStore.
 */

import type {
  AgentTimeline,
  DailyTokens,
  LoopReason,
  NoticeItem,
} from '../../../core/src/messages.js';

export interface TroubleState {
  level: 'fire' | 'alarm';
  failures: number;
}

export interface SignalsSnapshot {
  trouble: ReadonlyMap<number, TroubleState>;
  loops: ReadonlyMap<number, LoopReason>;
  tokens: DailyTokens | null;
  notices: readonly NoticeItem[];
  timelines: ReadonlyMap<number, AgentTimeline>;
}

const EMPTY: SignalsSnapshot = {
  trouble: new Map(),
  loops: new Map(),
  tokens: null,
  notices: [],
  timelines: new Map(),
};

type Message = { type?: unknown } & Record<string, unknown>;

function without<V>(map: ReadonlyMap<number, V>, id: number): ReadonlyMap<number, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function withEntry<V>(map: ReadonlyMap<number, V>, id: number, value: V): ReadonlyMap<number, V> {
  const next = new Map(map);
  next.set(id, value);
  return next;
}

export class SignalStore {
  private snap: SignalsSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  /** Fold one server message in; false for messages that aren't signals. */
  apply(msg: Message): boolean {
    const s = this.snap;
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    switch (msg.type) {
      case 'agentTrouble': {
        if (id === undefined) return true;
        const level = msg.level;
        const failures = typeof msg.failures === 'number' ? msg.failures : 0;
        this.set({
          ...s,
          trouble:
            level === 'fire' || level === 'alarm'
              ? withEntry(s.trouble, id, { level, failures })
              : without(s.trouble, id),
        });
        return true;
      }
      case 'agentLoop': {
        if (id === undefined) return true;
        const reason = msg.reason === 'stall' ? 'stall' : 'repeat';
        this.set({
          ...s,
          loops: msg.looping === true ? withEntry(s.loops, id, reason) : without(s.loops, id),
        });
        return true;
      }
      case 'dailyTokens':
        this.set({ ...s, tokens: msg as unknown as DailyTokens });
        return true;
      case 'noticeBoard':
        this.set({ ...s, notices: Array.isArray(msg.items) ? (msg.items as NoticeItem[]) : [] });
        return true;
      case 'agentTimeline':
        if (id === undefined) return true;
        this.set({ ...s, timelines: withEntry(s.timelines, id, msg as unknown as AgentTimeline) });
        return true;
      case 'agentClosed':
        if (id === undefined) return false;
        this.set({
          ...s,
          trouble: without(s.trouble, id),
          loops: without(s.loops, id),
          timelines: without(s.timelines, id),
        });
        return false; // the office handles it too
      default:
        return false;
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SignalsSnapshot => this.snap;

  private set(next: SignalsSnapshot): void {
    this.snap = next;
    for (const listener of this.listeners) listener();
  }
}

/** The office's one store (fed by feed.ts). */
export const signalStore = new SignalStore();
