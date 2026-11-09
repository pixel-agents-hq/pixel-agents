import { describe, expect, it } from 'vitest';

import { History } from '../src/characters/history.js';

const make = () => new History<string>({ mergeMs: 500, limit: 3 });

describe('History grouping', () => {
  it('merges changes within mergeMs into one step, then starts another', () => {
    const h = make();
    h.record('a', null, 0);
    h.record('ab', null, 100);
    h.record('abc', null, 700);
    expect(h.undo('abcd')).toEqual({ state: 'abc', frame: null });
    expect(h.undo('abc')).toEqual({ state: 'a', frame: null });
    expect(h.undo('a')).toBeNull();
  });

  it('a press starts a step and everything until its release joins it, however slow', () => {
    const h = make();
    h.record('a', null, 0);
    h.beginStep();
    h.record('b', 2, 100); // within mergeMs, but the press starts a step
    h.record('c', 2, 5000); // held: joins
    h.endStep();
    h.record('d', null, 5100); // released, within mergeMs: merges by time
    expect(h.undo('e')?.state).toBe('b');
    expect(h.undo('b')?.state).toBe('a');
  });

  it('a press with no change makes no step', () => {
    const h = make();
    h.beginStep();
    h.endStep();
    expect(h.canUndo).toBe(false);
  });

  it('entries remember the frame; redo returns to where undo left', () => {
    const h = make();
    h.record('a', 7, 0);
    const entry = h.undo('b');
    expect(entry).toEqual({ state: 'a', frame: 7 });
    expect(h.canRedo).toBe(true);
    expect(h.redo('a')).toEqual({ state: 'b', frame: 7 });
  });

  it('after an undo the next change is a step of its own; a change clears redo', () => {
    const h = make();
    h.record('a', null, 0);
    h.record('b', null, 600);
    h.undo('c');
    h.record('b', null, 650);
    expect(h.canRedo).toBe(false);
    expect(h.undo('x')?.state).toBe('b');
    expect(h.undo('b')?.state).toBe('a');
  });

  it('keeps at most `limit` steps and clear() forgets them all', () => {
    const h = make();
    for (let i = 0; i < 5; i++) h.record(String(i), null, i * 1000);
    let n = 0;
    while (h.undo('x')) n++;
    expect(n).toBe(3);
    h.record('a', null, 99_000);
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});
