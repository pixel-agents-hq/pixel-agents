/**
 * The Lounge radio's lo-fi loop, synthesized with Web Audio — no audio files,
 * no streams. Plays lofiPattern.ts (maj7 pads through a low-pass, a round
 * bass, a lazy swung kick/snare/hat, a pentatonic noodle) with a look-ahead
 * scheduler, plus a little vinyl crackle.
 *
 * browserFunAudio() is the browser half of the fun audio seam (funAudio.ts):
 * this synth, the global sound setting, and the per-viewer toggle remembered
 * in localStorage (try/catch: private windows and blocked storage just forget).
 */

import { isSoundEnabled } from '../notificationSound.js';
import type { FunAudio } from './funAudio.js';
import { LOFI_BPM, LOFI_VOLUME, RADIO_STORAGE_KEY } from './funConstants.js';
import type { LofiStep } from './lofiPattern.js';
import { lofiStep, LOOP_STEPS, midiToHz, STEPS_PER_BAR } from './lofiPattern.js';

const LOOKAHEAD_SEC = 0.35;
const SCHEDULE_EVERY_MS = 90;
/** Swing: every other 16th is late by this share of a step. */
const SWING = 0.18;

/** The synth: start()/stop(); one per page. */
export class LofiRadio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private step = 0;
  private unlockArmed = false;

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer || typeof AudioContext === 'undefined') return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      const ctx = this.ctx;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
        this.armUnlock();
      }
      this.master = ctx.createGain();
      this.master.gain.setValueAtTime(0.0001, ctx.currentTime);
      this.master.gain.exponentialRampToValueAtTime(LOFI_VOLUME, ctx.currentTime + 1.2);
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = 1800;
      this.lowpass.Q.value = 0.5;
      this.lowpass.connect(this.master);
      this.master.connect(ctx.destination);
      this.noise = this.noise ?? makeNoise(ctx);
      this.nextStepTime = ctx.currentTime + 0.1;
      this.step = 0;
      this.timer = setInterval(() => this.schedule(), SCHEDULE_EVERY_MS);
      this.schedule();
    } catch {
      this.stop(); // no Web Audio here
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    const master = this.master;
    this.master = null;
    this.lowpass = null;
    if (ctx && master) {
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
        master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
        setTimeout(() => master.disconnect(), 400);
      } catch {
        /* already gone */
      }
    }
  }

  /** Browsers start audio only after a gesture: resume on the next click or key anywhere. */
  private armUnlock(): void {
    if (this.unlockArmed || typeof window === 'undefined') return;
    this.unlockArmed = true;
    const resume = () => {
      this.unlockArmed = false;
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      void this.ctx?.resume().catch(() => undefined);
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.lowpass) return;
    const stepSec = 60 / LOFI_BPM / 4;
    while (this.nextStepTime < ctx.currentTime + LOOKAHEAD_SEC) {
      const swing = this.step % 2 === 1 ? stepSec * SWING : 0;
      this.playStep(lofiStep(this.step), this.nextStepTime + swing, stepSec);
      this.nextStepTime += stepSec;
      this.step = (this.step + 1) % LOOP_STEPS;
    }
  }

  private playStep(s: LofiStep, t: number, stepSec: number): void {
    const bar = stepSec * STEPS_PER_BAR;
    if (s.chord) {
      for (const n of s.chord) this.tone(midiToHz(n), t, bar * 0.98, 0.05, 'triangle', 0.4);
    }
    if (s.bass !== null) this.tone(midiToHz(s.bass), t, stepSec * 3, 0.16, 'sine', 0.02);
    if (s.lead !== null) this.tone(midiToHz(s.lead), t, stepSec * 2.5, 0.05, 'sine', 0.02);
    if (s.kick) this.kick(t);
    if (s.snare) this.hiss(t, 0.18, 0.07, 1400);
    if (s.hat) this.hiss(t, 0.04, 0.025, 7000);
    if (Math.random() < 0.18) this.hiss(t + Math.random() * stepSec, 0.01, 0.02, 3000); // crackle
  }

  private tone(
    freq: number,
    t: number,
    dur: number,
    vol: number,
    type: OscillatorType,
    attack: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.setValueAtTime((Math.random() - 0.5) * 8, t); // a little tape wobble
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.lowpass!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    gain.gain.setValueAtTime(0.32, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain);
    gain.connect(this.lowpass!);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  private hiss(t: number, dur: number, vol: number, cutoff: number): void {
    const ctx = this.ctx!;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** The browser's fun audio: this synth, the global sound setting, the remembered toggle. */
export function browserFunAudio(): FunAudio {
  return {
    soundEnabled: isSoundEnabled,
    radio: new LofiRadio(),
    loadRadioOn: () => {
      try {
        return window.localStorage.getItem(RADIO_STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    },
    saveRadioOn: (on) => {
      try {
        window.localStorage.setItem(RADIO_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* private window / blocked storage: not remembered */
      }
    },
  };
}
