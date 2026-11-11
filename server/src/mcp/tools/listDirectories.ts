import type { OfficeDirectory } from '../officeOperations.js';
import { defineTool, ok } from '../tool.js';

/** One Directory as the tools report it (snake_case, the agent-facing shape). */
export function describeDirectory(d: OfficeDirectory): Record<string, unknown> {
  return {
    name: d.name,
    path: d.path,
    source: d.source,
    is_repo: d.isRepo,
    areas: d.areas,
    characters: d.characters,
    character_order: d.characterOrder,
    worktree_base: d.worktreeBase,
    worktree_branch_prefix: d.worktreeBranchPrefix,
  };
}

export const listDirectories = defineTool({
  name: 'list_directories',
  title: 'List Directories',
  description:
    'The Directories of the Pixel Agents office: the named folders agents are launched into. Each ' +
    'with its name, path, `source` (`user`: one the user defined, which edit_directories can ' +
    'change; `host`: the folder the office itself runs in, with no settings of its own), whether ' +
    'it is a git repo, the Areas its agents sit in, its default characters (highest priority ' +
    'first; agents launched into it wear them) and their order, and its Worktree settings.',
  input: {},
  changes: false,
  uses: ['directories'],
  run: (_args, { office }) =>
    ok({ directories: office.directories.listDirectories().map(describeDirectory) }),
});
