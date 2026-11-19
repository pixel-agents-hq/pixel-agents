import { type CharacterProfile, GREETER_CHARACTER_ID } from './characterProfiles.js';

export { GREETER_CHARACTER_ID };

/** The greeter's character as a palette index: the profile whose id is
 *  GREETER_CHARACTER_ID, else the first in the cast. */
export function greeterPalette(profiles: readonly CharacterProfile[]): number {
  const index = profiles.findIndex((p) => p.id === GREETER_CHARACTER_ID);
  return index >= 0 ? index : 0;
}
