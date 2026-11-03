import { TERMINAL_OSC52_MAX_BASE64_CHARS } from '../constants.js';

/** What a key press means for the clipboard: copy the selection (verbatim,
 *  or re-flowed as text), let the browser paste, or hand the key to the
 *  terminal as usual. */
export type ClipboardKeyAction = 'copy' | 'copyText' | 'paste' | 'terminal';

/** The parts of a KeyboardEvent the rules read. */
export interface KeyChord {
  key: string;
  /** Physical key: Option+C on a Mac reports key 'ç' but code 'KeyC'. */
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Alt+C (Option+C on a Mac) with a selection = "Copy as text": the selection
 * re-flowed (terminalCopyText's 'text' mode) instead of verbatim. Chosen because no browser
 * claims it (Chrome and Firefox reserve Ctrl/Cmd+Shift+C for DevTools; Alt+C
 * opens no menu) and because, gated on a selection like Ctrl+C, it costs the
 * terminal nothing: without a selection the key still reaches the PTY (Meta-C
 * / ç).
 */
function isCopyTextChord(ev: KeyChord): boolean {
  return ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.code === 'KeyC';
}

/**
 * The Windows / Linux clipboard keys, which xterm would otherwise send to the
 * PTY as control characters (^C, ^V) and cancel, so the browser never copies
 * or pastes. On a Mac copy and paste are Cmd chords that xterm leaves alone,
 * and Ctrl+C / Ctrl+V must stay terminal keys (Claude Code's own copy and
 * image paste), so nothing changes there.
 *
 * - Ctrl+V and Ctrl+Shift+V paste.
 * - Ctrl+C copies only while there is a selection; without one it is still
 *   the interrupt.
 * - Ctrl+Shift+C always copies (with no selection it copies nothing): left to
 *   the browser it opens the DevTools element picker.
 */
export function clipboardKeyAction(
  ev: KeyChord,
  isMac: boolean,
  hasSelection: boolean,
): ClipboardKeyAction {
  if (hasSelection && isCopyTextChord(ev)) return 'copyText';
  if (isMac || !ev.ctrlKey || ev.altKey || ev.metaKey) return 'terminal';
  const key = ev.key.toLowerCase();
  if (key === 'v') return 'paste';
  if (key === 'c' && (ev.shiftKey || hasSelection)) return 'copy';
  return 'terminal';
}

/**
 * The text of an OSC 52 clipboard write (`ESC ] 52 ; <targets> ; <base64> BEL`,
 * here without the framing), or null for anything we don't act on: a query
 * (`?` — the clipboard is never read back to the PTY), a clear (empty
 * payload), an oversized payload, or one that isn't base64 UTF-8.
 *
 * Programs in the terminal use this to copy to the clipboard of the machine
 * the terminal is DISPLAYED on. Claude Code copies a selection both ways: its
 * native clipboard tool (pbcopy, on the server) and OSC 52 — so without this,
 * a copy from a browser on another machine lands on the server's clipboard.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (payload === '' || payload === '?' || payload.length > TERMINAL_OSC52_MAX_BASE64_CHARS) {
    return null;
  }
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
