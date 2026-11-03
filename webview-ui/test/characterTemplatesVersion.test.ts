import { describe, expect, it } from 'vitest';

import {
  getCharacterSprites,
  getCharacterTemplatesVersion,
  setCharacterTemplates,
  subscribeCharacterTemplates,
} from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';

/** A one-character sheet whose every frame is a single pixel `color`. */
const sheet = (color: string) => {
  const frames = Array.from({ length: 8 }, () => [[color]]);
  return [{ down: frames, up: frames, right: frames }];
};

describe('character sprite replacements', () => {
  it('tell subscribers, so a mug shot drawn from the old sprites redraws', () => {
    setCharacterTemplates(sheet('first'));
    const before = getCharacterTemplatesVersion();
    let heard = 0;
    const unsubscribe = subscribeCharacterTemplates(() => heard++);

    setCharacterTemplates(sheet('second'));
    expect(heard).toBe(1);
    expect(getCharacterTemplatesVersion()).not.toBe(before);
    expect(getCharacterSprites(0).walk[Direction.DOWN][0]).toEqual([['second']]);

    unsubscribe();
    setCharacterTemplates(sheet('third'));
    expect(heard).toBe(1);
  });
});
