/**
 * The celebration bell (living office phase B): a soft struck bell when a push
 * or PR lands, synthesized with Web Audio (no audio files). It respects the
 * Sound Notifications setting and plays only once the AudioContext has been
 * unlocked by a user gesture; while locked it does nothing at all.
 */

import {
  BELL_SOUND_ATTACK_SEC,
  BELL_SOUND_FUNDAMENTAL_HZ,
  BELL_SOUND_PARTIALS,
  BELL_SOUND_VOLUME,
} from './constants.js';
import { readyAudioContext } from './notificationSound.js';

export function playBellSound(): void {
  const ctx = readyAudioContext();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (const partial of BELL_SOUND_PARTIALS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(BELL_SOUND_FUNDAMENTAL_HZ * partial.ratio, t0);
      const peak = BELL_SOUND_VOLUME * partial.gain;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + BELL_SOUND_ATTACK_SEC);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + BELL_SOUND_ATTACK_SEC + partial.decaySec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + BELL_SOUND_ATTACK_SEC + partial.decaySec);
    }
  } catch {
    // Audio may not be available
  }
}
