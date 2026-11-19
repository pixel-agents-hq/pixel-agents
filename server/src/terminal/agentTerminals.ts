/**
 * Typing into an agent's terminal: what a Message needs of a surface.
 *
 * The office (mcp/messaging.ts) decides WHAT is typed and whether it may be
 * (its delivery guard, the sender tag, who can be messaged) and types it with
 * the ONE `typeInto`; a surface supplies an AgentTerminals saying how its
 * terminals are read and written.
 * Standalone: the PTY sessions (`ptyAgentTerminals`, below, for the in-process
 * manager and the PTY host alike). VS Code: its terminal adapter's sendText,
 * with no screen to read (`screenlessAgentTerminals`, below).
 *
 * PC shells share the terminal sessions but never this seam: an agent's
 * terminal tools can't address one (`ptyAgentTerminals` refuses shell ids).
 * The MCP's own shell tools read and write a shell through its registry
 * (terminal/pcShells.ts), typing with the same `typeInto` and the wider
 * SHELL_KEYS.
 */

import { isPcShellId } from '../../../core/src/pcShells.js';
import type { TerminalHandle } from '../../../core/src/terminalAdapter.js';
import { MESSAGE_KEY_DELAY_MS } from '../constants.js';
import { pause } from '../pause.js';
import type { TerminalScreen } from './terminalScreen.js';
import { readScreen } from './terminalScreen.js';
import type { TerminalSessions } from './terminalSessions.js';

/** The keys a Message may press: what answers a permission prompt or a menu. */
export const MESSAGE_KEYS = [
  'enter',
  'escape',
  'tab',
  'shift+tab',
  'up',
  'down',
  'left',
  'right',
  'backspace',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

/** The keys typed into a PC shell: a Message's, plus what a shell needs to
 *  stop a command (Ctrl+C) or end input (Ctrl+D). Never a Message's: an
 *  agent's interrupt is its own user's to press. */
export const SHELL_KEYS = [...MESSAGE_KEYS, 'ctrl+c', 'ctrl+d'] as const;
export type ShellKey = (typeof SHELL_KEYS)[number];

/** What a Message types: text (then Enter, when `submit`), or keys pressed one after another. */
export type TypedInput = { text: string; submit: boolean } | { keys: readonly MessageKey[] };

/** The terminal modes that change the bytes a key or a paste is sent as. */
export type InputModes = Pick<TerminalScreen, 'bracketedPaste' | 'applicationCursorKeys'>;

const ESC = '\x1b';
/** The bytes each named key sends, as xterm sends them (the key bar's too). */
const KEY_BYTES: Record<Exclude<ShellKey, 'up' | 'down' | 'left' | 'right'>, string> = {
  enter: '\r',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  escape: ESC,
  tab: '\t',
  'shift+tab': `${ESC}[Z`,
  backspace: '\x7f',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
};
const ARROW_FINAL = { up: 'A', down: 'B', right: 'C', left: 'D' } as const;

/** The bytes a named key sends: arrows as CSI, or SS3 under application cursor keys. */
export function keyBytes(key: ShellKey, modes: InputModes): string {
  if (key in ARROW_FINAL) {
    const final = ARROW_FINAL[key as keyof typeof ARROW_FINAL];
    return modes.applicationCursorKeys ? `${ESC}O${final}` : `${ESC}[${final}`;
  }
  return KEY_BYTES[key as keyof typeof KEY_BYTES];
}

/**
 * The bytes text is typed as: exactly what xterm sends when the user pastes
 * it — line breaks as CR, wrapped in the bracketed-paste markers when the
 * program asked for them (Claude Code does), so a multi-line Message lands in
 * the input box whole instead of submitting at its first line. Paste markers
 * inside the text are dropped: they would end the paste early.
 */
export function textBytes(text: string, modes: InputModes): string {
  const body = text.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
  return modes.bracketedPaste ? `${ESC}[200~${body}${ESC}[201~` : body;
}

/** How a surface reads and writes its agents' terminals. */
export interface AgentTerminals {
  /** Whether the agent has a terminal of ours (headless and adopted agents don't). */
  has(agentId: number): boolean;
  /** Its visible screen; null when this surface has no screen to show (VS Code). */
  screen(agentId: number): Promise<TerminalScreen | null>;
  /** Write bytes to it (throws when it has no terminal). */
  write(agentId: number, bytes: string): void;
}

/** The modes a surface that can't read its terminals types with where the
 *  agents' CLI declares none (`HookProvider.terminalInputModes`): plain. */
export const PLAIN_INPUT_MODES: InputModes = {
  bracketedPaste: false,
  applicationCursorKeys: false,
};

/**
 * Type text or keys into a terminal: text as one paste (`textBytes`), keys
 * one write each, MESSAGE_KEY_DELAY_MS apart, in `modes`. Submitting text is
 * the caller's next step (`{ keys: ['enter'] }`, its own write, once the
 * paste has landed: see MESSAGE_SUBMIT_DELAY_MS) — taken only when its
 * delivery guard still allows it.
 */
export async function typeInto(
  write: (bytes: string) => void,
  input: { text: string } | { keys: readonly ShellKey[] },
  modes: InputModes,
): Promise<void> {
  if ('text' in input) {
    write(textBytes(input.text, modes));
    return;
  }
  for (const [i, key] of input.keys.entries()) {
    if (i > 0) await pause(MESSAGE_KEY_DELAY_MS);
    write(keyBytes(key, modes));
  }
}

/** The standalone surface's terminals: its PTY sessions (in process or in the PTY host). */
export function ptyAgentTerminals(sessions: TerminalSessions): AgentTerminals {
  // The terminal sessions also hold the PC shells (the user's own login
  // shells): this seam never addresses one, whatever its caller checked.
  const agentSession = (agentId: number) =>
    isPcShellId(agentId) ? undefined : sessions.get(agentId);
  return {
    has: (agentId) => agentSession(agentId) !== undefined,
    async screen(agentId) {
      const session = agentSession(agentId);
      return session ? readScreen(session) : null;
    },
    write(agentId, bytes) {
      const session = agentSession(agentId);
      if (!session) throw new Error(`agent ${agentId} has no terminal`);
      session.write(bytes);
    },
  };
}

/**
 * The terminals of a surface that can type into them but not read them
 * (VS Code): `screen` is always null. What may be typed blind is the delivery
 * guard's call (mcp/messaging.ts `turnGuard`); this only writes.
 */
export function screenlessAgentTerminals(
  terminalOf: (agentId: number) => TerminalHandle | undefined,
  sendText: (terminal: TerminalHandle, text: string) => void,
): AgentTerminals {
  return {
    has: (agentId) => terminalOf(agentId) !== undefined,
    screen: async () => null,
    write(agentId, bytes) {
      const terminal = terminalOf(agentId);
      if (!terminal) throw new Error(`agent ${agentId} has no terminal`);
      sendText(terminal, bytes);
    },
  };
}
