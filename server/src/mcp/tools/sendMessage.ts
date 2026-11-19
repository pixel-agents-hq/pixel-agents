import { z } from 'zod';

import { MESSAGE_GIST_MAX_LENGTH } from '../../constants.js';
import { MESSAGE_KEYS } from '../officeOperations.js';
import { defineTool, ok, refuse } from '../tool.js';

export const sendMessage = defineTool({
  name: 'send_message',
  title: 'Send message',
  description:
    "Message other agents: type text into each one's terminal (Enter pressed after it unless " +
    '`submit` is false), or press named keys to answer a prompt or menu on its screen. Read each ' +
    "recipient's screen first (read_agent_terminal) and pass its `screen_token` in `screen_tokens` " +
    '(keyed by agent id): a recipient whose screen changed since is refused, with its new screen and ' +
    'token in the result. Text arrives tagged `[From <your nickname, else your character, else your Directory>, agent <your id>] `; keys go bare. ' +
    'Each recipient is reported on its own (delivered, or refused and why). `gist` (at most ' +
    `${MESSAGE_GIST_MAX_LENGTH} characters) is what the office shows over your character as you ` +
    'walk over. Agents without a terminal of this office (headless, adopted) cannot be messaged. ' +
    "In an office whose terminals can't be read (VS Code), no token is needed: text only, typed " +
    'only into agents that are done or active; keys are refused.',
  input: {
    to: z.array(z.number().int()).min(1).describe('The agents to message.'),
    text: z.string().min(1).optional().describe('Text to type. Exactly one of text / keys.'),
    keys: z
      .array(z.enum(MESSAGE_KEYS))
      .min(1)
      .optional()
      .describe('Named keys to press, in order. Exactly one of text / keys.'),
    submit: z
      .boolean()
      .optional()
      .describe('Press Enter after the text (default true). Text only.'),
    gist: z
      .string()
      .min(1)
      .max(MESSAGE_GIST_MAX_LENGTH)
      .describe(`What you said, in at most ${MESSAGE_GIST_MAX_LENGTH} characters.`),
    screen_tokens: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Each recipient's screen token from read_agent_terminal, keyed by its id (none to give where screens can't be read).",
      ),
  },
  changes: true,
  uses: ['messaging'],
  run: async ({ to, text, keys, submit, gist, screen_tokens }, { caller, office }) => {
    if ((text === undefined) === (keys === undefined)) {
      return refuse('Give exactly one of `text` or `keys`.');
    }
    if (keys !== undefined && submit !== undefined) {
      return refuse('`submit` goes with `text` only: add "enter" to `keys` to press it.');
    }
    if (new Set(to).size !== to.length) {
      return refuse('`to` names an agent twice: list each recipient once.');
    }
    const deliveries = await office.messaging.sendMessage({
      from: caller,
      to: to.map((id) => ({ id, screenToken: screen_tokens?.[String(id)] })),
      content: text !== undefined ? { text, submit: submit ?? true } : { keys: keys! },
    });
    const delivered = deliveries.filter((d) => d.delivered).map((d) => d.id);
    if (delivered.length > 0)
      office.messaging.showMessage({ fromId: caller, toIds: delivered, gist });
    return ok({
      results: deliveries.map((d) =>
        d.delivered
          ? { agent_id: d.id, delivered: true }
          : {
              agent_id: d.id,
              delivered: false,
              reason: d.reason,
              ...(d.screen ? { screen: d.screen.text, screen_token: d.screen.token } : {}),
            },
      ),
    });
  },
});
