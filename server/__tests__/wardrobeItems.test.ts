import { describe, expect, it } from 'vitest';

import { MAX_WARDROBE_ITEMS, parseWardrobeItems } from '../../core/src/wardrobeItems.js';

const item = { id: 'custom_a1', piece: 'hair', label: 'Mine', base: 'bob', png: 'iVBORw0KGgo=' };

describe('parseWardrobeItems', () => {
  it('accepts a list of valid items, the empty one included', () => {
    expect(parseWardrobeItems([item])).toEqual([item]);
    expect(parseWardrobeItems([])).toEqual([]);
  });

  it.each([
    ['an id that could shadow a built-in part', { ...item, id: 'bob' }],
    ['a body, which owns its underwear', { ...item, piece: 'body' }],
    ['underwear', { ...item, piece: 'utop' }],
    ['an empty label', { ...item, label: '  ' }],
    ['a png that is not base64', { ...item, png: 'not base64!' }],
    ['an unknown field', { ...item, extra: 1 }],
    ['a missing base', { ...item, base: undefined }],
  ])('refuses %s', (_, bad) => {
    expect(parseWardrobeItems([bad])).toBeNull();
  });

  it('refuses repeated ids, a non-list and too many items', () => {
    expect(parseWardrobeItems([item, { ...item }])).toBeNull();
    expect(parseWardrobeItems({ items: [item] })).toBeNull();
    const many = Array.from({ length: MAX_WARDROBE_ITEMS + 1 }, (_, i) => ({
      ...item,
      id: `custom_${i}`,
    }));
    expect(parseWardrobeItems(many)).toBeNull();
  });
});
