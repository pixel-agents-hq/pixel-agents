import type { Terminal } from '@xterm/xterm';

import { clipboardKeyAction, decodeOsc52 } from './clipboardKeys.js';
import { flowTerminalCopy } from './flowCopy.js';

const OSC_CLIPBOARD = 52;

/**
 * Wire the clipboard on a terminal pane (the rules are the pure functions in
 * clipboardKeys.ts):
 *
 * - every copy of a selection — Cmd+C, Ctrl+C, the browser's Copy — goes
 *   through one `copy` listener that re-flows Claude Code's soft wraps;
 * - Ctrl+C / Ctrl+V and their Shift forms copy and paste on Windows and Linux;
 * - OSC 52 writes from the running program reach this browser's clipboard.
 *
 * Returns a dispose function that removes everything it added.
 */
export function attachClipboardInput(
  term: Terminal,
  host: HTMLElement,
  opts: {
    /** Only the pane on screen may write the clipboard from OSC 52. */
    isActive: () => boolean;
  },
): () => void {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  /** Text an OSC 52 write is putting on the clipboard through the copy event. */
  let pending: string | null = null;

  // Capture phase on the host, so this runs before xterm's own copy handler
  // (on the element inside) and replaces its unflowed text.
  const onCopy = (ev: ClipboardEvent) => {
    let text = pending;
    if (text === null && term.hasSelection()) {
      const startCol = (term.getSelectionPosition()?.start.x ?? 1) - 1;
      text = flowTerminalCopy(term.getSelection(), term.cols, startCol);
    }
    if (text === null || !ev.clipboardData) return;
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
    ev.stopPropagation();
  };
  host.addEventListener('copy', onCopy, true);

  term.attachCustomKeyEventHandler((ev) => {
    const action = clipboardKeyAction(ev, isMac, term.hasSelection());
    if (action === 'terminal') return true;
    if (ev.type === 'keydown' && action === 'copy') {
      // Prevented (Ctrl+Shift+C would open DevTools), so the copy event is
      // raised by hand; it still counts as the key press's user gesture.
      ev.preventDefault();
      if (term.hasSelection()) {
        document.execCommand('copy');
        term.clearSelection();
      }
    }
    // 'paste': returning false keeps xterm from sending ^V and cancelling the
    // key, so the browser raises its paste event and xterm pastes it (with
    // bracketed-paste markers when the app asks for them).
    return false;
  });

  const writeClipboard = (text: string) => {
    if (window.isSecureContext && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch((err: unknown) => {
        console.warn('[Webview] Terminal clipboard write refused:', err);
      });
      return;
    }
    // Plain-http origins have no async clipboard: raise a copy event instead
    // (works while the triggering key press still counts as a user gesture).
    pending = text;
    try {
      document.execCommand('copy');
    } finally {
      pending = null;
    }
  };
  const osc = term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    const text = opts.isActive() ? decodeOsc52(data) : null;
    if (text !== null) writeClipboard(text);
    return true;
  });

  return () => {
    host.removeEventListener('copy', onCopy, true);
    term.attachCustomKeyEventHandler(() => true);
    osc.dispose();
  };
}
