/**
 * An agent's terminal screen as text — what read_agent_terminal shows another
 * agent, and what send_message checks a Message against before typing.
 *
 * Read through the session's replay (the serialized mirror) drawn into a
 * fresh headless xterm, so it works for every TerminalSession: in process
 * (PtySessionManager) and in the PTY host (RemotePtySessions, whose mirror
 * lives in the other process and only crosses the socket as a replay) alike,
 * with no protocol change.
 */

import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { createHash } from 'crypto';

import { MESSAGE_SCREEN_TOKEN_LENGTH, TERMINAL_MIRROR_SCROLLBACK_LINES } from '../constants.js';
import type { TerminalSession } from './terminalSessions.js';

/** A terminal's visible screen, and the modes that change how input must be sent. */
export interface TerminalScreen {
  /** The visible rows as plain text: trailing spaces and trailing blank rows dropped. */
  text: string;
  /** A hash of `text`: equal tokens = the same screen. */
  token: string;
  /** The program asked for bracketed paste (DECSET 2004): text goes in as a paste. */
  bracketedPaste: boolean;
  /** Application cursor keys (DECCKM): arrows are sent as SS3, not CSI. */
  applicationCursorKeys: boolean;
}

/** The screen token of a screen's text. */
export function screenToken(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, MESSAGE_SCREEN_TOKEN_LENGTH);
}

/** The visible screen of a terminal session, as it is right now. */
export async function readScreen(session: TerminalSession): Promise<TerminalScreen> {
  const replay = await session.replay();
  const term = new HeadlessTerminal({
    cols: replay.cols,
    rows: replay.rows,
    scrollback: TERMINAL_MIRROR_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => term.write(replay.data, resolve));
    const buffer = term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < term.rows; i++) {
      rows.push(
        buffer
          .getLine(buffer.viewportY + i)
          ?.translateToString(true)
          .trimEnd() ?? '',
      );
    }
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    const text = rows.join('\n');
    return {
      text,
      token: screenToken(text),
      bracketedPaste: term.modes.bracketedPasteMode,
      applicationCursorKeys: term.modes.applicationCursorKeysMode,
    };
  } finally {
    term.dispose();
  }
}
