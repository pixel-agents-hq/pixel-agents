/**
 * An office's report to one of the server's editing locks: while a person holds
 * unsaved work (the layout editor's changes, the Characters view's draft),
 * agents' edits of that thing wait. Sent only when it changes, and again after a
 * reconnect (the server drops a closed socket's report).
 */

import type { ClientMessage } from '../../../core/src/messages.js';

export type EditingLock = 'layoutEditing' | 'charactersEditing';

export function createEditingReporter(
  lock: EditingLock,
  send: (msg: ClientMessage) => void,
): { report(dirty: boolean): void; reconnected(): void } {
  let sent = false;
  return {
    report(dirty) {
      if (dirty === sent) return;
      sent = dirty;
      send({ type: lock, dirty });
    },
    reconnected() {
      // The server forgot this office's report with its old socket.
      if (sent) send({ type: lock, dirty: true });
    },
  };
}
