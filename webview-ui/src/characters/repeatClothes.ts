/**
 * How a repeated character looks: the nth repeat (core paletteUtils `repeat`)
 * wears every piece of clothing colorized to the nth REPEAT_CLOTHES_HUES
 * colour, so the outfit changes colour in sync while skin, hair, eyes and
 * accessories stay the character's own. An external char_N.png has no clothes
 * the office can tell apart, so its repeat is hue-turned whole instead.
 */

import type { CharacterColor, CharacterProfile } from '../../../core/src/characterProfiles.js';
import { REPEAT_CLOTHES_HUES, REPEAT_CLOTHES_SATURATION } from '../constants.js';
import type { ColorKey } from './slots.js';

/** The colours that dress a character: clothes, underwear and hat. */
export const CLOTHES_COLOR_KEYS = [
  'under',
  'utop',
  'pants',
  'top',
  'full',
  'jacket',
  'shoes',
  'hat',
] as const satisfies readonly ColorKey[];

/** Where the nth repeat (n ≥ 1) is in the colour list; past its end, it cycles. */
function colourIndex(repeat: number): number {
  return (repeat - 1) % REPEAT_CLOTHES_HUES.length;
}

/**
 * The profile with its clothes in its repeat's colour (repeat 0 = unchanged).
 * A piece keeps its colourway swap, brightness and contrast, so its shading (a
 * dark suit stays dark) survives; only its hue and saturation are set.
 */
export function withRepeatClothes(p: CharacterProfile, repeat: number): CharacterProfile {
  if (repeat <= 0) return p;
  const hue = REPEAT_CLOTHES_HUES[colourIndex(repeat)];
  const colors: CharacterProfile['colors'] = { ...p.colors };
  for (const key of CLOTHES_COLOR_KEYS) {
    const own: CharacterColor | undefined = p.colors?.[key];
    colors[key] = {
      ...own,
      h: hue,
      s: REPEAT_CLOTHES_SATURATION,
      b: own?.b ?? 0,
      c: own?.c ?? 0,
      colorize: true,
    };
  }
  return { ...p, colors };
}

/** How far an external sprite's repeat turns its hue, in degrees: the nth
 *  colour turns it n/(colours+1) of the wheel, so every copy differs. */
export function repeatHueTurn(repeat: number): number {
  if (repeat <= 0) return 0;
  return Math.round(((colourIndex(repeat) + 1) * 360) / (REPEAT_CLOTHES_HUES.length + 1));
}
