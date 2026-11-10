import { createSelector } from '@reduxjs/toolkit';

import type { RootState } from '../../app/store';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Directory, Workspace } from '../../protocol';

/** Default 是伺服器固定的後備歸屬，不給使用者選：建立 Agent 時直接選工作空間，不會落到 Default。 */
export const selectVisibleWorkspaces = createSelector(
  [(state: RootState) => state.workspaces.workspaces],
  (workspaces) => workspaces.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID),
);

export const selectWorkspace = (state: RootState, workspaceId: string): Workspace | undefined =>
  state.workspaces.workspaces.find((workspace) => workspace.id === workspaceId);

export function directoryForPath(directories: Directory[], path: string): Directory | undefined {
  return directories.find((directory) => directory.path === path);
}
