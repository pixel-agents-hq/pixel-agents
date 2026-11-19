import { z } from 'zod';

import { defineTool, ok, refuse } from '../tool.js';

export const openPcShell = defineTool({
  name: 'open_pc_shell',
  title: 'Open PC shell',
  description:
    "Open a PC shell at a PC (a piece list_pc_shells lists under `pcs`): the user's login shell on this " +
    'machine, which the office shows the user as a card and a lit PC, its terminal a click away — a ' +
    'terminal set up for the user to watch. A PC with a live shell gives that one (`already_open`). A new ' +
    "one opens in `directory` (one of the PC's Area's Directories), else the Area's only Directory, else " +
    'the home folder. Then type into it with type_in_pc_shell and read it with read_pc_shell.',
  input: {
    furniture_uid: z.string().min(1).describe("The PC's furniture uid (list_pc_shells → pcs)."),
    directory: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A Directory name, one of the PC's Area's (default: the Area's only one, else home).",
      ),
  },
  changes: true,
  uses: ['shells'],
  run: ({ furniture_uid, directory }, { office }) => {
    const opened = office.shells.openPcShell(furniture_uid, directory);
    if (!opened.ok) {
      return refuse(`${opened.reason} See list_pc_shells for the PCs and their Directories.`);
    }
    return ok({
      shell_id: opened.id,
      cwd: opened.cwd,
      directory: opened.directory,
      already_open: opened.alreadyOpen,
    });
  },
});
