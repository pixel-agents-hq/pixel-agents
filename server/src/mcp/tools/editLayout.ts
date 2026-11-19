import { z } from 'zod';

import { layoutOpSchema, MAX_LAYOUT_OPS } from '../layoutEditOps.js';
import { defineTool, ok, refuse } from '../tool.js';

export const editLayout = defineTool({
  name: 'edit_layout',
  title: 'Edit the office layout',
  description:
    'Change the Pixel Agents office in one atomic batch: `ops` apply in order to a copy, and either ' +
    'all apply (saved once, shown in every open office) or none do — a refusal names the failing op ' +
    "and why. Coordinates, types, colours and indices are get_layout's and list_catalog's (read " +
    'list_catalog `rules` first). Ops (`op` field): ' +
    'place_furniture {type, col, row, color?, uid?} (top-left of the footprint; name it with uid to ' +
    'refer to it later in the batch), move_furniture {uid, col, row} (a desk carries what stands on ' +
    'it), rotate_furniture {uid, orientation}, recolor_furniture {uid, color|null}, ' +
    'toggle_furniture {uid, state?}, remove_furniture {uid} (only that item); ' +
    'paint_floor {tiles, pattern, color?}, paint_walls {tiles, wall_set?, color?} (default: an ' +
    "existing wall's look), remove_walls {tiles, pattern?, color?} (walls become that floor), " +
    'erase {tiles} (to void, removing furniture standing there), paint_carpet {tiles, variant, ' +
    'color?, accent_color?}, remove_carpet {tiles}; place_pet / remove_pet {pet_type}; ' +
    'create_area {label, color}, update_area {label, new_label?, color?}, delete_area {label}, ' +
    'paint_area {label, tiles}, unpaint_area {tiles, label?} (Areas cover floor only; mapped ' +
    'Directories follow a rename); map_directory / unmap_directory {directory, area?} (agents ' +
    'launched into the Directory sit in the Area); resize_grid {left?, right?, top?, bottom?} ' +
    '(tiles to add, up to the grid limit in list_catalog rules; negative removes an edge, only when it is all void with no furniture). ' +
    'Growing left or top shifts every coordinate after it in the batch. `tiles` mixes {col,row} and ' +
    '{col,row,width,height}; a tile off the grid refuses. A room is floor + walls + an Area. ' +
    'Refused while someone has unsaved changes in the layout editor. undo_layout_edit reverts the newest edit.',
  input: {
    ops: z
      .array(layoutOpSchema)
      .min(1)
      .max(MAX_LAYOUT_OPS)
      .describe('Applied in order, all or none.'),
  },
  changes: true,
  uses: ['layout'],
  run: ({ ops }, { caller, office }) => {
    const outcome = office.layout.editLayout(caller, ops);
    if (!outcome.ok) {
      const where =
        outcome.index === undefined ? '' : `op ${outcome.index} (${ops[outcome.index].op}): `;
      return refuse(`${where}${outcome.reason.replace(/\.$/, '')}. Nothing was changed.`);
    }
    return ok({
      applied: ops.length,
      changed: outcome.changed,
      grid: outcome.grid,
      ...(outcome.placed.length ? { placed: outcome.placed } : {}),
      ...(outcome.notes.length ? { notes: outcome.notes } : {}),
      ...(outcome.changed ? { undo: 'undo_layout_edit reverts this edit' } : {}),
    });
  },
});
