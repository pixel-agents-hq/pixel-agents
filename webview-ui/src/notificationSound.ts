import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
  PERMISSION_NOTE_1_HZ,
  PERMISSION_NOTE_1_START_SEC,
  PERMISSION_NOTE_2_HZ,
  PERMISSION_NOTE_2_START_SEC,
  PERMISSION_NOTE_DURATION_SEC,
  PERMISSION_VOLUME,
} from "./constants.js";

let soundEnabled = true;
let audioCtx: AudioContext | null = null;

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

function playNote(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number = NOTIFICATION_NOTE_DURATION_SEC,
  volume: number = NOTIFICATION_VOLUME,
): void {
  const t = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);

  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t);
  osc.stop(t + duration);
}

export async function playDoneSound(): Promise<void> {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC);
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC);
  } catch {
    // Audio may not be available
  }
}

export async function playPermissionSound(): Promise<void> {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    // Descending two-note tap: A5 → E5
    playNote(
      audioCtx,
      PERMISSION_NOTE_1_HZ,
      PERMISSION_NOTE_1_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
    playNote(
      audioCtx,
      PERMISSION_NOTE_2_HZ,
      PERMISSION_NOTE_2_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
  } catch {
    // Audio may not be available
  }
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  } catch {
    // ignore
  }
}
