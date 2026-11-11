import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { ClientMessage, Directory, Workspace } from '../../protocol';
import { normalizePath } from './workspaceRoot';

type SaveWorkspace = Extract<ClientMessage, { type: 'saveWorkspace' }>;

export interface WorkspaceDraft {
  name: string;
  /** 目前勾選的 Directory 路徑（含尚未登記、畫面上看不到的既有路徑，儲存時原樣保留） */
  directoryPaths: string[];
  /** 知識庫根目錄輸入；空字串表示不設定。伺服器存的是 realpath，所以只拿來比對「有沒有改」 */
  rootPath: string;
}

export interface DirectoryOption {
  directory: Directory;
  checked: boolean;
  /** 被另一個工作空間包含時的擁有者名稱；有值就不可選取（伺服器會拒絕） */
  ownerName: string | undefined;
}

export function draftFromWorkspace(workspace: Workspace): WorkspaceDraft {
  return {
    name: workspace.name,
    directoryPaths: [...workspace.directoryPaths],
    rootPath: workspace.rootPath ?? '',
  };
}

function samePathSet(left: string[], right: string[]): boolean {
  const leftKeys = new Set(left.map(normalizePath));
  const rightKeys = new Set(right.map(normalizePath));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

/** 草稿與伺服器的狀態逐字相同（用來判斷是否還要保留草稿，空白差異也算不同）。 */
export function draftEqualsWorkspace(workspace: Workspace, draft: WorkspaceDraft): boolean {
  return (
    draft.name === workspace.name &&
    samePathSet(draft.directoryPaths, workspace.directoryPaths) &&
    draft.rootPath === (workspace.rootPath ?? '')
  );
}

/** 名稱（去除前後空白後）或目錄集合與伺服器不同。 */
export function metaChanged(workspace: Workspace, draft: WorkspaceDraft): boolean {
  return (
    draft.name.trim() !== workspace.name ||
    !samePathSet(draft.directoryPaths, workspace.directoryPaths)
  );
}

/** 根目錄輸入（去除前後空白後）與伺服器存的不同；空字串等於清除。 */
export function rootChanged(workspace: Workspace, draft: WorkspaceDraft): boolean {
  return draft.rootPath.trim() !== (workspace.rootPath ?? '');
}

/** 儲存時會產生實際變更：名稱、目錄集合或根目錄任一不同。 */
export function isDirty(workspace: Workspace, draft: WorkspaceDraft): boolean {
  return metaChanged(workspace, draft) || rootChanged(workspace, draft);
}

/**
 * 由知識庫瀏覽的清單判斷是否為空：沒有檔案，或資料夾還沒建立（not_found）。
 * 清單還沒回來、或因為其他原因讀不到時回傳 undefined（不能當作空的）。
 */
export function kbViewIsEmpty(
  view: { listed: boolean; files: unknown[]; listError: string | null } | undefined,
): boolean | undefined {
  if (!view?.listed) return undefined;
  if (view.listError === 'not_found') return true;
  if (view.listError !== null) return undefined;
  return view.files.length === 0;
}

/**
 * 根目錄還能不能編輯：沒設定過就可以；設定過之後，知識庫要是空的（沒有檔案，或資料夾還沒建立）才行。
 * 清單還沒回來（kbIsEmpty 為 undefined）時一律不能編輯，避免先改再被伺服器退回。
 */
export function canEditRootPath(workspace: Workspace, kbIsEmpty: boolean | undefined): boolean {
  return workspace.rootPath === undefined || kbIsEmpty === true;
}

export function canSaveSettings(
  workspace: Workspace,
  draft: WorkspaceDraft,
  pending: boolean,
): boolean {
  return (
    !pending &&
    workspace.id !== DEFAULT_WORKSPACE_ID &&
    draft.name.trim() !== '' &&
    isDirty(workspace, draft)
  );
}

function ownerOf(
  path: string,
  workspaceId: string,
  workspaces: Workspace[],
): Workspace | undefined {
  const key = normalizePath(path);
  return workspaces.find(
    (other) =>
      other.id !== workspaceId &&
      other.id !== DEFAULT_WORKSPACE_ID &&
      other.directoryPaths.some((owned) => normalizePath(owned) === key),
  );
}

/** 可勾選的 Directory 清單：排除這個工作空間的根目錄（只比對相等），其他工作空間擁有的列出但標示擁有者。 */
export function directoryOptions(
  directories: Directory[],
  workspaces: Workspace[],
  workspace: Workspace,
  selectedPaths: string[],
): DirectoryOption[] {
  const rootKey = workspace.rootPath === undefined ? undefined : normalizePath(workspace.rootPath);
  const selectedKeys = new Set(selectedPaths.map(normalizePath));
  return directories
    .filter((directory) => normalizePath(directory.path) !== rootKey)
    .map((directory) => ({
      directory,
      checked: selectedKeys.has(normalizePath(directory.path)),
      ownerName: ownerOf(directory.path, workspace.id, workspaces)?.name,
    }));
}

export function toggleDirectory(
  draft: WorkspaceDraft,
  path: string,
  checked: boolean,
): WorkspaceDraft {
  const key = normalizePath(path);
  const rest = draft.directoryPaths.filter((owned) => normalizePath(owned) !== key);
  return { ...draft, directoryPaths: checked ? [...rest, path] : rest };
}

/** 草稿相對伺服器狀態是否移除了原本包含的目錄（用來顯示說明）。 */
export function removesDirectories(workspace: Workspace, draft: WorkspaceDraft): boolean {
  const kept = new Set(draft.directoryPaths.map(normalizePath));
  return workspace.directoryPaths.some((owned) => !kept.has(normalizePath(owned)));
}

/** 編輯只送 id、名稱與目錄；根目錄走 setWorkspaceRoot，權限角色由伺服器沿用，不重送。 */
export function buildSavePayload(workspaceId: string, draft: WorkspaceDraft): SaveWorkspace {
  return {
    type: 'saveWorkspace',
    id: workspaceId,
    name: draft.name.trim(),
    directoryPaths: draft.directoryPaths,
  };
}

/** 廣播裡的工作空間已反映這份草稿的名稱與目錄集合（根目錄另外判斷）。 */
export function reflectsDraft(workspace: Workspace | undefined, draft: WorkspaceDraft): boolean {
  return (
    workspace !== undefined &&
    workspace.name === draft.name.trim() &&
    samePathSet(workspace.directoryPaths, draft.directoryPaths)
  );
}
