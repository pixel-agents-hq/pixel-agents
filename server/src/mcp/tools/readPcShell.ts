import { z } from 'zod';

import { defineTool, ok, refuse } from '../tool.js';

export const readPcShell = defineTool({
  name: 'read_pc_shell',
  title: 'Read PC shell',
  description:
    "Read a PC shell's screen as text (the rows it shows right now) and its `screen_token` (equal tokens = " +
    'the same screen). Read after typing to see what a command printed; output still arriving may need ' +
    'another read.',
  input: {
    shell_id: z.number().int().describe('The shell (list_pc_shells / open_pc_shell).'),
  },
  changes: false,
  uses: ['shells'],
  run: async ({ shell_id }, { office }) => {
    const read = await office.shells.readPcShell(shell_id);
    if (!read.ok) return refuse(read.reason);
    return ok({ shell_id, screen: read.screen.text, screen_token: read.screen.token });
  },
});
