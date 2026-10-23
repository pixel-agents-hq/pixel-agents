/**
 * The fun phase's audio seam. FunDirector is DOM-free (it unit-tests in the
 * Node runner), so the browser half — the Web Audio radio, the global sound
 * setting, the per-viewer toggle in localStorage — is plugged in here by
 * funRender.ts, which only the browser bundle loads.
 */

export interface RadioPlayer {
  readonly playing: boolean;
  start(): void;
  stop(): void;
}

export interface FunAudio {
  /** The global sound setting (the radio is silent while it's off). */
  soundEnabled(): boolean;
  radio: RadioPlayer;
  /** The viewer's remembered radio toggle. */
  loadRadioOn(): boolean;
  saveRadioOn(on: boolean): void;
}

let audio: FunAudio | null = null;

export function setFunAudio(next: FunAudio | null): void {
  audio = next;
}

export function getFunAudio(): FunAudio | null {
  return audio;
}
