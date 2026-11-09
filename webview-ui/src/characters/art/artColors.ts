/** Swatch colours for the character colour pickers (art data, exempt from the colour lint rules). */

/** Swatches for colours with no category palette (eyes, lashes, underwear). */
export const SWATCHES = {
  eyes: [
    '#3b2a20',
    '#6b4a2e',
    '#8a6a3a',
    '#2f6fd0',
    '#5fa8e0',
    '#3fa37a',
    '#7a8f3a',
    '#8c8c9e',
    '#a0386e',
    '#d14249',
  ],
  lashes: ['#000000', '#2a1a14', '#4a2c1d', '#6b4a2e', '#35406b', '#a0386e', '#3fa37a'],
  default: [
    '#1f2233',
    '#35406b',
    '#2f6fd0',
    '#3fa37a',
    '#7a8f3a',
    '#e0b45c',
    '#ff8d14',
    '#d14249',
    '#a0386e',
    '#6030ff',
    '#d9d9e3',
    '#6b5a4a',
  ],
} as const;

/** What gray art nobody has coloured is worn in (underwear stays gray). */
export const DEFAULT_COLORS = {
  /** Clothes with a palette: its square of this name. */
  clothesSquare: 'White',
  /** Hair: the palette square of this colour (the dark brown). */
  hairHex: '#342218',
} as const;
