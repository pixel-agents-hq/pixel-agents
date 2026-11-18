/**
 * Messages (read_agent_terminal / send_message): reading an agent's terminal
 * and typing a Message into it. One delivery path for every surface — check,
 * type, then submit — with the surface's DeliveryGuard deciding what may be
 * typed and whether the Enter may follow:
 *
 * - `screenTokenGuard` (standalone, whose screens can be read): the sender
 *   read the recipient's screen and gives its token; a screen that changed
 *   since refuses the Message with the new one. Text or keys.
 * - `turnGuard` (VS Code, whose terminals can be typed into, not read): no
 *   token to give, so only text, only into an agent that is done or active —
 *   one with a permission prompt or a question open would take the text as
 *   its answer — and the Enter held back if a prompt opened while it landed.
 */

import type { AgentMessageShow } from '../../../core/src/messages.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { MESSAGE_SUBMIT_DELAY_MS } from '../constants.js';
import { pause } from '../pause.js';
import {
  type AgentTerminals,
  type InputModes,
  PLAIN_INPUT_MODES,
  typeInto,
} from '../terminal/agentTerminals.js';
import type { AgentState } from '../types.js';
import { agentLabel, messageTag } from './agentLabel.js';
import { statusOf } from './agentsView.js';
import type {
  AgentScreen,
  MessageContent,
  MessageDelivery,
  MessageRecipient,
  Messaging,
} from './officeOperations.js';
import { noAgentReason } from './officeOperations.js';

/** How a surface checks a Message before it is typed, and again before its Enter. */
export interface DeliveryGuard {
  /** Before anything is typed: the modes to type with, or why not (with the
   *  recipient's screen, when it changed). */
  check(
    to: MessageRecipient,
    content: MessageContent,
  ): Promise<{ ok: true; modes: InputModes } | { ok: false; reason: string; screen?: AgentScreen }>;
  /** Just before the Enter that submits typed text: why not now, or null. */
  beforeSubmit(id: number): string | null;
}

/** The guard of a surface whose screens can be read: the sender's screen token. */
export function screenTokenGuard(terminals: AgentTerminals): DeliveryGuard {
  return {
    async check(to) {
      const { id } = to;
      const read = await terminals.screen(id);
      if (!read) {
        return {
          ok: false,
          reason: `Agent ${id}'s terminal is gone: it may have just exited. Check list_agents and try again.`,
        };
      }
      const screen = { text: read.text, token: read.token };
      if (to.screenToken === undefined) {
        return {
          ok: false,
          reason: `No screen token for agent ${id}: read its screen (this one, or read_agent_terminal) and send again with its token.`,
          screen,
        };
      }
      if (to.screenToken !== read.token) {
        return {
          ok: false,
          reason: `Agent ${id}'s screen changed since you read it: here is the new one. Send again with its token if the message still fits.`,
          screen,
        };
      }
      return { ok: true, modes: read };
    },
    beforeSubmit: () => null,
  };
}

/** The guard of a surface that can't read its terminals: the agent's turn.
 *  It types in the modes the agents' CLI says its TUI runs with. */
export function turnGuard(
  store: AgentStateStore,
  provider: Pick<HookProvider, 'terminalInputModes'>,
): DeliveryGuard {
  const modes = provider.terminalInputModes ?? PLAIN_INPUT_MODES;
  /** Why text can't be typed blind into `agent` now, or null when it can. */
  function promptOpenReason(agent: AgentState): string | null {
    const status = statusOf(agent);
    if (status === 'done' || status === 'active') return null;
    const open =
      status === 'permission request' ? 'a permission prompt' : 'a prompt waiting for its user';
    return `Agent ${agent.id} has ${open} open, and this office can't read its terminal: typed text could answer it. Send once list_agents shows agent ${agent.id} done or active, or leave it to the user.`;
  }

  return {
    async check({ id }, content) {
      const agent = store.get(id);
      if (!agent) return { ok: false, reason: noAgentReason(id) };
      if (!('text' in content)) {
        return {
          ok: false,
          reason: `This office can't read agent ${id}'s terminal, so it can't press keys in it: a key answers whatever is on a screen, and this one can't be seen. Send text once agent ${id} is done or active, or leave the prompt to the user.`,
        };
      }
      const promptOpen = promptOpenReason(agent);
      return promptOpen ? { ok: false, reason: promptOpen } : { ok: true, modes };
    },
    // Looked at again just before the Enter: a prompt that opened since (a
    // permission request landing mid-message) must not take it.
    beforeSubmit(id) {
      const agent = store.get(id);
      return agent ? promptOpenReason(agent) : noAgentReason(id);
    },
  };
}

