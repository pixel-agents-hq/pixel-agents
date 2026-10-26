import { describe, expect, it, vi } from 'vitest';

import { isRecord } from '../../core/src/isRecord.js';
import { newLocalId } from '../../core/src/localId.js';
import { isItemPiece, ITEM_PIECES } from '../../core/src/wardrobeItems.js';

describe('isRecord', () => {
  it('accepts objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, 0, '', 'x', [], [1], true]) expect(isRecord(v)).toBe(false);
  });
});

describe('newLocalId', () => {
  it('is prefix + base-36 time + separator + random tail', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const time = (1_700_000_000_000).toString(36);
    const tail = (0.123456789).toString(36).slice(2);
    expect(newLocalId('c', 6)).toBe(`c${time}${tail.slice(0, 6)}`);
    expect(newLocalId('custom_', 6)).toBe(`custom_${time}${tail.slice(0, 6)}`);
    expect(newLocalId('', undefined, '-')).toBe(`${time}-${tail}`);
    vi.restoreAllMocks();
  });
});

describe('ITEM_PIECES', () => {
  it('is every part slot but the body and its underwear, in slot order', () => {
    expect(ITEM_PIECES).toEqual([
      'hair',
      'beard',
      'top',
      'jacket',
      'pants',
      'shoes',
      'full',
      'hat',
      'necklace',
      'lanyard',
      'earrings',
      'shades',
      'hairshades',
      'watch',
    ]);
    expect(isItemPiece('body')).toBe(false);
    expect(isItemPiece('hat')).toBe(true);
  });
});
