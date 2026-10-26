import { CHARACTER_PROFILE_VERSION, type CharacterProfile } from './characterProfiles.js';

/**
 * The six characters a new office starts with: the original bundled cast, rebuilt
 * from wardrobe parts (part ids and colourways are the wardrobe manifest's).
 */
const CAST: readonly Omit<CharacterProfile, 'v'>[] = [
  {
    name: 'Suit',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'mop',
    pants: 'shorts',
    shoes: 'boots',
    full: 'business_suit',
    colors: {
      hair: { h: 29, s: 42, b: -18, c: 6, colorize: true },
      shoes: { h: 0, s: 0, b: 0, c: 0, palette: 'Black' },
      pants: { h: 207, s: 75, b: -19, c: -4, colorize: true },
    },
  },
  {
    name: 'Dress',
    body: 'bust',
    eyeShape: 'lashes',
    utop: 'basic',
    under: 'basic',
    hair: 'long',
    full: 'dress',
    colors: {
      full: { h: 0, s: 0, b: 0, c: 0, palette: 'Black' },
      hair: { h: 28, s: 55, b: 8, c: 15, colorize: true },
    },
  },
  {
    name: 'Spike',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'spiky',
    top: 'long_sleeved_shirt',
    pants: 'shorts',
    shoes: 'boots',
    colors: {
      hair: { h: 24, s: 54, b: -57, c: -57, colorize: true },
      shoes: { h: 0, s: 0, b: 0, c: 0, palette: 'Black' },
      top: { h: 347, s: 0, b: 93, c: 93, colorize: true },
      pants: { h: 207, s: 75, b: -19, c: -4, colorize: true },
    },
  },
  {
    name: 'Aura',
    body: 'bust',
    eyeShape: 'plain',
    utop: 'basic',
    under: 'basic',
    hair: 'parted',
    top: 'long_sleeved_shirt',
    pants: 'shorts',
    colors: {
      pants: { h: 16, s: 17, b: 36, c: 40, colorize: true },
      hair: { h: 12, s: 12, b: 72, c: -25, colorize: true },
      top: { h: 347, s: 0, b: 93, c: 93, colorize: true },
      skin: { h: 0, s: 0, b: 0, c: 0, palette: 'Tan' },
    },
  },
  {
    name: 'Tidy',
    body: 'bust',
    eyeShape: 'lashes',
    utop: 'basic',
    under: 'basic',
    hair: 'bob',
    top: 'long_sleeved_shirt',
    pants: 'shorts',
    colors: {
      top: { h: 4, s: 55, b: 6, c: 1, colorize: true },
      hair: { h: 9, s: 5, b: -72, c: -79, colorize: true },
      pants: { h: 7, s: 2, b: -70, c: -69, colorize: true },
      skin: { h: 0, s: 0, b: 0, c: 0, palette: 'Pale' },
    },
  },
  {
    name: 'Bob',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'parted',
    top: 'tshirt',
    jacket: 'vest',
    pants: 'low_cut_jeans',
    shoes: 'sneakers',
    colors: {
      top: { h: 2, s: 75, b: -28, c: -10, colorize: true },
      jacket: { h: 0, s: 0, b: 0, c: 0, palette: 'Original' },
      hair: { h: 9, s: 5, b: -72, c: -79, colorize: true },
      shoes: { h: 0, s: 0, b: 0, c: 0, palette: 'White' },
      pants: { h: 227, s: 29, b: -34, c: -24, colorize: true },
      skin: { h: 0, s: 0, b: 0, c: 0, palette: 'Dark' },
    },
  },
];

/** The ids are the ones a list saved without ids reads with (parseCharacterProfiles). */
export const DEFAULT_CHARACTER_PROFILES: readonly CharacterProfile[] = CAST.map((p, i) => ({
  id: `char-${i}`,
  ...p,
  v: CHARACTER_PROFILE_VERSION,
}));
