import { expect, test } from 'vitest';

import {
  dialogLetterBudget,
  dialogMessages,
  introCameraTarget,
} from '../src/components/introDialogRules.js';
import {
  INTRO_CAMERA_CHARACTER_RISE_WORLD,
  INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  INTRO_DIALOG_MIN_LETTERS,
} from '../src/constants.js';

test('a line that fits is one message, as written', () => {
  expect(dialogMessages(["Hi, I'm Byte.", 'Welcome!'], 60)).toEqual(["Hi, I'm Byte.", 'Welcome!']);
});

test('a long line is cut at its sentence ends, whole sentences packed while they fit', () => {
  const line = 'One two three. Four five six! Seven eight nine? Ten.';
  expect(dialogMessages([line], 30)).toEqual([
    'One two three. Four five six!',
    'Seven eight nine? Ten.',
  ]);
});

test('a sentence too long by itself is cut at its spaces; nothing is lost', () => {
  const line = 'alpha beta gamma delta epsilon zeta eta theta. Done.';
  const messages = dialogMessages([line], 20);
  expect(messages.every((m) => m.length <= 20)).toBe(true);
  expect(messages.join(' ')).toBe(line);
});

test('blank lines are skipped and inner whitespace collapsed', () => {
  expect(dialogMessages(['', '  a\n\n b  '], 60)).toEqual(['a b']);
});

test('the budget follows the box width and never falls under the minimum', () => {
  expect(dialogLetterBudget(680)).toBeGreaterThan(dialogLetterBudget(400));
  expect(dialogLetterBudget(100)).toBe(INTRO_DIALOG_MIN_LETTERS);
});

const frame = {
  layout: { cols: 20, rows: 11 },
  containerRect: { width: 800, height: 600 },
  zoom: 2,
  pan: { x: 0, y: 0 },
  dpr: 1,
  greeter: { x: 100, y: 200 },
  coveredHeight: 0,
};

test('with nothing covered the camera centres the character itself', () => {
  expect(introCameraTarget(frame)).toEqual({
    x: 100,
    y: 200 - INTRO_CAMERA_CHARACTER_RISE_WORLD,
  });
});

test('the camera aims lower by half of what the dialog covers', () => {
  // 120 CSS px at zoom 2, dpr 1 = 60 world px covered.
  expect(introCameraTarget({ ...frame, coveredHeight: 120 }).y).toBe(
    200 - INTRO_CAMERA_CHARACTER_RISE_WORLD + 30,
  );
});

test('a dialog taller than the view allows never pushes the character off screen', () => {
  const viewportWorld = 600 / 2;
  const cap = (viewportWorld - 2 * INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD) / 2;
  expect(introCameraTarget({ ...frame, coveredHeight: 5000 }).y).toBe(
    200 - INTRO_CAMERA_CHARACTER_RISE_WORLD + cap,
  );
});
