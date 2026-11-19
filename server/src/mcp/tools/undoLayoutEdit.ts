import { defineTool, ok, refuse } from '../tool.js';

export const undoLayoutEdit = defineTool({
  name: 'undo_layout_edit',
  title: 'Undo the last layout edit',
  description:
    'Restore the office layout (and Directory mappings) from before the most recent edit_layout ' +
    "call — any agent's, the newest first; call again to go further back. Refused when the layout " +
    'changed since that edit (undo never discards newer work), or while someone has unsaved changes ' +
    'in the layout editor.',
  input: {},
  changes: true,
  uses: ['layout'],
  run: (_args, { office }) => {
    const outcome = office.layout.undoLayoutEdit();
    if (!outcome.ok) return refuse(outcome.reason);
    return ok({ undone: true, edit_by_agent: outcome.agentId, grid: outcome.grid });
  },
});
