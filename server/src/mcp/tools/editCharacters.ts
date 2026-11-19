import { z } from 'zod';

import { CHARACTER_PREVIEW_LIMIT } from '../../constants.js';
import { characterOpSchema, MAX_CHARACTER_OPS } from '../characterEditOps.js';
import { defineTool, ok, refuse } from '../tool.js';

export const editCharacters = defineTool({
  name: 'edit_characters',
  title: 'Edit the characters',
  description:
    'Change the Pixel Agents roster in one atomic batch: `ops` apply in order to a copy, and either ' +
    'all apply (saved once, shown in every open office, agents wearing a changed or deleted ' +
    'character re-looked as a hand edit does) or none do — a refusal names the failing op and why. ' +
    'A character is a 16x32-pixel sprite: a part is a few pixels, so a look comes from shapes and ' +
    'colours. Call list_wardrobe first: parts, colours and their formats are its vocabulary. Ops ' +
    '(`op` field): create_character {name, ref?, body?, eye_shape?, eye_rows?, parts?, colors?, ' +
    'randomize?} (`parts`: slot → part id or null; `colors`: colour key → {name} | {colorway} | ' +
    '{hex} | {h,s,b,c} | null, applied to the part worn; `randomize`: fill every slot and colour ' +
    'not given at random; `ref` names it for later ops in the batch), update_character ' +
    '{character, name?, body?, eye_shape?, eye_rows?, parts?, colors?} (only what is given ' +
    'changes; an outfit and a top take each other off), delete_character {character}, ' +
    'add_to_directory {character, directory, position?} (a Directory default character: agents ' +
    'launched into it wear it; position 0 = highest priority, default last), ' +
    'remove_from_directory {character, directory}. A character is an id, exact name, palette ' +
    'index or batch ref; a Directory is named as launch_agent names one. The reply lists what ' +
    'changed and pictures every character created or changed (PNG after the JSON: standing ' +
    `facing down, up and right; at most ${CHARACTER_PREVIEW_LIMIT}): check it against what was ` +
    'asked and adjust with update_character, then launch_agent with the character; ' +
    'undo_character_edit reverts the whole batch. Refused while ' +
    "someone has unsaved changes in the Characters view; the greeter's character (char-0) can't " +
    'be deleted.',
  input: {
    ops: z
      .array(characterOpSchema)
      .min(1)
      .max(MAX_CHARACTER_OPS)
      .describe('Applied in order, all or none.'),
  },
  changes: true,
  uses: ['characters'],
  run: ({ ops }, { caller, office }) => {
    const outcome = office.characters.editCharacters(caller, ops);
    if (!outcome.ok) {
      const where =
        outcome.index === undefined ? '' : `op ${outcome.index} (${ops[outcome.index].op}): `;
      // A failed rollback says itself what may have changed.
      if (outcome.partial) return refuse(outcome.reason);
      return refuse(`${where}${outcome.reason.replace(/\.$/, '')}. Nothing was changed.`);
    }
    const { created, updated, deleted, directories, notes } = outcome;
    // Every character created or changed, as it is now (a later op may have renamed it).
    const pictured = [...created, ...updated].map((c) => c.id);
    const previews = pictured.length ? office.characters.previews(pictured) : null;
    const shown = previews?.ok ? previews.previews : [];
    const allNotes = [...notes];
    if (shown.length < pictured.length) {
      allNotes.push(
        `Pictured ${shown.length} of the ${pictured.length} characters created or changed ` +
          `(${CHARACTER_PREVIEW_LIMIT} a call): list_characters with \`preview\` shows the rest.`,
      );
    }
    const at = (ref: string | number) => office.characters.characterAt(ref);
    // As each is now: a later op may have renamed it.
    const named = (list: typeof created) =>
      list.map(({ op, id, ref }) => ({ op, ...at(id), ...(ref ? { ref } : {}) }));
    return ok(
      {
        applied: ops.length,
        changed: outcome.changed,
        ...(created.length ? { created: named(created) } : {}),
        ...(updated.length ? { updated: named(updated) } : {}),
        ...(deleted.length
          ? { deleted: deleted.map(({ op, id, name }) => ({ op, id, name })) }
          : {}),
        ...(directories.length
          ? {
              directories: directories.map((d) => ({
                directory: d.directory,
                characters: d.characters.map(at),
              })),
            }
          : {}),
        ...(shown.length
          ? { previews: shown.map(({ id, name, palette }) => ({ id, name, palette })) }
          : {}),
        ...(allNotes.length ? { notes: allNotes } : {}),
      },
      shown.map((p) => ({ data: p.png, mimeType: 'image/png' as const })),
    );
  },
});
