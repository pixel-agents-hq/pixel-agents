/**
 * Text safety rules shared by every store of operator-reviewed text (Role files,
 * Knowledge Base titles and contents).
 *
 * - decodeSafeText: valid UTF-8 (fatal decode), and none of the code points that
 *   can hide or reorder what a reviewer sees (C0/C1 controls other than tab,
 *   newline and carriage return, NUL, tag characters, bidirectional embeddings,
 *   overrides and isolates, a BOM anywhere).
 * - INVISIBLE_CHARACTER / hasInvisibleCharacter / escapeInvisibleCharacters:
 *   characters that are allowed in content but are invisible (or blank) on
 *   screen, so a preview must make them visible.
 * - isWellFormedText: a JS string with no lone surrogate. Written with /\p{Cs}/u
 *   because String.prototype.isWellFormed is ES2024 and the server targets ES2022.
 */

import * as crypto from 'crypto';

/** Code points safe text may never contain: they can hide or reorder what the
 *  reviewer sees, or are not text at all. */
export function isForbiddenCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp < 0x20) return true; // C0 controls, NUL included
  if (cp >= 0x7f && cp <= 0x9f) return true; // DEL and C1 controls
  if (cp >= 0xe0000 && cp <= 0xe007f) return true; // tag characters
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embeddings / overrides
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0xfeff) return true; // BOM / zero-width no-break space, anywhere
  return false;
}

/** The text of `bytes`, or null when it is not acceptable: invalid UTF-8 (fatal
 *  decode; a BOM is kept so it is caught here too) or any forbidden code point. */
export function decodeSafeText(bytes: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  for (const char of text) {
    if (isForbiddenCodePoint(char.codePointAt(0) as number)) return null;
  }
  return text;
}

/** Characters allowed in reviewed text but invisible (or blank) on screen. Global
 *  flag: for `replace` only -- a /g regex carries lastIndex between `test` calls. */
export const INVISIBLE_CHARACTER =
  /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}ᅟᅠㅤﾠ]|(?! )\p{Zs}/gu;

/** The same set without the global flag, so repeated calls never share state. */
const INVISIBLE_CHARACTER_TEST =
  /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}ᅟᅠㅤﾠ]|(?! )\p{Zs}/u;

/** Whether `text` contains any character INVISIBLE_CHARACTER matches. */
export function hasInvisibleCharacter(text: string): boolean {
  return INVISIBLE_CHARACTER_TEST.test(text);
}

/** Preview text: every invisible character replaced by a visible `<U+XXXX>`. */
export function escapeInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_CHARACTER, (char) => {
    const hex = (char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
    return `<U+${hex}>`;
  });
}

const LONE_SURROGATE = /\p{Cs}/u;

/** True when `text` holds no lone (unpaired) surrogate. */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
