/**
 * The office radio's player: Game Boy-style voices in Web Audio (two pulse
 * channels, a soft wave bass, LFSR noise) playing the composer's tunes back to
 * back, scheduled a little ahead of the audio clock.
 *
 * One instance for the whole webview (`officeRadio`); the player UI
 * subscribes to it. Settings (volume, mood) are remembered per browser.
 */
import {
  MUSIC_DEFAULT_VOLUME,
  MUSIC_LOOKAHEAD_HIDDEN_SEC,
  MUSIC_LOOKAHEAD_SEC,
  MUSIC_NAME_REROLLS,
  MUSIC_RECENT_NAMES,
  MUSIC_SKIP_FADE_SEC,
  MUSIC_STORAGE_KEY,
  MUSIC_TICK_MS,
  MUSIC_TONE_CUTOFF_HZ,
  MUSIC_VISUALIZER_HIGH_HZ,
  MUSIC_VISUALIZER_LOW_HZ,
} from '../constants.js';
import {
  makeSong,
  type NoiseEvent,
  type PulseEvent,
  type Song,
  type WaveEvent,
} from './composer.js';
import { chooseMood, MOOD_KEYS, type MoodKey, type MoodSetting } from './moods.js';
import { newSeed } from './rng.js';
import { parseSongCode } from './songCode.js';

const CHANNELS = ['pu1', 'pu2', 'wav', 'noi'] as const;
type Channel = (typeof CHANNELS)[number];
type Bus = Record<Channel, GainNode>;
/** Each channel's level in the mix. */
const CHANNEL_MIX: Record<Channel, number> = { pu1: 0.5, pu2: 0.38, wav: 0.7, noi: 0.22 };
const DUTIES = [0.125, 0.25, 0.5];
const KIT: Record<NoiseEvent['k'], { rate: number; decay: number }> = {
  h: { rate: 0.55, decay: 0.045 },
  s: { rate: 0.16, decay: 0.14 },
  k: { rate: 0.035, decay: 0.09 },
};

export interface RadioState {
  playing: boolean;
  /** The tune on the speakers (or the one that will start on Play). */
  song: Song;
  /** 0-1 through the current tune. */
  progress: number;
  volume: number;
  mood: MoodSetting;
  /** The player is hidden (Settings brings it back). */
  hidden: boolean;
}

interface Stored {
  volume: number;
  mood: MoodSetting;
  hidden: boolean;
}

