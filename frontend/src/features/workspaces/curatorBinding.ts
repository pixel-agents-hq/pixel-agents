import { CURATOR_TEXT } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Directory } from '../../protocol';
import { directoryForPath } from './workspaceSelectors';

/** KB Writer 職缺且有綁定時回傳綁定的目錄路徑；Default 不會有綁定，也不承諾自動恢復。 */
export function vacantBindingPath(
  workspaceId: string,
  curators: Record<string, number>,
  bindings: Record<string, string>,
): string | undefined {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return undefined;
  if (curators[workspaceId] !== undefined) return undefined;
  return bindings[workspaceId];
}

/** 目錄顯示名稱：有登記就用名稱，沒有就顯示路徑。 */
export function directoryLabel(directories: Directory[], path: string): string {
  return directoryForPath(directories, path)?.name ?? path;
}

/** 只有非 Default 的工作空間會在重啟後自動恢復 KB Writer。 */
export function curatorPersistenceNote(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID
    ? CURATOR_TEXT.notPersisted
    : CURATOR_TEXT.persistedRestore;
}
