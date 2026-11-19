import { CHARACTER_PREVIEW_LIMIT } from '../../constants.js';
import { defineTool, ok, refuse } from '../tool.js';

export const undoCharacterEdit = defineTool({
  name: 'undo_character_edit',
  title: 'Undo the last Character edit',
  description:
    "Restore the roster (and the Directories' default characters) from before the most recent " +
    "edit_characters call — any agent's, the newest first; call again to go further back. Agents " +
    'wearing a character it removes are re-looked, as a hand edit does. Refused when the roster or ' +
    'a Directory it touched changed since that edit (undo never discards newer work), or while ' +
    'someone has unsaved changes in the Characters view. The reply pictures the characters it ' +
    `brought back (PNG after the JSON; at most ${CHARACTER_PREVIEW_LIMIT}).`,
  input: {},
  changes: true,
  uses: ['characters'],
  run: (_args, { office }) => {
    const outcome = office.characters.undoCharacterEdit();
    if (!outcome.ok) return refuse(outcome.reason);
    const previews = outcome.restored.length ? office.characters.previews(outcome.restored) : null;
    const shown = previews?.ok ? previews.previews : [];
    const at = (ref: string | number) => office.characters.characterAt(ref);
    return ok(
      {
        undone: true,
        edit_by_agent: outcome.agentId,
        agent_name: outcome.agentName,
        edit: outcome.summary,
        ...(outcome.restored.length ? { restored: outcome.restored.map(at) } : {}),
        ...(outcome.removed.length ? { removed: outcome.removed } : {}),
        ...(outcome.directories.length
          ? {
              directories: outcome.directories.map((d) => ({
                directory: d.directory,
                characters: d.characters.map(at),
              })),
            }
          : {}),
        ...(shown.length < outcome.restored.length
          ? {
              notes: [
                `Pictured ${shown.length} of the ${outcome.restored.length} characters brought back ` +
                  `(${CHARACTER_PREVIEW_LIMIT} a call): list_characters with \`preview\` shows the rest.`,
              ],
            }
          : {}),
      },
      shown.map((p) => ({ data: p.png, mimeType: 'image/png' as const })),
    );
  },
});
