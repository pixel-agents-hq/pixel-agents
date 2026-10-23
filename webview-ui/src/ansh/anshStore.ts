/**
 * Ansh's brain as the webview sees it (server: ansh/anshBrain.ts): on or off,
 * thinking now, today's count, the recent thoughts, the line in his bubble,
 * and whether his thoughts panel is open. Outside React, like the tasks store,
 * so the message handler, the canvas (a click on Ansh) and the overlay reach
 * it without props.
 *
 * `reduceAnshMessage` is the pure half (tested); the store around it is a tiny
 * useSyncExternalStore source. Requests to the server are the panel's job.
 */

import { useSyncExternalStore } from 'react';

import type { AnshBrainState, AnshThought, AnshThoughtEntry } from '../../../core/src/messages.js';

export interface AnshState {
  /** The server has a brain (an anshBrainState arrived). */
  supported: boolean;
  enabled: boolean;
  thinking: boolean;
  thoughtsToday: number;
  dailyCap: number;
  /** Newest last. */
  thoughts: AnshThoughtEntry[];
  /** The line in Ansh's bubble and when it appeared (performance.now ms), or null. */
  bubble: { thought: AnshThoughtEntry; shownAt: number } | null;
  /** "Ask Ansh" was sent and no answer has come back yet. */
  asking: boolean;
  panelOpen: boolean;
}

export function initialAnshState(): AnshState {
  return {
    supported: false,
    enabled: false,
    thinking: false,
    thoughtsToday: 0,
    dailyCap: 0,
    thoughts: [],
    bubble: null,
    asking: false,
    panelOpen: false,
  };
}

export type AnshMessage = AnshBrainState | AnshThought;

export function isAnshMessage(msg: unknown): msg is AnshMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === 'anshBrainState' || type === 'anshThought';
}

/** Apply a brain message. `nowMs` stamps a new bubble. */
export function reduceAnshMessage(state: AnshState, msg: AnshMessage, nowMs: number): AnshState {
  if (msg.type === 'anshBrainState') {
    return {
      ...state,
      supported: true,
      enabled: msg.enabled,
      thinking: msg.thinking,
      thoughtsToday: msg.thoughtsToday,
      dailyCap: msg.dailyCap,
      thoughts: msg.thoughts,
      // The thought (or the refusal resent as state) has answered the ask.
      asking: state.asking && msg.thinking,
    };
  }
  return { ...state, bubble: { thought: msg.thought, shownAt: nowMs }, asking: false };
}

let state = initialAnshState();
const listeners = new Set<() => void>();

function setState(next: AnshState): void {
  state = next;
  for (const l of listeners) l();
}

export function getAnshState(): AnshState {
  return state;
}

export function subscribeAnsh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnshState(): AnshState {
  return useSyncExternalStore(subscribeAnsh, getAnshState);
}

/**
 * Feed a server message to the store. True when it was a brain message (the
 * caller stops there). A new thought also runs `onThought` -- the walk.
 */
export function handleAnshMessage(
  msg: unknown,
  hooks: { onThought?: (thought: AnshThoughtEntry) => void } = {},
  nowMs = performance.now(),
): boolean {
  if (!isAnshMessage(msg)) return false;
  setState(reduceAnshMessage(state, msg, nowMs));
  if (msg.type === 'anshThought') hooks.onThought?.(msg.thought);
  return true;
}

/** The bubble has been read (timed out or clicked). */
export function clearAnshBubble(): void {
  if (state.bubble) setState({ ...state, bubble: null });
}

export function markAnshAsking(): void {
  setState({ ...state, asking: true });
}

export function openAnshPanel(): void {
  if (!state.panelOpen) setState({ ...state, panelOpen: true });
}

export function closeAnshPanel(): void {
  if (state.panelOpen) setState({ ...state, panelOpen: false });
}

/** Tests only: back to a fresh store. */
export function resetAnshStore(): void {
  state = initialAnshState();
  for (const l of listeners) l();
}
