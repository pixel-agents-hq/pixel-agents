/**
 * Terminal clipboard rules: which chords copy or paste instead of reaching
 * the PTY, and which OSC 52 writes are honoured. A wrong answer either eats
 * the user's Ctrl+C interrupt or silently drops their copy, so it is pinned.
 */

import { describe, expect, it } from 'vitest';

import { TERMINAL_OSC52_MAX_BASE64_CHARS } from '../src/constants.js';
import { clipboardKeyAction, decodeOsc52, type KeyChord } from '../src/terminal/clipboardKeys.js';

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});
const ctrl = (key: string, mods: Partial<KeyChord> = {}) => chord(key, { ctrlKey: true, ...mods });
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('clipboardKeyAction on Windows / Linux', () => {
  it('Ctrl+C copies a selection and is still the interrupt without one', () => {
    expect(clipboardKeyAction(ctrl('c'), false, true)).toBe('copy');
    expect(clipboardKeyAction(ctrl('c'), false, false)).toBe('terminal');
  });

  it('Ctrl+Shift+C always copies, so it never opens DevTools', () => {
    expect(clipboardKeyAction(ctrl('C', { shiftKey: true }), false, false)).toBe('copy');
    expect(clipboardKeyAction(ctrl('C', { shiftKey: true }), false, true)).toBe('copy');
  });

  it('Ctrl+V and Ctrl+Shift+V paste', () => {
    expect(clipboardKeyAction(ctrl('v'), false, false)).toBe('paste');
    expect(clipboardKeyAction(ctrl('V', { shiftKey: true }), false, true)).toBe('paste');
  });

  it('leaves every other key to the terminal', () => {
    expect(clipboardKeyAction(ctrl('d'), false, true)).toBe('terminal');
    expect(clipboardKeyAction(chord('c'), false, true)).toBe('terminal');
    expect(clipboardKeyAction(chord('v'), false, false)).toBe('terminal');
    // AltGr on Windows arrives as Ctrl+Alt
    expect(clipboardKeyAction(ctrl('c', { altKey: true }), false, true)).toBe('terminal');
  });
});

describe('clipboardKeyAction on a Mac', () => {
  it('keeps Ctrl+C and Ctrl+V as terminal keys (Claude Code copy, image paste)', () => {
    expect(clipboardKeyAction(ctrl('c'), true, true)).toBe('terminal');
    expect(clipboardKeyAction(ctrl('v'), true, false)).toBe('terminal');
    expect(clipboardKeyAction(chord('c', { metaKey: true }), true, true)).toBe('terminal');
  });
});

describe('Copy as text (Alt+C / Option+C)', () => {
  it('re-flows a selection on every platform', () => {
    expect(clipboardKeyAction(chord('c', { altKey: true }), false, true)).toBe('copyText');
    // Option+C on a Mac types ç: the physical key is what counts.
    expect(clipboardKeyAction(chord('ç', { altKey: true, code: 'KeyC' }), true, true)).toBe(
      'copyText',
    );
  });

  it('is a terminal key without a selection', () => {
    expect(clipboardKeyAction(chord('c', { altKey: true }), false, false)).toBe('terminal');
    expect(clipboardKeyAction(chord('ç', { altKey: true, code: 'KeyC' }), true, false)).toBe(
      'terminal',
    );
  });

  it('only the bare chord: other modifiers keep their meaning', () => {
    expect(clipboardKeyAction(ctrl('c', { altKey: true }), false, true)).toBe('terminal');
    expect(clipboardKeyAction(chord('C', { altKey: true, shiftKey: true }), false, true)).toBe(
      'terminal',
    );
    // Plain copy chords stay verbatim copies.
    expect(clipboardKeyAction(ctrl('c'), false, true)).toBe('copy');
  });
});

describe('decodeOsc52', () => {
  it('decodes a clipboard write, including non-ASCII text', () => {
    expect(decodeOsc52(`c;${base64('hello\nworld')}`)).toBe('hello\nworld');
    expect(decodeOsc52(`;${base64('café ✓')}`)).toBe('café ✓');
  });

  it('never answers a read and ignores a clear', () => {
    expect(decodeOsc52('c;?')).toBeNull();
    expect(decodeOsc52('c;')).toBeNull();
  });

  it('drops malformed and oversized writes', () => {
    expect(decodeOsc52('no-separator')).toBeNull();
    expect(decodeOsc52('c;not base64!')).toBeNull();
    expect(decodeOsc52(`c;${btoa('\xff\xfe')}`)).toBeNull(); // not UTF-8
    expect(decodeOsc52(`c;${'A'.repeat(TERMINAL_OSC52_MAX_BASE64_CHARS + 4)}`)).toBeNull();
  });
});
