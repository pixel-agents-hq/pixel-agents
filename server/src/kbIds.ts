/**
 * Knowledge Base identifiers and titles.
 *
 * Every id that names a file or directory is checked here before it reaches a
 * path: a Workspace id is 'default' or a lowercase UUID v4, and every entry,
 * proposal and blob id is a lowercase UUID v4. Nothing else -- no separator, no
 * `..`, no NUL, no upper case -- can pass, so an id is never a path.
 *
 * A title is visible single-line text. Its stored form is NFC; its titleKey
 * (NFKC, lower-cased, NFKC again) is what uniqueness compares, so a fullwidth
 * 'Ａ' and an 'a' collide. Homoglyphs across scripts (Cyrillic 'а' vs Latin
 * 'a') are NOT detected: a known limitation.
 */

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { KB_TITLE_MAX_CODE_POINTS, KB_UUID_PATTERN } from './constants.js';
import { decodeSafeText, hasInvisibleCharacter, isWellFormedText } from './textSafety.js';

/** A lowercase UUID v4: the only shape an entry, proposal or blob id may have. */
export function isValidKbId(value: unknown): value is string {
  return typeof value === 'string' && KB_UUID_PATTERN.test(value);
}

/** 'default' or a lowercase UUID v4. */
export function isValidWorkspaceId(value: unknown): value is string {
  return value === DEFAULT_WORKSPACE_ID || isValidKbId(value);
}

export interface NormalizedTitle {
  title: string;
  titleKey: string;
}

const CONTROL_CHARACTER = /\p{Cc}/u;

/** The uniqueness key of an already-normalized title. */
export function titleKeyFor(title: string): string {
  return title.normalize('NFKC').toLowerCase().normalize('NFKC');
}

/**
 * The stored form of `raw` and its key, or null when it is not an acceptable
 * title: not well-formed, a forbidden code point (decodeSafeText), any control
 * character (tab and line breaks included), any invisible character (Cf, Zl, Zp,
 * Co, Cn, variation selectors, every space separator except U+0020), or empty
 * or longer than KB_TITLE_MAX_CODE_POINTS once surrounding spaces are trimmed.
 */
export function normalizeTitle(raw: unknown): NormalizedTitle | null {
  if (typeof raw !== 'string' || !isWellFormedText(raw)) return null;
  if (decodeSafeText(Buffer.from(raw, 'utf-8')) === null) return null;
  if (CONTROL_CHARACTER.test(raw) || hasInvisibleCharacter(raw)) return null;
  const title = raw.trim().normalize('NFC');
  const length = [...title].length;
  if (length < 1 || length > KB_TITLE_MAX_CODE_POINTS) return null;
  return { title, titleKey: titleKeyFor(title) };
}
