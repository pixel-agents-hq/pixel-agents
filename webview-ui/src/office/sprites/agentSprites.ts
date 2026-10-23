/**
 * The sprite set a character is drawn with: Ansh his own human sheet; an agent
 * its Clawd (tinted, with its accessory, blinking now and then) under the
 * Clawd look, else the chibi sheet the office assigned it. The other NPCs
 * always get the chibi. One call for the renderer, the crown, the matrix
 * effect and the mug shot, so they agree.
 */

import { ANSH_NPC_ID } from '../../constants.js';
import type { LookSubject } from '../agentLook.js';
import { blinkClosed, clawdIdentity, lookOf } from '../agentLook.js';
import { Direction } from '../types.js';
import { getAnshSprites } from './anshSprites.js';
import { getClawdSprites } from './clawdSprites.js';
import type { CharacterSprites } from './spriteData.js';
import { getCharacterSprites } from './spriteData.js';

/**
 * @param ch       the character (or an appearance: id, palette, hueShift, repo...)
 * @param parent   a sub-agent's parent, for its tint
 * @param nowSec   the clock for blinking; omit for a frame that never blinks
 * @param dir      the character's direction (a Clawd facing away has no eyes to shut)
 */
export function characterSpritesFor(
  ch: LookSubject,
  parent?: LookSubject,
  nowSec?: number,
  dir?: Direction,
): CharacterSprites {
  if (ch.id === ANSH_NPC_ID) return getAnshSprites();
  if (lookOf(ch) === 'classic') return getCharacterSprites(ch.palette, ch.hueShift);
  const identity = clawdIdentity(ch, parent);
  const blink = nowSec !== undefined && dir !== Direction.UP && blinkClosed(nowSec, ch.id);
  return getClawdSprites(identity.tint, identity.accessory, blink);
}
