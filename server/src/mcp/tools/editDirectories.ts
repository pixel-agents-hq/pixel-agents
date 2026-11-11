import { z } from 'zod';

import { MAX_DIRECTORY_OPS } from '../../constants.js';
import { directoryOpSchema } from '../directoryOps.js';
import { defineTool, ok, refuse } from '../tool.js';
import { describeDirectory } from './listDirectories.js';

export const editDirectories = defineTool({
  name: 'edit_directories',
  title: 'Edit the Directories',
  description:
    "Add, change or remove the user's Directories (the named folders agents are launched into) " +
    'in one atomic batch: `ops` apply in order to a copy, and either all apply (saved once, shown ' +
    'in every open office) or none do — a refusal names the failing op and why. Ops (`op` ' +
    'field): add {path, name?, characters?, character_order?, areas?, worktree_base?, ' +
    'worktree_branch_prefix?} (`path`: a folder that exists, absolute or under ~ — create it ' +
    "first if it doesn't; `name` defaults to the folder's), update {directory, name?, path?, " +
    '…the same settings} (only what is given changes; a rename takes its Area mapping along), ' +
    'remove {directory} (only the Directory entry: the folder and agents running in it are ' +
    'untouched). `characters`: its default characters, highest priority first, as ids, exact ' +
    'names or palette indices (list_characters; edit_characters creates one) — the whole list. ' +
    '`areas`: the labels of the Areas its agents sit in (get_layout; edit_layout create_area + ' +
    'paint_area make one) — the whole list. A Directory is named by its name or path ' +
    '(list_directories). So a new project is one op: add with its path, characters and areas. ' +
    'Only Directories the user defined can be updated or removed; `add` the path of the folder ' +
    'the office runs in to give it settings. There is no undo: update or remove again.',
  input: {
    ops: z
      .array(directoryOpSchema)
      .min(1)
      .max(MAX_DIRECTORY_OPS)
      .describe('Applied in order, all or none.'),
  },
  changes: true,
  uses: ['directories'],
  run: ({ ops }, { office }) => {
    const outcome = office.directories.editDirectories(ops);
    if (!outcome.ok) {
      const where =
        outcome.index === undefined ? '' : `op ${outcome.index} (${ops[outcome.index].op}): `;
      return refuse(`${where}${outcome.reason.replace(/\.$/, '')}. Nothing was changed.`);
    }
    const { directories, removed, notes } = outcome;
    return ok({
      applied: ops.length,
      changed: outcome.changed,
      ...(directories.length ? { directories: directories.map(describeDirectory) } : {}),
      ...(removed.length ? { removed } : {}),
      ...(notes.length ? { notes } : {}),
    });
  },
});
