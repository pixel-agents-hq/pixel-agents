import type { PanDirection } from './camera.js';

/**
 * On-screen pan input (the arrow pad beside the zoom buttons). useKeyboardPan
 * subscribes and treats a press exactly like an arrow key going down, so a tap
 * glides a few tiles and a hold keeps moving — one pan engine, two inputs.
 */
export type PanInputEvent =
  | { kind: 'press'; dir: PanDirection }
  | { kind: 'release'; dir: PanDirection }
  | { kind: 'releaseAll'; dir?: undefined };

type Listener = (event: PanInputEvent) => void;

const listeners = new Set<Listener>();

export function subscribePanInput(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: PanInputEvent): void {
  for (const listener of listeners) listener(event);
}

export function pressPan(dir: PanDirection): void {
  emit({ kind: 'press', dir });
}

export function releasePan(dir: PanDirection): void {
  emit({ kind: 'release', dir });
}

/** A pointer left the pad mid-hold, or the window lost focus. */
export function releaseAllPan(): void {
  emit({ kind: 'releaseAll' });
}
