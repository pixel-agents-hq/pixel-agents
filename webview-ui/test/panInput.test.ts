import { describe, expect, it } from 'vitest';

import { pressPan, releaseAllPan, releasePan, subscribePanInput } from '../src/office/panInput.js';

describe('panInput', () => {
  it('delivers presses and releases to every subscriber', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = subscribePanInput((e) =>
      a.push(`${e.kind}:${e.dir?.dx ?? ''},${e.dir?.dy ?? ''}`),
    );
    const offB = subscribePanInput((e) => b.push(e.kind));

    pressPan({ dx: -1, dy: 0 });
    releasePan({ dx: -1, dy: 0 });
    releaseAllPan();

    expect(a).toEqual(['press:-1,0', 'release:-1,0', 'releaseAll:,']);
    expect(b).toEqual(['press', 'release', 'releaseAll']);
    offA();
    offB();
  });

  it('stops delivering after unsubscribe', () => {
    const seen: string[] = [];
    const off = subscribePanInput((e) => seen.push(e.kind));
    off();
    pressPan({ dx: 0, dy: 1 });
    expect(seen).toEqual([]);
  });
});