function loadStored(): Stored {
  const fallback: Stored = { volume: MUSIC_DEFAULT_VOLUME, mood: 'auto', hidden: false };
  try {
    const raw = JSON.parse(localStorage.getItem(MUSIC_STORAGE_KEY) ?? '{}') as Partial<Stored>;
    return {
      volume:
        typeof raw.volume === 'number' ? Math.min(1, Math.max(0, raw.volume)) : fallback.volume,
      mood: ['auto', ...MOOD_KEYS].includes(raw.mood as string)
        ? (raw.mood as MoodSetting)
        : fallback.mood,
      hidden: raw.hidden === true,
    };
  } catch {
    return fallback;
  }
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

class OfficeRadio {
  private ac: AudioContext | null = null;
  private master!: GainNode;
  private channelGain = {} as Record<Channel, GainNode>;
  private pulseWaves: PeriodicWave[] = [];
  private bassWave!: PeriodicWave;
  private noise!: AudioBuffer;
  private buses = new Map<Song, Bus>();
  private analyser: AnalyserNode | null = null;
  private spectrum = new Uint8Array(0);
  private unmutedVolume = 0;

  private current: Song;
  private queued: Song;
  private step = 0;
  private nextTime = 0;
  private playing = false;
  /** When each scheduled tune starts, so the UI shows the one on the speakers. */
  private timeline: Array<{ t: number; song: Song; step: number }> = [];

  private worker: Worker | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private stored = loadStored();
  private snapshot: RadioState;
  private uiTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.current = this.makeNext(null);
    this.queued = this.makeNext(this.current);
    this.snapshot = this.buildState(this.current, 0);
    // A page the browser brings back from its cache (back/forward, an app
    // reopened on a phone) keeps this instance: give it a new tune too, like a reload.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && !this.playing) this.skip();
    });
  }

  // ── Public API ────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): RadioState => this.snapshot;

  async toggle(): Promise<void> {
    if (!this.ac) this.init();
    const ac = this.ac!;
    if (this.playing) {
      this.playing = false;
      this.stopClock();
      await ac.suspend();
    } else {
      await ac.resume();
      this.playing = true;
      if (this.nextTime < ac.currentTime) this.nextTime = ac.currentTime + 0.05;
      this.schedule();
      this.startClock();
    }
    this.refresh();
  }

  skip(): void {
    this.switchTo(this.queued);
  }

  /** Plays the tune a song code names; false when the code isn't one. */
  playCode(code: string): boolean {
    const parsed = parseSongCode(code);
    if (!parsed) return false;
    this.switchTo(makeSong(parsed.seed, parsed.moodKey, null, parsed.root));
    if (!this.playing) void this.toggle();
    return true;
  }

  /** Hides or shows the player. Hiding pauses the music: with the player
   *  gone there would be nothing on screen to stop it with. */
  setHidden(hidden: boolean): void {
    this.stored.hidden = hidden;
    this.save();
    if (hidden && this.playing) void this.toggle();
    this.refresh();
  }

  /** Mutes, or brings back the volume from before muting. */
  toggleMute(): void {
    if (this.stored.volume > 0) {
      this.unmutedVolume = this.stored.volume;
      this.setVolume(0);
    } else this.setVolume(this.unmutedVolume || MUSIC_DEFAULT_VOLUME);
  }

  /** Fills `out` with the mix's loudness (0-1) in `out.length` bands, low to
   *  high on a log scale; all zero while nothing plays. */
  readBands(out: number[]): void {
    const a = this.analyser;
    if (!a || !this.playing) {
      out.fill(0);
      return;
    }
    if (this.spectrum.length !== a.frequencyBinCount)
      this.spectrum = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(this.spectrum);
    const hzPerBin = this.ac!.sampleRate / a.fftSize;
    const ratio = MUSIC_VISUALIZER_HIGH_HZ / MUSIC_VISUALIZER_LOW_HZ;
    for (let b = 0; b < out.length; b++) {
      const lo = MUSIC_VISUALIZER_LOW_HZ * Math.pow(ratio, b / out.length);
      const hi = MUSIC_VISUALIZER_LOW_HZ * Math.pow(ratio, (b + 1) / out.length);
      const i0 = Math.floor(lo / hzPerBin);
      const i1 = Math.max(i0 + 1, Math.ceil(hi / hzPerBin));
      let peak = 0;
      for (let i = i0; i < i1 && i < this.spectrum.length; i++)
        peak = Math.max(peak, this.spectrum[i]);
      out[b] = peak / 255;
    }
  }

  private switchTo(song: Song): void {
    if (this.ac) {
      const now = this.ac.currentTime;
      this.retire(this.current, now, MUSIC_SKIP_FADE_SEC);
      this.nextTime = now + MUSIC_SKIP_FADE_SEC + 0.1;
    }
    this.current = song;
    this.queued = this.makeNext(this.current);
    this.step = 0;
    this.timeline = [];
    this.snapshot = this.buildState(this.current, 0);
    if (this.playing) this.schedule();
    this.emit();
  }

  setVolume(v: number): void {
    this.stored.volume = Math.min(1, Math.max(0, v));
    this.save();
    this.applyVolume();
    this.refresh();
  }

  /** A specific mood starts a tune in it now; Auto applies from the next tune. */
  setMood(mood: MoodSetting): void {
    this.stored.mood = mood;
    this.save();
    this.queued = this.makeNext(this.current);
    if (mood !== 'auto' && this.current.moodKey !== mood) this.skip();
    else this.refresh();
  }

  // ── Audio graph ───────────────────────────────────────────

  private init(): void {
    const ac = new AudioContext();
    this.ac = ac;
    this.master = ac.createGain();
    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.4;
    tone.frequency.value = MUSIC_TONE_CUTOFF_HZ;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    analyser.minDecibels = -75;
    analyser.maxDecibels = -20;
    this.analyser = analyser;
    this.master.connect(tone).connect(ac.destination);
    // The visualizer listens to the mix before the volume, so its bars look
    // the same at any volume (and keep moving while muted).
    const mix = ac.createGain();
    mix.connect(this.master);
    for (const ch of CHANNELS) {
      const g = ac.createGain();
      g.connect(mix);
      this.channelGain[ch] = g;
    }
    // An analyser with no output may never be pulled: route it on through silence.
    const silent = ac.createGain();
    silent.gain.value = 0;
    mix.connect(analyser).connect(silent).connect(ac.destination);
    this.pulseWaves = DUTIES.map((d) => this.makePulse(d));
    // A round bass: a sine with a little 2nd and 3rd harmonic so it still
    // reads on small speakers (the GB's 4-bit wave staircase grates).
    this.bassWave = ac.createPeriodicWave(
      new Float32Array(5),
      new Float32Array([0, 1, 0.28, 0.1, 0.03]),
    );
    this.noise = this.makeNoise();
    this.applyVolume();
  }

  private makePulse(d: number): PeriodicWave {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      re[k] = Math.sin(2 * Math.PI * k * d) / (Math.PI * k);
      im[k] = (1 - Math.cos(2 * Math.PI * k * d)) / (Math.PI * k);
    }
    return this.ac!.createPeriodicWave(re, im);
  }

  /** One second of 15-bit LFSR noise, like the GB noise channel. */
  private makeNoise(): AudioBuffer {
    const ac = this.ac!;
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = buf.getChannelData(0);
    let lfsr = 0x7fff;
    for (let i = 0; i < d.length; i++) {
      const bit = (lfsr ^ (lfsr >> 1)) & 1;
      lfsr = (lfsr >> 1) | (bit << 14);
      d[i] = lfsr & 1 ? 0.6 : -0.6;
    }
    return buf;
  }

  private applyVolume(): void {
    if (!this.ac) return;
    const v = this.stored.volume;
    this.master.gain.setTargetAtTime(v * v * 0.9, this.ac.currentTime, 0.03);
  }

  private busFor(song: Song): Bus {
    let bus = this.buses.get(song);
    if (!bus) {
      bus = {} as Bus;
      for (const ch of CHANNELS) {
        const g = this.ac!.createGain();
        g.gain.value = CHANNEL_MIX[ch];
        g.connect(this.channelGain[ch]);
        bus[ch] = g;
      }
      this.buses.set(song, bus);
    }
    return bus;
  }

  /** Fades a tune's voices out and lets go of them. */
  private retire(song: Song, at: number, fade: number): void {
    const bus = this.buses.get(song);
    if (!bus || !this.ac) return;
    this.buses.delete(song);
    for (const ch of CHANNELS) {
      bus[ch].gain.setValueAtTime(CHANNEL_MIX[ch], at);
      bus[ch].gain.linearRampToValueAtTime(0, at + fade);
    }
    const ms = (at - this.ac.currentTime + fade + 4) * 1000;
    setTimeout(() => {
      for (const ch of CHANNELS) bus[ch].disconnect();
    }, ms);
  }

  // GB volume envelope: 16 levels, one level down every `es` seconds to a floor.
  private envelope(g: GainNode, t: number, dur: number, ev: PulseEvent): void {
    const p = g.gain;
    const scale = 0.5;
    let lvl = ev.v;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime((lvl / 15) * scale, t + 0.005);
    if (ev.es > 0)
      for (let tt = t + ev.es; lvl > ev.ef && tt < t + dur; tt += ev.es) {
        lvl--;
        p.setTargetAtTime((lvl / 15) * scale, tt, 0.006);
      }
    p.setValueAtTime((lvl / 15) * scale, t + dur);
    p.linearRampToValueAtTime(0, t + dur + 0.015);
  }

  private playPulse(out: GainNode, t: number, ev: PulseEvent, stepDur: number): void {
    const ac = this.ac!;
    const dur = Math.max(0.03, ev.len * stepDur * 0.92);
    const o = ac.createOscillator();
    o.setPeriodicWave(this.pulseWaves[ev.duty]);
    o.frequency.setValueAtTime(mtof(ev.m), t);
    const g = ac.createGain();
    this.envelope(g, t, dur, ev);
    if (ev.vib && dur > 0.35) {
      const lfo = ac.createOscillator();
      const depth = ac.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.setValueAtTime(0, t + 0.22);
      depth.gain.linearRampToValueAtTime(12, t + 0.5);
      lfo.connect(depth).connect(o.detune);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private playWave(out: GainNode, t: number, ev: WaveEvent, stepDur: number): void {
    const ac = this.ac!;
    const dur = Math.max(0.03, ev.len * stepDur * (ev.gate ?? 0.86));
    const o = ac.createOscillator();
    o.setPeriodicWave(this.bassWave);
    o.frequency.setValueAtTime(mtof(ev.m), t);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.v * 0.6, t + 0.006);
    g.gain.setValueAtTime(ev.v * 0.6, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private playNoise(out: GainNode, t: number, ev: NoiseEvent): void {
    const ac = this.ac!;
    const k = KIT[ev.k];
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = k.rate;
    const g = ac.createGain();
    g.gain.setValueAtTime(ev.v * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + k.decay);
    s.connect(g).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + k.decay + 0.02);
  }

  // ── Scheduling ────────────────────────────────────────────

  /** Names of the last few tunes picked, so a new one doesn't repeat them. */
  private recentNames: string[] = [];

  private makeNext(after: Song | null): Song {
    const mood: MoodKey = chooseMood(
      this.stored.mood,
      after?.moodKey ?? null,
      new Date().getHours(),
    );
    // Reroll a name heard lately (the music would differ, the title wouldn't).
    let song = makeSong(newSeed(), mood, after?.root ?? null);
    for (let i = 0; i < MUSIC_NAME_REROLLS && this.recentNames.includes(song.name); i++) {
      song = makeSong(newSeed(), mood, after?.root ?? null);
    }
    this.recentNames = [...this.recentNames, song.name].slice(-MUSIC_RECENT_NAMES);
    return song;
  }

  private schedule = (): void => {
    const ac = this.ac;
    if (!ac || !this.playing) return;
    const ahead = document.hidden ? MUSIC_LOOKAHEAD_HIDDEN_SEC : MUSIC_LOOKAHEAD_SEC;
    while (this.nextTime < ac.currentTime + ahead) {
      const song = this.current;
      const ev = song.steps[this.step];
      const bus = this.busFor(song);
      if (ev.pu1) this.playPulse(bus.pu1, this.nextTime, ev.pu1, song.stepDur);
      if (ev.pu2) this.playPulse(bus.pu2, this.nextTime, ev.pu2, song.stepDur);
      if (ev.wav) this.playWave(bus.wav, this.nextTime, ev.wav, song.stepDur);
      if (ev.noi) this.playNoise(bus.noi, this.nextTime, ev.noi);
      if (this.step % 16 === 0) this.timeline.push({ t: this.nextTime, song, step: this.step });
      this.nextTime += song.stepDur;
      this.step++;
      if (this.step >= song.steps.length) {
        this.retire(song, this.nextTime, 0.05);
        this.current = this.queued;
        this.queued = this.makeNext(this.current);
        this.step = 0;
      }
    }
  };

  /** A worker clock keeps time in background tabs, where page timers get throttled. */
  private startClock(): void {
    if (!this.worker && !this.intervalId) {
      try {
        const src = `let id=null;onmessage=e=>{if(e.data==='go'){if(!id)id=setInterval(()=>postMessage(0),${MUSIC_TICK_MS})}else{clearInterval(id);id=null}}`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = this.schedule;
        w.onerror = () => {
          w.terminate();
          this.worker = null;
          if (this.playing && !this.intervalId)
            this.intervalId = setInterval(this.schedule, MUSIC_TICK_MS);
        };
        this.worker = w;
      } catch {
        this.intervalId = setInterval(this.schedule, MUSIC_TICK_MS);
      }
    }
    this.worker?.postMessage('go');
    if (!this.uiTimer) this.uiTimer = setInterval(this.refresh, 1000);
  }

  private stopClock(): void {
    this.worker?.postMessage('stop');
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.uiTimer = null;
  }

  // ── UI state ──────────────────────────────────────────────

  /** Re-reads what is on the speakers now and tells subscribers if it changed. */
  private refresh = (): void => {
    let song = this.snapshot.song;
    let step = Math.round(this.snapshot.progress * song.steps.length);
    if (this.ac) {
      const now = this.ac.currentTime;
      while (this.timeline.length > 1 && this.timeline[1].t <= now) this.timeline.shift();
      const mark = this.timeline[0];
      if (mark && mark.t <= now) {
        song = mark.song;
        step = mark.step + Math.floor((now - mark.t) / song.stepDur);
      }
    }
    const next = this.buildState(song, step);
    const s = this.snapshot;
    if (
      next.song !== s.song ||
      next.playing !== s.playing ||
      next.volume !== s.volume ||
      next.mood !== s.mood ||
      next.hidden !== s.hidden ||
      Math.abs(next.progress - s.progress) > 0.002
    ) {
      this.snapshot = next;
      this.emit();
    }
  };

  private buildState(song: Song, step: number): RadioState {
    return {
      playing: this.playing,
      song,
      progress: Math.min(1, step / song.steps.length),
      volume: this.stored.volume,
      mood: this.stored.mood,
      hidden: this.stored.hidden,
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify(this.stored));
    } catch {
      // Private window or blocked storage: settings last for this session only.
    }
  }
}

export const officeRadio = new OfficeRadio();