/** Why an agent's terminal can't be read or typed into. */
function noTerminalReason(agent: AgentState): string {
  if (agent.leadAgentId !== undefined) {
    return `Agent ${agent.id} is a Teammate with no terminal of this office: message its lead, agent ${agent.leadAgentId}, instead.`;
  }
  if (agent.isExternal) {
    return `Agent ${agent.id} was adopted: it runs in a terminal outside this office, which Pixel Agents can't read or type into. Leave the message to the user, or work through files it reads.`;
  }
  return `Agent ${agent.id} is headless: it has no terminal to read or type into. Leave the message to the user, or work through files it reads.`;
}

/** What a surface that can't read its terminals says instead of a screen. */
function unreadableReason(id: number): string {
  return `This office can't read agent ${id}'s terminal (VS Code terminals can't be read): its status only. send_message types text to it, no screen token needed, while it is done or active; keys are refused.`;
}

export function createMessaging(
  store: AgentStateStore,
  terminals: AgentTerminals,
  guard: DeliveryGuard,
): Messaging {
  // One Message at a time per recipient: its check and its typing (a paste,
  // the pause, the Enter) never interleave with another sender's.
  const typing = new Map<number, Promise<unknown>>();
  function oneAtATime<T>(id: number, work: () => Promise<T>): Promise<T> {
    const run = (typing.get(id) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    typing.set(id, settled);
    void settled.then(() => {
      if (typing.get(id) === settled) typing.delete(id);
    });
    return run;
  }

  async function deliver(
    from: number,
    to: MessageRecipient,
    content: MessageContent,
  ): Promise<MessageDelivery> {
    const { id } = to;
    const refused = (reason: string, screen?: AgentScreen): MessageDelivery => ({
      id,
      delivered: false,
      reason,
      ...(screen ? { screen } : {}),
    });
    const agent = store.get(id);
    if (!agent) return refused(noAgentReason(id));
    if (id === from) {
      return refused(
        'You cannot message yourself: your own terminal is where your turn is running.',
      );
    }
    if (!terminals.has(id)) return refused(noTerminalReason(agent));
    return oneAtATime(id, async () => {
      const checked = await guard.check(to, content);
      if (!checked.ok) return refused(checked.reason, checked.screen);
      const write = (bytes: string) => terminals.write(id, bytes);
      const typed = async (input: Parameters<typeof typeInto>[1]): Promise<string | null> => {
        try {
          await typeInto(write, input, checked.modes);
          return null;
        } catch (err) {
          return `Typing into agent ${id}'s terminal failed (${String(err)}): it may have just exited. Check list_agents and try again.`;
        }
      };
      if (!('text' in content)) {
        const failed = await typed(content);
        return failed ? refused(failed) : { id, delivered: true };
      }
      const sender = store.get(from);
      const failed = await typed({
        text: messageTag(from, sender ? agentLabel(sender) : null) + content.text,
      });
      if (failed) return refused(failed);
      if (!content.submit) return { id, delivered: true };
      // Its own write, after the paste has landed: see MESSAGE_SUBMIT_DELAY_MS.
      await pause(MESSAGE_SUBMIT_DELAY_MS);
      const notNow = guard.beforeSubmit(id);
      if (notNow) {
        return refused(`Your text was typed into agent ${id}'s input but not submitted: ${notNow}`);
      }
      const enterFailed = await typed({ keys: ['enter'] });
      return enterFailed ? refused(enterFailed) : { id, delivered: true };
    });
  }

  return {
    async readAgentTerminal(id) {
      const agent = store.get(id);
      if (!agent) throw new Error(`no agent ${id}`);
      const status = statusOf(agent);
      if (!terminals.has(id)) return { status, screen: null, noScreen: noTerminalReason(agent) };
      const screen = await terminals.screen(id);
      if (!screen) return { status, screen: null, noScreen: unreadableReason(id) };
      return { status, screen: { text: screen.text, token: screen.token } };
    },

    sendMessage: ({ from, to, content }) =>
      Promise.all(to.map((recipient) => deliver(from, recipient, content))),

    // The Message show: every open office walks the sender's character to
    // each recipient and shows the gist. Fire-and-forget, after delivery; the
    // offices resolve the tiles (they know where the characters stand), and
    // nothing is kept for later offices: a show is of the moment.
    showMessage({ fromId, toIds, gist }) {
      if (toIds.length === 0) return;
      const show: AgentMessageShow = { type: 'agentMessageShow', fromId, toIds: [...toIds], gist };
      store.broadcast({ ...show });
    },
  };
}
