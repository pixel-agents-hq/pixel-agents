import { z } from 'zod';

import { defineTool, ok, refuse } from '../tool.js';

export const closePcShell = defineTool({
  name: 'close_pc_shell',
  title: 'Close PC shell',
  description:
    "Close a PC shell, as its card's × does: its terminal ends and its card goes. While a command runs in " +
    'it, refused (naming the command) unless `confirmed` is true, which ends that command too.',
  input: {
    shell_id: z.number().int().describe('The shell (list_pc_shells).'),
    confirmed: z
      .boolean()
      .optional()
      .describe('Close it even while a command runs (default false).'),
  },
  changes: true,
  uses: ['shells'],
  run: async ({ shell_id, confirmed }, { office }) => {
    const closed = await office.shells.closePcShell(shell_id, confirmed === true);
    if (!closed.ok) return refuse(closed.reason);
    return ok({ shell_id, closed: true });
  },
});
