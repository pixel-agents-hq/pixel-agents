/**
 * createAgent 帶 workspaceId 時的自由路徑：驗證、規劃、建立與清理。
 *
 * 流程分三步，彼此不共用狀態：
 * 1. planAgentPath：所有規則（字串、realpath、HOME、保護區、KB 區）都在這裡判定，
 *    只讀檔案系統（realpath／lstat），絕不建立任何東西；
 * 2. createAgentDirectories：照規劃逐段「非遞迴」mkdir，每段 lstat 確認是真的目錄
 *    （不是 symlink）並記下 dev+ino，最後確認 realpath 與規劃一致，再初始化個人 KB
 *    資料夾 `<final>/.note/_default/`；任何失敗只移除自己建立的目錄；
 * 3. removeCreatedDirectories：後續步驟失敗時，逆序 rmdir 本次建立的目錄，
 *    每個先比對 dev+ino，遇到非空目錄就停止（不碰既有目錄）。
 *
 * 記錄只寫規則代碼與已通過字元檢查的路徑，絕不記錄未通過規則 2 的原始字串。
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AGENT_DIRECTORY_MODE,
  AGENT_PATH_MAX_NEW_SEGMENTS,
  AGENT_PATH_SEGMENT_MAX_BYTES,
  AGENT_PATH_SYSTEM_ROOTS,
  KB_CLAUDE_HOME_DIR_NAME,
  KB_NOTE_DIR_NAME,
  KB_PERSONAL_RESERVED_KEY,
  LAYOUT_FILE_DIR,
  WORKSPACE_DIRECTORY_PATH_MAX_LENGTH,
} from './constants.js';
import { normalizeZone, workspaceKbOverlapsPersonal } from './writeGuard/kbOverlap.js';
import {
  literalComparisonKey,
  type PathNormalizer,
  pathNormalizer,
  samePath,
} from './writeGuard/pathNormalization.js';

/** 拒絕的規則代碼（只用於記錄，不含路徑）。 */
export type AgentPathRefusal =
  | 'not-a-string'
  | 'too-long'
  | 'control-character'
  | 'segment-whitespace'
  | 'segment-too-long'
  | 'not-absolute'
  | 'not-normalized'
  | 'dot-segment'
  | 'note-segment'
  | 'ancestor-unresolvable'
  | 'ancestor-not-directory'
  | 'home-unresolvable'
  | 'create-outside-home'
  | 'too-many-new-segments'
  | 'root-or-home'
  | 'system-root'
  | 'protected-zone'
  | 'workspace-kb-overlap'
  | 'kb-folder-not-directory'
  | 'mkdir-failed'
  | 'not-real-directory'
  | 'realpath-mismatch';

export type AgentPathResult<T> = ({ ok: true } & T) | { ok: false; reason: AgentPathRefusal };

export interface AgentPathPlan {
  /** realpath 後的最終路徑：最近既有上層的 realpath，接上字面的新段。 */
  finalPath: string;
  /** 最近既有上層的 realpath（新段從這裡開始建立）。 */
  existingAncestor: string;
  /** 需要新建的段，由上而下。 */
  newSegments: string[];
}

export interface AgentPathContext {
  /** os.homedir()（呼叫端傳入，測試可替換）。 */
  homeDir: string;
  /** 每個已設定根目錄的 Workspace 根目錄（它們的 `<root>/.note` 是 Workspace KB 區）。 */
  workspaceRoots: readonly string[];
  normalizer?: PathNormalizer;
}

/** 本次建立的一個目錄；清理時以 dev+ino 確認仍是同一個。 */
export interface CreatedDirectory {
  path: string;
  dev: number;
  ino: number;
}

/** NUL、C0、DEL、C1 控制字元（規則 2）。 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function refuse(reason: AgentPathRefusal): { ok: false; reason: AgentPathRefusal } {
  return { ok: false, reason };
}

/** 去掉結尾的分隔字元（根目錄本身保留）。 */
function withoutTrailingSeparator(value: string): string {
  const root = path.parse(value).root;
  let end = value.length;
  while (end > root.length && value[end - 1] === path.sep) end--;
  return value.slice(0, end);
}

function segmentsOf(absolute: string): string[] {
  const root = path.parse(absolute).root;
  return absolute
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
}

/**
 * 規則 1、2 與段名規則，對原始字串與 realpath 後的最終路徑各套一次：
 * 長度、控制字元、段的前後空白（因此 saveWorkspace 的 trim 不會改變它）、
 * 段的位元組長度、`.`／`..`、名為 `.note` 的段（darwin／win32 不分大小寫）。
 */
