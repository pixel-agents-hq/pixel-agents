/** The composer's seeded random stream: one seed, one tune (mulberry32). */

/** Choices with their relative weights. */
export type Weighted<T> = Array<[T, number]>;

export interface Rng {
  (): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  weighted<T>(list: Weighted<T>): T;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const f = (() => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  f.weighted = (list) => {
    let s = 0;
    for (const [, w] of list) s += w;
    let x = f() * s;
    for (const [v, w] of list) {
      x -= w;
      if (x < 0) return v;
    }
    return list[list.length - 1][0];
  };
  return f;
}

export const newSeed = (): number => (Math.random() * 4294967296) >>> 0;
