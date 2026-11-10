import type { RootState } from '../../app/store';
import type { Directory, Workspace } from '../../protocol';

export const selectWorkspace = (state: RootState, workspaceId: string): Workspace | undefined =>
  state.workspaces.workspaces.find((workspace) => workspace.id === workspaceId);

export function directoryForPath(directories: Directory[], path: string): Directory | undefined {
  return directories.find((directory) => directory.path === path);
}
