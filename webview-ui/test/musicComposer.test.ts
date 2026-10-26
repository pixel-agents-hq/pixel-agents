import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeSong } from '../src/music/composer.js';
import { chooseMood, MOOD_KEYS, type MoodKey } from '../src/music/moods.js';
import { parseSongCode, songCode } from '../src/music/songCode.js';

/** A tune's fingerprint: every field, every step. */
const fingerprint = (song: unknown): string =>
  createHash('sha256').update(JSON.stringify(song)).digest('hex').slice(0, 16);

/**
 * Tunes as the composer wrote them when song codes were first shared: a code
 * replays its tune only while every random draw comes in the same order, so a
 * refactor that moves one draw changes these.
 */
const PINNED_SONGS: Array<[MoodKey, number, number | null, string, string, string]> = [
  ['town', 1, null, '548ee39e77bd409c', 'TOWN-0-00000001', 'Nimbus Arcade'],
  ['town', 3735928559, 50, '63289972845aa595', 'TOWN-6-DEADBEEF', 'Floor 39 Lobby'],
  ['town', 37035, 58, 'afa82507357f7122', 'TOWN-3-000090AB', 'Pixel Atrium'],
  ['route', 2, null, '8ccfca783d2b0cfe', 'ROUTE-2-00000002', 'Maglev to the Mainframe'],
  ['route', 3735927582, 51, '2ca2199e05472214', 'ROUTE-6-DEADBB1E', 'Helix Skyway'],
  ['route', 49380, 58, 'e22728ef9db9fa9c', 'ROUTE-5-0000C0E4', 'Lyra Skyway'],
  ['lab', 3, null, 'd909dba5be450f8c', 'LAB-0-00000003', 'Module 37'],
  ['lab', 3735926605, 52, 'ad2376ce10b1ca38', 'LAB-7-DEADB74D', 'The Server Spire'],
  ['lab', 61725, 58, '0f132e83d9ea7da1', 'LAB-1-0000F11D', 'Logic Gate 7.8'],
  ['night', 4, null, '1c0dc62169f03609', 'NIGHT-2-00000004', 'Night Tram, 1 AM'],
  ['night', 3735925628, 53, 'ba118a36a98c0ecd', 'NIGHT-5-DEADB37C', 'Starlit Server Room'],
  ['night', 74070, 58, 'ef114354e960cd04', 'NIGHT-8-00012156', 'Sleeping Spire, 1 AM'],
  ['orbit', 5, null, 'd942acb812545b94', 'ORBIT-6-00000005', 'Solar Array'],
  ['orbit', 3735924651, 54, '0cd32804f0d49d1c', 'ORBIT-6-DEADAFAB', 'Solar Array Nimbus'],
  ['orbit', 86415, 58, 'af20d5f1d1c7de5f', 'ORBIT-2-0001518F', 'Drifting Past Orion'],
  ['rain', 6, null, 'be7ecc9eea7b059e', 'RAIN-0-00000006', 'Rain on the Arcade Awning'],
  ['rain', 3735923674, 55, 'fcad9713ca55ebd0', 'RAIN-3-DEADABDA', 'Fog on Floor 74'],
  ['rain', 98760, 58, '299edda7b6010d3e', 'RAIN-2-000181C8', 'Echo in the Rain'],
  ['dawn', 7, null, 'a1fc2825a7187910', 'DAWN-0-00000007', 'First Light on Tycho'],
  ['dawn', 3735922697, 56, 'cab80f5a159f00df', 'DAWN-0-DEADA809', 'Good Morning, Lyra'],
  ['dawn', 111105, 58, 'bc28e45decf54bee', 'DAWN-5-0001B201', 'First Light on Nova'],
  ['arcade', 8, null, 'd9792032680d3bf4', 'ARCADE-5-00000008', 'Level 52'],
  ['arcade', 3735921720, 57, '73b287291446dcc3', 'ARCADE-2-DEADA438', 'Level 53'],
  ['arcade', 123450, 58, '4bee0f0a03e82e20', 'ARCADE-3-0001E23A', 'Stage 8-2'],
];

/** Song codes and the tunes they play: [code, fingerprint, name]. */
const PINNED_CODES: Array<[string, string, string]> = [
  ['TOWN-0-00000001', '548ee39e77bd409c', 'Nimbus Arcade'],
  ['NIGHT-8-CF53FFB0', '3727ab232fd23f07', 'Night Tram'],
  ['ARCADE-4-8F3A21C0', 'dee29c47b3e828b4', 'Warp Zone'],
  ['RAIN-3-0000BEEF', 'e4b1e0eee12ec5ef', 'Storm Window'],
  ['LAB-7-FFFFFFFF', 'e2d75d3079cc43eb', 'The Cryo Vault'],
];

