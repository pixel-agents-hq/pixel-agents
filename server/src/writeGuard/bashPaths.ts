/**
 * Bash 寫入目標的路徑解析（P3 補充決定 4）。
 *
 * 相對路徑有兩個起點候選：payload cwd 與 Agent Directory（任一命中受保護區就算命中）。
 * - hook 端（resolveBashPaths）：以 payload cwd 為起點，經 PathNormalizer 做作業系統語意
 *   與字面語意兩個候選（會碰檔案系統，lstat/readlink）。伺服器不可達時的本地
 *   fail-closed 只能用這一組（hook 不知道 Agent Directory）。
 * - 伺服器端（lexicalBashPaths）：以啟動時記錄的 Agent Directory realpath 為起點，
 *   只做字面組合與 `..` 消去，不碰檔案系統（F13）。
 * 同一指令字串內的 cd 已經在路徑段裡（bashParser.ts）。tilde 段以 HOME 取代。
 */

import * as path from 'path';

import type { BashAnalysis, BashTarget } from './bashTypes.js';
import type { PathNormalizer } from './pathNormalization.js';
import { normalizeTargetCandidates, pathApiFor } from './pathNormalization.js';

/** 把路徑段接成一個原始路徑（不消去 `..`：交給 normalizer 依作業系統語意處理）。 */
function joinSegments(api: typeof path.posix, base: string, target: BashTarget, home: string) {
  let raw = base;
  for (const segment of target.segments) {
    const text = segment.tilde ? `${home}${segment.text.slice(1)}` : segment.text;
    if (api.isAbsolute(text)) raw = text;
    else raw = raw.length === 0 ? text : `${raw}${api.sep}${text}`;
  }
  return raw;
}

/** hook 端解析後的三組路徑；unresolved 表示至少一個目標無法判斷。 */
export interface ResolvedBashPaths {
  direct: string[];
  recursive: string[];
  mentioned: string[];
  unresolved: boolean;
}

function addAll(list: string[], items: readonly string[]): void {
  for (const item of items) if (!list.includes(item)) list.push(item);
}

/** hook 端：以 payload cwd 為起點，正規化每個目標與字面路徑片段。 */
export function resolveBashPaths(
  analysis: BashAnalysis,
  cwd: string,
  home: string,
  normalizer: PathNormalizer,
  /** 回 true 時停止（時鐘防線）；剩下的目標視為無法判斷。 */
  shouldStop: () => boolean = () => false,
): ResolvedBashPaths {
  const api = pathApiFor(normalizer);
  const out: ResolvedBashPaths = {
    direct: [],
    recursive: [],
    mentioned: [],
    unresolved: analysis.truncated,
  };
  const resolve = (t: BashTarget, list: string[]): void => {
    if (shouldStop()) {
      out.unresolved = true;
      return;
    }
    const raw = joinSegments(api, cwd, t, home);
    const candidates = normalizeTargetCandidates(normalizer, raw, '');
    if (candidates === null) out.unresolved = true;
    else addAll(list, candidates);
  };
  for (const t of analysis.targets) resolve(t, t.mode === 'recursive' ? out.recursive : out.direct);
  for (const t of analysis.mentions) resolve(t, out.mentioned);
  return out;
}

/** 伺服器端：以 Agent Directory 為起點的字面候選（不碰檔案系統）。 */
export function lexicalBashPaths(
  analysis: BashAnalysis,
  directory: string,
  home: string,
): { direct: string[]; recursive: string[]; mentioned: string[] } {
  const toPath = (t: BashTarget): string => path.resolve(joinSegments(path, directory, t, home));
  const out = { direct: [] as string[], recursive: [] as string[], mentioned: [] as string[] };
  for (const t of analysis.targets) {
    addAll(t.mode === 'recursive' ? out.recursive : out.direct, [toPath(t)]);
  }
  addAll(out.mentioned, analysis.mentions.map(toPath));
  return out;
}
