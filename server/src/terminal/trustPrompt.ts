/**
 * Answering the CLI's "do you trust this folder?" question for the agents the
 * office launches, where the operator said its folders are trusted
 * (`pixel-agents --trust-directories`: a server set up for one person's own
 * work, e.g. a remote server, where nobody should meet a terminal question
 * before their first agent says a word). Off unless asked for: the question
 * is the CLI's own safeguard, and answering it is the operator's decision.
 *
 * The provider reads the question off the screen and names the keys
 * (HookProvider.trustPromptKeys); this watches a new session's screen for a
 * short while after the launch and presses them ONE KEY PER READ: the CLI
 * drops keys for a moment after the question appears, so a "down, enter"
 * sent together could lose the move and confirm the row it started on
 * ("No, exit", which ended the session). The confirming key is pressed only
 * on a screen whose answer is that key alone.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { TRUST_PROMPT_POLL_MS, TRUST_PROMPT_WATCH_MS } from '../constants.js';
import { pause } from '../pause.js';
import { typeInto } from './agentTerminals.js';
import { readScreen } from './terminalScreen.js';
import type { TerminalSession } from './terminalSessions.js';

let trusted = false;

/** Set once at startup from --trust-directories. */
export function setTrustDirectories(enabled: boolean): void {
  trusted = enabled;
}

export function trustsDirectories(): boolean {
  return trusted;
}

/**
 * Watch a just-launched session for the provider's trust question and say yes
 * to it. Resolves true when it answered (the question left the screen after
 * the confirming key), false when the question never
 * showed (the folder was trusted already), the terminal ended, or the provider
 * has no such question. Never rejects.
 */
export async function answerTrustPrompt(
  session: TerminalSession,
  provider: Pick<HookProvider, 'trustPromptKeys'>,
  stillOpen: () => boolean,
  timing: { pollMs: number; watchMs: number } = {
    pollMs: TRUST_PROMPT_POLL_MS,
    watchMs: TRUST_PROMPT_WATCH_MS,
  },
): Promise<boolean> {
  if (!provider.trustPromptKeys) return false;
  const until = Date.now() + timing.watchMs;
  let confirmed = false;
  while (Date.now() < until) {
    await pause(timing.pollMs);
    if (!stillOpen()) return false;
    try {
      const screen = await readScreen(session);
      const keys = provider.trustPromptKeys(screen.text);
      if (!keys || keys.length === 0) {
        // Gone after our confirming key: answered. (Never shown: keep watching.)
        if (confirmed) return true;
        continue;
      }
      // A move, then the next read says what is left; the last key confirms.
      confirmed = keys.length === 1;
      await typeInto((bytes) => session.write(bytes), { keys: [keys[0]] }, screen);
    } catch {
      return false; // The terminal went away under the read.
    }
  }
  return confirmed;
}