describe('music composer', () => {
  it('writes the same tune from the same seed, mood and previous root', () => {
    const a = makeSong(1234, 'town', 55);
    const b = makeSong(1234, 'town', 55);
    expect(b.name).toBe(a.name);
    expect(JSON.stringify(b.steps)).toBe(JSON.stringify(a.steps));
  });

  it('writes playable tunes of a few minutes in every mood', () => {
    for (const mood of MOOD_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const song = makeSong(seed * 7919, mood, seed % 2 ? null : 54);
        const minutes = (song.steps.length * song.stepDur) / 60;
        expect(minutes).toBeGreaterThan(2);
        expect(minutes).toBeLessThan(5);
        expect(song.root).toBeGreaterThanOrEqual(50);
        expect(song.root).toBeLessThanOrEqual(58);
        let melodyNotes = 0;
        song.steps.forEach((step, i) => {
          for (const ch of ['pu1', 'pu2', 'wav'] as const) {
            const ev = step[ch];
            if (!ev) continue;
            expect(Number.isFinite(ev.m)).toBe(true);
            expect(ev.len).toBeGreaterThan(0);
            // Monophonic: a note never runs into the next note on its channel.
            for (let j = i + 1; j < i + ev.len; j++) expect(song.steps[j]?.[ch]).toBeUndefined();
          }
          if (step.pu1) melodyNotes++;
        });
        expect(melodyNotes).toBeGreaterThan(40);
      }
    }
  });

  it('keeps a picked mood, and Auto picks one of the moods', () => {
    expect(chooseMood('lab', 'town', 12)).toBe('lab');
    expect(MOOD_KEYS).toContain(chooseMood('auto', 'night', 23));
  });

  it('never picks Arcade on Auto, and leans toward Dawn in the morning', () => {
    const count = (hour: number) => {
      const n: Record<string, number> = {};
      for (let i = 0; i < 4000; i++) {
        const m = chooseMood('auto', 'town', hour);
        n[m] = (n[m] ?? 0) + 1;
      }
      return n;
    };
    const morning = count(8);
    const afternoon = count(15);
    expect(morning.arcade ?? 0).toBe(0);
    expect(afternoon.arcade ?? 0).toBe(0);
    expect(morning.dawn).toBeGreaterThan((afternoon.dawn ?? 0) * 4);
  });

  it('plays back the exact tune from its song code', () => {
    const song = makeSong(0xbeef42, 'night', 57); // a root reached through prevRoot
    const parsed = parseSongCode(songCode(song));
    expect(parsed).not.toBeNull();
    const again = makeSong(parsed!.seed, parsed!.moodKey, null, parsed!.root);
    expect(again.name).toBe(song.name);
    expect(again.root).toBe(song.root);
    expect(JSON.stringify(again.steps)).toBe(JSON.stringify(song.steps));
  });

  it('writes every pinned tune exactly as before', () => {
    for (const [mood, seed, prevRoot, print, code, name] of PINNED_SONGS) {
      const song = makeSong(seed, mood, prevRoot);
      expect(song.name).toBe(name);
      expect(songCode(song)).toBe(code);
      expect(fingerprint(song)).toBe(print);
    }
  });

  it('plays every pinned song code exactly as before, and writes the same code back', () => {
    for (const [code, print, name] of PINNED_CODES) {
      const parsed = parseSongCode(code)!;
      const song = makeSong(parsed.seed, parsed.moodKey, null, parsed.root);
      expect(song.name).toBe(name);
      expect(songCode(song)).toBe(code);
      expect(fingerprint(song)).toBe(print);
    }
  });

  it('refuses what is not a song code', () => {
    for (const bad of ['', 'hello', 'DISCO-5-8F3A21C0', 'TOWN-9-8F3A21C0', 'TOWN-5-XYZ'])
      expect(parseSongCode(bad)).toBeNull();
    expect(parseSongCode(' town-0-ff ')).toEqual({ moodKey: 'town', root: 50, seed: 255 });
    // Typed from the screen, where 0 looks like o.
    expect(parseSongCode('NIGHT-o-CF53FFBo')).toEqual(parseSongCode('NIGHT-0-CF53FFB0'));
  });
});
