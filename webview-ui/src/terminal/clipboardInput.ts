import type { Terminal } from '@xterm/xterm';

import { OSC52_USER_INPUT_WINDOW_MS } from '../constants.js';
import { writeClipboardText } from './clipboard.js';
import { clipboardKeyAction, decodeOsc52 } from './clipboardKeys.js';
import { terminalCopyText } from './flowCopy.js';

const OSC_CLIPBOARD = 52;

/**
 * Wire the clipboard on a terminal pane (the rules are the pure functions in
 * clipboardKeys.ts):
 *
 * - every copy of a selection is verbatim: Cmd+C and the browser's Copy are
 *   xterm's own copy handler, Ctrl+C / Ctrl+Shift+C (Windows, Linux) go
 *   through writeClipboardText;
 * - Alt+C (Option+C on a Mac) with a selection is "Copy as text": the
 *   selection with Claude Code's soft wraps re-flowed (terminalCopyText);
 * - Ctrl+V / Ctrl+Shift+V paste on Windows and Linux;
 * - OSC 52 writes from the running program reach this browser's clipboard,
 *   but only right after the user typed into this pane (see below).
 *
 * Returns a dispose function that removes everything it added.
 */
export function attachClipboardInput(
  term: Terminal,
  opts: {
    /** Only the pane on screen may write the clipboard from OSC 52. */
    isActive: () => boolean;
  },
): () => void {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  term.attachCustomKeyEventHandler((ev) => {
    const action = clipboardKeyAction(ev, isMac, term.hasSelection());
    if (action === 'terminal') return true;
    if (ev.type === 'keydown' && (action === 'copy' || action === 'copyText')) {
      // Prevented: Ctrl+Shift+C would open DevTools, Option+C would type ç.
      // Written synchronously from the key press, which is the user gesture
      // the plain-http fallback needs; the selection goes once it landed.
      ev.preventDefault();
      if (term.hasSelection()) {
        const startCol = term.getSelectionPosition()?.start.x ?? 0; // 0-based
        const mode = action === 'copy' ? 'verbatim' : 'text';
        const text = terminalCopyText(term.getSelection(), mode, term.cols, startCol);
        void writeClipboardText(text).then((ok) => {
          if (ok) term.clearSelection();
        });
      }
    }
    // 'paste': returning false keeps xterm from sending ^V and cancelling the
    // key, so the browser raises its paste event and xterm pastes it (with
    // bracketed-paste markers when the app asks for them).
    return false;
  });

  // Terminal output is untrusted (an agent may `cat` a file or print a fetched
  // page), and an OSC 52 sequence in it is invisible: honoured unconditionally
  // it could silently put `curl … | sh` on the viewer's clipboard. A program's
  // legitimate copy (Claude Code's /copy) answers the user's own input in
  // this pane, so OSC 52 is honoured only within a short window after it.
  let lastUserInputAt = Number.NEGATIVE_INFINITY;
  const input = term.onData(() => {
    lastUserInputAt = performance.now();
  });

  // Plain-http origins fall back to a copy event, which works only while the
  // triggering key press still counts as a user gesture (writeClipboardText).
  const osc = term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    const recent = performance.now() - lastUserInputAt <= OSC52_USER_INPUT_WINDOW_MS;
    const text = opts.isActive() && recent ? decodeOsc52(data) : null;
    if (text !== null) void writeClipboardText(text);
    return true;
  });

  return () => {
    term.attachCustomKeyEventHandler(() => true);
    osc.dispose();
    input.dispose();
  };
}
