import { z } from 'zod';

import { SHELL_KEYS } from '../officeOperations.js';
import { defineTool, ok, refuse } from '../tool.js';

export const typeInPcShell = defineTool({
  name: 'type_in_pc_shell',
  title: 'Type in PC shell',
  description:
    'Type into a PC shell: text (Enter pressed after it unless `submit` is false, so a command runs), or ' +
    'named keys pressed in order (`ctrl+c` stops a running command, `ctrl+d` ends input). Typed as is, ' +
    'with no tag. The user sees it in the shell, and whatever runs there runs on this machine as the ' +
    'user. Read the result with read_pc_shell.',
  input: {
    shell_id: z.number().int().describe('The shell (list_pc_shells / open_pc_shell).'),
    text: z.string().min(1).optional().describe('Text to type. Exactly one of text / keys.'),
    keys: z
      .array(z.enum(SHELL_KEYS))
      .min(1)
      .optional()
      .describe('Named keys to press, in order. Exactly one of text / keys.'),
    submit: z
      .boolean()
      .optional()
      .describe('Press Enter after the text (default true). Text only.'),
  },
  changes: true,
  uses: ['shells'],
  run: async ({ shell_id, text, keys, submit }, { office }) => {
    if ((text === undefined) === (keys === undefined)) {
      return refuse('Give exactly one of `text` or `keys`.');
    }
    if (keys !== undefined && submit !== undefined) {
      return refuse('`submit` goes with `text` only: add "enter" to `keys` to press it.');
    }
    const typed = await office.shells.typeInPcShell(
      shell_id,
      text !== undefined ? { text, submit: submit ?? true } : { keys: keys! },
    );
    if (!typed.ok) return refuse(typed.reason);
    return ok({ shell_id, typed: true });
  },
});
