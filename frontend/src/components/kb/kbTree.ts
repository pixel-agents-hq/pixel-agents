export interface KbDirectoryEntry {
  kind: 'folder' | 'file';
  name: string;
  /** 相對於知識庫根目錄、以 '/' 分隔的路徑 */
  path: string;
}

/** 知識庫根目錄；其餘目錄以 'a/b' 表示 */
export const KB_ROOT_DIR = '';

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** 上一層目錄；根目錄的上一層仍是根目錄。 */
export function parentDirectory(dir: string): string {
  return segmentsOf(dir).slice(0, -1).join('/');
}

/** 目錄內的子路徑。 */
export function joinDirectory(dir: string, name: string): string {
  return dir === KB_ROOT_DIR ? name : `${dir}/${name}`;
}

/**
 * 從扁平的檔案路徑清單取出 dir 這一層的內容：子資料夾（底下還有更深的檔案）與直屬檔案。
 * 資料夾在前、各自依名稱排序。
 */
export function listDirectory(paths: string[], dir: string): KbDirectoryEntry[] {
  const dirSegments = segmentsOf(dir);
  const folderNames = new Set<string>();
  const files: KbDirectoryEntry[] = [];
  for (const path of paths) {
    const segments = segmentsOf(path);
    if (segments.length <= dirSegments.length) continue;
    if (!dirSegments.every((segment, index) => segments[index] === segment)) continue;
    const name = segments[dirSegments.length];
    if (segments.length === dirSegments.length + 1) files.push({ kind: 'file', name, path });
    else folderNames.add(name);
  }
  const byName = (a: KbDirectoryEntry, b: KbDirectoryEntry) => a.name.localeCompare(b.name);
  const folders: KbDirectoryEntry[] = [...folderNames]
    .map((name) => ({ kind: 'folder' as const, name, path: joinDirectory(dir, name) }))
    .sort(byName);
  return [...folders, ...files.sort(byName)];
}