function checkPathText(
  value: string,
  normalizer: PathNormalizer,
): { ok: true } | { ok: false; reason: AgentPathRefusal } {
  if (value.length > WORKSPACE_DIRECTORY_PATH_MAX_LENGTH) return refuse('too-long');
  if (CONTROL_CHARACTER.test(value)) return refuse('control-character');
  const noteKey = literalComparisonKey(normalizer, KB_NOTE_DIR_NAME);
  for (const segment of segmentsOf(value)) {
    if (segment.trim() !== segment) return refuse('segment-whitespace');
    if (Buffer.byteLength(segment, 'utf8') > AGENT_PATH_SEGMENT_MAX_BYTES) {
      return refuse('segment-too-long');
    }
    if (segment === '.' || segment === '..') return refuse('dot-segment');
    if (literalComparisonKey(normalizer, segment) === noteKey) return refuse('note-segment');
  }
  return { ok: true };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * 最近的既有上層（realpath）與其下待建立的字面段。懸空 symlink、非 ENOENT 的錯誤
 * （例如中間有一段是檔案）一律拒絕。
 */
function resolveExistingAncestor(
  literal: string,
): AgentPathResult<{ ancestor: string; remaining: string[] }> {
  const remaining: string[] = [];
  let probe = literal;
  for (;;) {
    try {
      const ancestor = fs.realpathSync(probe);
      return { ok: true, ancestor, remaining };
    } catch (err) {
      if (!isMissing(err)) return refuse('ancestor-unresolvable');
    }
    // realpath 說不存在，但 lstat 看得到：懸空 symlink，不能在它的位置建立目錄。
    try {
      fs.lstatSync(probe);
      return refuse('ancestor-unresolvable');
    } catch (err) {
      if (!isMissing(err)) return refuse('ancestor-unresolvable');
    }
    const parent = path.dirname(probe);
    if (parent === probe) return refuse('ancestor-unresolvable');
    remaining.unshift(path.basename(probe));
    probe = parent;
  }
}

/** 一個路徑是真的目錄（不是 symlink）時回傳它的 lstat；不存在回 null；其他情況回 false。 */
function realDirectoryStats(target: string): fs.Stats | null | false {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (err) {
    return isMissing(err) ? null : false;
  }
  return stats.isDirectory() && !stats.isSymbolicLink() ? stats : false;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * 驗證並規劃一個 createAgent 的路徑。只讀檔案系統，絕不建立任何東西；
 * 任何一條規則不過就拒絕。
 */
export function planAgentPath(
  raw: unknown,
  context: AgentPathContext,
): AgentPathResult<AgentPathPlan> {
  const normalizer = context.normalizer ?? pathNormalizer;

  // 規則 1、2：型別、長度、控制字元、段的空白與長度（不 trim）。
  if (typeof raw !== 'string' || raw.length === 0) return refuse('not-a-string');
  const rawText = checkPathText(raw, normalizer);
  if (!rawText.ok) return rawText;

  // 規則 3：絕對路徑（`~` 開頭的不是），去掉結尾分隔字元後必須已是正規形式。
  if (!path.isAbsolute(raw)) return refuse('not-absolute');
  const literal = withoutTrailingSeparator(raw);
  if (literal !== withoutTrailingSeparator(path.normalize(raw))) return refuse('not-normalized');

  // 規則 4：最近既有上層的 realpath + 字面的新段。
  const resolved = resolveExistingAncestor(literal);
  if (!resolved.ok) return resolved;
  const { ancestor, remaining } = resolved;
  try {
    if (!fs.statSync(ancestor).isDirectory()) return refuse('ancestor-not-directory');
  } catch {
    return refuse('ancestor-not-directory');
  }
  const finalPath = remaining.length > 0 ? path.join(ancestor, ...remaining) : ancestor;
  // realpath 可能經 symlink 換成另一串文字：最終路徑也要通過同一組文字規則。
  const finalText = checkPathText(finalPath, normalizer);
  if (!finalText.ok) return finalText;

  // 規則 5：只在 HOME 之下（嚴格在內）建立目錄，最多 AGENT_PATH_MAX_NEW_SEGMENTS 段。
  const realHome = realpathOrNull(context.homeDir);
  if (realHome === null) return refuse('home-unresolvable');
  const insideHome = normalizer.isWithin(finalPath, realHome);
  if (remaining.length > 0) {
    const ancestorStrictlyInsideHome =
      normalizer.isWithin(ancestor, realHome) && !samePath(normalizer, ancestor, realHome);
    if (!ancestorStrictlyInsideHome) return refuse('create-outside-home');
    if (remaining.length > AGENT_PATH_MAX_NEW_SEGMENTS) return refuse('too-many-new-segments');
  }

  // 規則 6：不是 `/`、不是 HOME；HOME 之外也不是系統根目錄（realpath 後比對）。
  if (samePath(normalizer, finalPath, path.parse(finalPath).root)) return refuse('root-or-home');
  if (samePath(normalizer, finalPath, realHome)) return refuse('root-or-home');
  if (!insideHome) {
    for (const systemRoot of AGENT_PATH_SYSTEM_ROOTS) {
      const candidates = [systemRoot, realpathOrNull(systemRoot)].filter(
        (candidate): candidate is string => candidate !== null,
      );
      if (candidates.some((candidate) => samePath(normalizer, finalPath, candidate))) {
        return refuse('system-root');
      }
    }
  }

  // 規則 7：不得等於、位於或包含 ~/.claude 與 ~/.pixel-agents（與 kbState 同一套計算）。
  const protectedZones = [KB_CLAUDE_HOME_DIR_NAME, LAYOUT_FILE_DIR].map((name) =>
    normalizeZone(normalizer, path.join(context.homeDir, name)),
  );
  for (const zone of protectedZones) {
    if (normalizer.isWithin(finalPath, zone) || normalizer.isWithin(zone, finalPath)) {
      return refuse('protected-zone');
    }
  }

  // 規則 8：`<final>/.note` 不得與任何 Workspace KB 區相等或互相包含。
  if (
    context.workspaceRoots.some((root) =>
      workspaceKbOverlapsPersonal(normalizer, root, [finalPath]),
    )
  ) {
    return refuse('workspace-kb-overlap');
  }

  // 規則 9 的事前檢查：既有的 `.note`／`.note/_default` 必須是真的目錄（不是 symlink 或檔案）。
  if (remaining.length === 0) {
    const noteDir = path.join(finalPath, KB_NOTE_DIR_NAME);
    const note = realDirectoryStats(noteDir);
    if (note === false) return refuse('kb-folder-not-directory');
    if (
      note !== null &&
      realDirectoryStats(path.join(noteDir, KB_PERSONAL_RESERVED_KEY)) === false
    ) {
      return refuse('kb-folder-not-directory');
    }
  }

  return { ok: true, finalPath, existingAncestor: ancestor, newSegments: remaining };
}

/** 非遞迴建立一個目錄並確認它是真的目錄；成功時回傳要記錄的 dev+ino。 */
function makeDirectory(target: string): CreatedDirectory | AgentPathRefusal {
  try {
    fs.mkdirSync(target, { mode: AGENT_DIRECTORY_MODE });
  } catch {
    return 'mkdir-failed';
  }
  const stats = realDirectoryStats(target);
  if (!stats) return 'not-real-directory';
  return { path: target, dev: stats.dev, ino: stats.ino };
}

/**
 * 依規劃建立目錄，並初始化個人 KB 資料夾 `<final>/.note/_default/`（空目錄）。
 * 已存在的 `.note`／`_default` 必須是真的目錄；不存在才建立。失敗時移除本次
 * 建立的目錄後回傳拒絕。
 */
export function createAgentDirectories(
  plan: AgentPathPlan,
): AgentPathResult<{ created: CreatedDirectory[] }> {
  const created: CreatedDirectory[] = [];
  const fail = (reason: AgentPathRefusal): { ok: false; reason: AgentPathRefusal } => {
    removeCreatedDirectories(created);
    return refuse(reason);
  };

  let current = plan.existingAncestor;
  for (const segment of plan.newSegments) {
    current = path.join(current, segment);
    const made = makeDirectory(current);
    if (typeof made === 'string') return fail(made);
    created.push(made);
  }

  if (realpathOrNull(plan.finalPath) !== plan.finalPath) return fail('realpath-mismatch');

  let kbDir = plan.finalPath;
  for (const name of [KB_NOTE_DIR_NAME, KB_PERSONAL_RESERVED_KEY]) {
    kbDir = path.join(kbDir, name);
    const existing = realDirectoryStats(kbDir);
    if (existing === false) return fail('kb-folder-not-directory');
    if (existing !== null) continue;
    const made = makeDirectory(kbDir);
    if (typeof made === 'string') return fail(made);
    created.push(made);
  }

  return { ok: true, created };
}

/**
 * 逆序移除本次建立的目錄。每個先 lstat 比對 dev+ino；已不存在就略過，
 * 換成別的東西或非空（ENOTEMPTY）就停止並記錄，既有目錄一律不碰。
 */
export function removeCreatedDirectories(created: readonly CreatedDirectory[]): void {
  for (const entry of [...created].reverse()) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(entry.path);
    } catch (err) {
      if (isMissing(err)) continue;
      console.warn(
        `[Pixel Agents] createAgent cleanup: stopped at ${JSON.stringify(entry.path)} (unreadable)`,
      );
      return;
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.dev !== entry.dev ||
      stats.ino !== entry.ino
    ) {
      console.warn(
        `[Pixel Agents] createAgent cleanup: stopped at ${JSON.stringify(entry.path)} (replaced)`,
      );
      return;
    }
    try {
      fs.rmdirSync(entry.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      console.warn(
        `[Pixel Agents] createAgent cleanup: stopped at ${JSON.stringify(entry.path)} (${code})`,
      );
      return;
    }
  }
}
