/**
 * 伺服器端的寫入裁決與清單發佈（standalone 限定；VS Code 內嵌伺服器從不建立它）。
 *
 * - 裁決（verdict）只做記憶體查詢（F13）：在 store 中找 session id 相符、且
 *   PTY 仍由本伺服器持有的 Agent（「已知 standalone Agent」），再套用規則。
 *   不讀寫任何檔案、不做 realpath：路徑在 hook 端已正規化。
 * - 清單發佈（publish）：把已 realpath 的受保護根目錄與已知 session 寫成
 *   `~/.pixel-agents/guard/<pid>-<port>.json`，讓 hook 在伺服器不可達時也能
 *   在本地判斷是否 fail-closed。Agent 加入、移除、清空、session 註冊變更時
 *   立即更新，另有後備間隔重算；內容不變不寫檔。
 *
 * 受保護根目錄在 P1 沒有正式來源（只由測試直寫）；P2 起由工作空間設定產生。
 * 規則在 P1 是最小版本 protectedRootsRule；P2 以 KB 規則替換。
 */

import * as os from 'os';

import type { AgentStateStore } from '../agentStateStore.js';
import {
  WRITE_GUARD_LIST_REFRESH_INTERVAL_MS,
  WRITE_GUARD_LIST_VERSION,
  WRITE_GUARD_RULE_PROTECTED_PATH,
} from '../constants.js';
import type { GuardList, GuardListOwner } from './guardList.js';
import { removeGuardList, writeGuardList } from './guardList.js';
import type { PathNormalizer } from './pathNormalization.js';
import { pathNormalizer } from './pathNormalization.js';
import type { GuardRequest, GuardVerdict } from './protocol.js';
import { parseGuardRequest } from './protocol.js';

/** 規則看得到的東西：只有記憶體中的資料。 */
export interface GuardRuleContext {
  agentId: number;
  protectedRoots: readonly string[];
  isWithin(target: string, root: string): boolean;
}

/** 對一個已知 standalone Agent 的請求做出 allow 或 deny（unknown-session 由 WriteGuard 決定）。 */
export type GuardRule = (
  request: GuardRequest,
  context: GuardRuleContext,
) => Exclude<GuardVerdict, { verdict: 'unknown-session' }>;

/** P1 的最小規則：任何路徑落在受保護根目錄之下就 deny，其餘 allow。 */
export const protectedRootsRule: GuardRule = (request, context) => {
  const hit = request.paths.find((p) =>
    context.protectedRoots.some((root) => context.isWithin(p, root)),
  );
  return hit === undefined
    ? { verdict: 'allow' }
    : { verdict: 'deny', rule: WRITE_GUARD_RULE_PROTECTED_PATH, path: hit };
};

/** session 註冊變更的來源（AgentRuntime.onSessionsChanged）。 */
export interface SessionChangeSource {
  onSessionsChanged(listener: () => void): () => void;
}

export interface WriteGuardDeps {
  store: AgentStateStore;
  /** 「PTY 仍由本伺服器持有」的判斷來源。 */
  ptyManager: { has(agentId: number): boolean };
  /** session id 在 /clear 時換掉的通知來源；沒有時只靠後備間隔。 */
  sessions?: SessionChangeSource;
  rule?: GuardRule;
  normalizer?: PathNormalizer;
  homeDir?: () => string;
}

export class WriteGuard {
  private readonly store: AgentStateStore;
  private readonly ptyManager: { has(agentId: number): boolean };
  private readonly sessions: SessionChangeSource | undefined;
  private readonly rule: GuardRule;
  private readonly normalizer: PathNormalizer;
  private readonly homeDir: () => string;

  private protectedRoots: string[] = [];
  private owner: GuardListOwner | null = null;
  private publishedHome: string | null = null;
  private lastWritten: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor(deps: WriteGuardDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.sessions = deps.sessions;
    this.rule = deps.rule ?? protectedRootsRule;
    this.normalizer = deps.normalizer ?? pathNormalizer;
    this.homeDir = deps.homeDir ?? (() => os.homedir());
  }

  /**
   * 設定受保護根目錄（P1 只有測試呼叫）。這裡做 realpath（寫清單時，不在裁決時）；
   * 不存在或無法解析的根目錄被略過。
   */
  setProtectedRoots(roots: readonly string[]): void {
    const normalized: string[] = [];
    for (const root of roots) {
      const resolved = this.normalizer.normalizeRoot(root);
      if (resolved !== null && !normalized.includes(resolved)) normalized.push(resolved);
    }
    this.protectedRoots = normalized;
    this.refresh();
  }

  getProtectedRoots(): string[] {
    return [...this.protectedRoots];
  }

  /** 已知 standalone Agent 的 session id（記憶體查詢）。 */
  knownSessions(): string[] {
    const sessions: string[] = [];
    for (const [id, agent] of this.store) {
      if (!this.ptyManager.has(id)) continue;
      if (agent.sessionId && !sessions.includes(agent.sessionId)) sessions.push(agent.sessionId);
    }
    return sessions.sort();
  }

  /**
   * 裁決一個請求。不合格的請求回 null（端點回 400）。只做記憶體查詢（F13）。
   */
  verdict(body: unknown): GuardVerdict | null {
    const request = parseGuardRequest(body);
    if (!request) return null;
    const agentId = this.knownAgentFor(request.session_id);
    if (agentId === undefined) return { verdict: 'unknown-session' };
    return this.rule(request, {
      agentId,
      protectedRoots: this.protectedRoots,
      isWithin: (target, root) => this.normalizer.isWithin(target, root),
    });
  }

  /** 開始發佈清單（伺服器 listen 之後呼叫，pid 與 port 才確定）。 */
  publish(owner: GuardListOwner): void {
    if (this.owner) this.unpublish();
    this.owner = { pid: owner.pid, port: owner.port };
    this.publishedHome = this.homeDir();
    this.lastWritten = null;

    const onChange = (): void => this.refresh();
    this.store.on('agentAdded', onChange);
    this.store.on('agentRemoved', onChange);
    this.store.on('agentsCleared', onChange);
    this.unsubscribers.push(() => {
      this.store.off('agentAdded', onChange);
      this.store.off('agentRemoved', onChange);
      this.store.off('agentsCleared', onChange);
    });
    if (this.sessions) this.unsubscribers.push(this.sessions.onSessionsChanged(onChange));

    this.refreshTimer = setInterval(onChange, WRITE_GUARD_LIST_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    this.refresh();
  }

  /** 停止發佈並刪除自己的清單（伺服器停止時）。 */
  unpublish(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.owner && this.publishedHome !== null) removeGuardList(this.publishedHome, this.owner);
    this.owner = null;
    this.publishedHome = null;
    this.lastWritten = null;
  }

  /** 重算清單，內容改變時才寫檔。尚未發佈時不做任何事。 */
  refresh(): void {
    if (!this.owner || this.publishedHome === null) return;
    const list: GuardList = {
      version: WRITE_GUARD_LIST_VERSION,
      pid: this.owner.pid,
      port: this.owner.port,
      protectedRoots: [...this.protectedRoots],
      knownSessions: this.knownSessions(),
    };
    const serialized = JSON.stringify(list);
    if (serialized === this.lastWritten) return;
    if (writeGuardList(this.publishedHome, list)) this.lastWritten = serialized;
  }

  private knownAgentFor(sessionId: string): number | undefined {
    for (const [id, agent] of this.store) {
      if (agent.sessionId === sessionId && this.ptyManager.has(id)) return id;
    }
    return undefined;
  }
}
