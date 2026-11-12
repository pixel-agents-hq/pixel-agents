/**
 * The Intro's dialog, the DOM-free part: how the greeter's words are cut into
 * messages short enough for the box, and where the camera aims while it
 * speaks. IntroDialog only measures and renders.
 */

import {
  INTRO_CAMERA_CHARACTER_RISE_WORLD,
  INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  INTRO_DIALOG_LETTER_PX,
  INTRO_DIALOG_MIN_LETTERS,
  INTRO_DIALOG_PADDING_X_PX,
  INTRO_DIALOG_ROWS,
} from '../constants.js';
import { overlayProjection } from '../office/projection.js';

/** How many letters one message may hold in a dialog box `boxWidth` CSS px wide. */
export function dialogLetterBudget(boxWidth: number): number {
  const perRow = Math.floor((boxWidth - INTRO_DIALOG_PADDING_X_PX) / INTRO_DIALOG_LETTER_PX);
  return Math.max(INTRO_DIALOG_MIN_LETTERS, perRow * INTRO_DIALOG_ROWS);
}

/** Cut `text` at spaces into pieces of at most `budget` letters (a single
 *  longer word stays whole). */
function cutAtWords(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (piece !== '' && piece.length + 1 + word.length > budget) {
      pieces.push(piece);
      piece = word;
    } else {
      piece = piece === '' ? word : `${piece} ${word}`;
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/**
 * The messages the dialog shows one at a time: each line as written when it
 * fits `budget` letters, else cut at its sentence ends (whole sentences packed
 * together while they fit), and a sentence too long by itself at its spaces.
 * Nothing is dropped or reworded: the messages read in order are the lines.
 */
export function dialogMessages(lines: readonly string[], budget: number): string[] {
  const messages: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    if (text.length <= budget) {
      messages.push(text);
      continue;
    }
    // A sentence ends at . ! ? (and a closing quote or bracket) before a space.
    const sentences = text.match(/.+?[.!?]["')\]]*(?=\s|$)|.+$/g) ?? [text];
    let message = '';
    for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
      if (message !== '' && message.length + 1 + sentence.length <= budget) {
        message = `${message} ${sentence}`;
        continue;
      }
      if (message !== '') messages.push(message);
      const pieces = cutAtWords(sentence, budget);
      messages.push(...pieces.slice(0, -1));
      message = pieces[pieces.length - 1] ?? '';
    }
    if (message !== '') messages.push(message);
  }
  return messages;
}

export interface IntroCameraFrame {
  layout: { cols: number; rows: number };
  containerRect: { width: number; height: number };
  zoom: number;
  pan: { x: number; y: number };
  dpr: number;
  /** Greeter anchor (feet), world coords. */
  greeter: { x: number; y: number };
  /** CSS px of the office's foot the dialog box covers. */
  coveredHeight: number;
}

/**
 * The world point the camera centres while the greeter speaks: the greeter's
 * spot, moved down by half of what the dialog box covers, so the character
 * stands in the middle of the office left in view above it. On a panel too
 * short for that, the box is counted only up to the point that still leaves
 * the character on screen.
 */
export function introCameraTarget(frame: IntroCameraFrame): { x: number; y: number } {
  const project = overlayProjection(
    frame.layout,
    frame.containerRect,
    frame.zoom,
    frame.pan,
    frame.dpr,
  );
  const covered = Math.min(
    project.toWorldLength(Math.max(0, frame.coveredHeight)),
    Math.max(0, project.viewportWorldHeight - 2 * INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD),
  );
  return {
    x: frame.greeter.x,
    y: frame.greeter.y - INTRO_CAMERA_CHARACTER_RISE_WORLD + covered / 2,
  };
}
