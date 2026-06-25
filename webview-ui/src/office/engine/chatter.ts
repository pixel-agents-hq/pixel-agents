import { IDLE_PHRASES } from '../data/dialogues.js';

let lastIndex = -1;

export function getRandomPhrase(): string | null {
  try {
    if (IDLE_PHRASES.length === 0) {
      return null;
    }

    if (IDLE_PHRASES.length === 1) return IDLE_PHRASES[0];

    let index: number;
    do {
      index = Math.floor(Math.random() * IDLE_PHRASES.length);
    } while (index === lastIndex);

    lastIndex = index;
    return IDLE_PHRASES[index];
  } catch {
    return null;
  }
}
