import { defineTool, ok } from '../tool.js';

export const listPcShells = defineTool({
  name: 'list_pc_shells',
  title: 'List PC shells',
  description:
    "List the office's PC shells: the plain terminals (the user's login shell on this machine) that PCs in " +
    'the office open, which the user can watch and use like any terminal. `shells`: every live one — ' +
    '`shell_id`, the PC it was opened at (`furniture_uid`, absent once that piece left the layout), its ' +
    'Directory, its folder (`cwd`), and `busy` (a command is running; `command` names it when known). ' +
    '`pcs`: every piece of the layout that opens one — its `furniture_uid`, its Area, the Directories a new ' +
    'shell there may open in, and its live `shell_id` if it has one. Open one with open_pc_shell.',
  input: {},
  changes: false,
  uses: ['shells'],
  run: async (_args, { office }) => {
    const { shells, pcs } = await office.shells.listPcShells();
    return ok({
      shells: shells.map((s) => ({
        shell_id: s.id,
        ...(s.furnitureUid !== null ? { furniture_uid: s.furnitureUid } : {}),
        directory: s.directory,
        cwd: s.cwd,
        busy: s.busy,
        ...(s.command !== undefined ? { command: s.command } : {}),
      })),
      pcs: pcs.map((pc) => ({
        furniture_uid: pc.furnitureUid,
        area: pc.area,
        directories: pc.directories,
        shell_id: pc.shellId,
      })),
    });
  },
});
