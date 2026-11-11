import type { Agent } from '../agents/agentsSlice';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Workspace } from '../../protocol';

/** Default 是伺服器固定的後備歸屬，不提供根目錄控制；唯讀連線也不顯示。 */
export function canEditWorkspaceRoot(workspaceId: string, readOnly: boolean): boolean {
  return !readOnly && workspaceId !== DEFAULT_WORKSPACE_ID;
}

/**
 * 變更或清除既有根目錄會讓執行中的 Agent 立即失去保護。
 * 持有 PTY 的 Agent（含 idle、waiting）都算；外部接入的 Agent 本來就沒有這些規則。
 */
export function countAgentsLosingProtection(agents: Agent[]): number {
  return agents.filter((agent) => !agent.stopped && !agent.isExternal).length;
}

export function rootChangeNeedsConfirm(currentRoot: string | undefined): boolean {
  return currentRoot !== undefined;
}

export function normalizePath(path: string): string {
  const stripped = path.trim().replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function isWithin(parent: string, child: string): boolean {
  return parent === '/' || child === parent || child.startsWith(`${parent}/`);
}

/** 找出根目錄與候選路徑相同、包含或被包含的「另一個」工作空間（以路徑邊界比較，不是字串前綴）。 */
export function findOverlappingWorkspace(
  candidate: string,
  workspaceId: string,
  workspaces: Workspace[],
): Workspace | undefined {
  const normalized = normalizePath(candidate);
  if (candidate.trim() === '') return undefined;
  return workspaces.find((other) => {
    if (other.id === workspaceId || other.rootPath === undefined) return false;
    const otherRoot = normalizePath(other.rootPath);
    return isWithin(otherRoot, normalized) || isWithin(normalized, otherRoot);
  });
}

export function confirmMessage(liveAgents: number): string {
  return `變更或清除根目錄後，${liveAgents} 個執行中的 Agent 會立即失去 KB/設定檔寫入保護。`;
}

/** Workspace 的根目錄只放 .note/，不是 Agent 的工作目錄：選單裡排除與根目錄相同的路徑（只比對相等，不含包含關係）。 */
export function selectableDirectoryPaths(
  directoryPaths: string[],
  rootPath: string | undefined,
): string[] {
  if (rootPath === undefined) return directoryPaths;
  const normalizedRoot = normalizePath(rootPath);
  return directoryPaths.filter((path) => normalizePath(path) !== normalizedRoot);
}
