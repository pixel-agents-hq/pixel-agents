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
 * P2：受保護區的正式來源是工作空間設定（根目錄）與已知 Agent 啟動時記錄的
 * Directory realpath 與 roleId（kbState.ts）。快照在事件（Agent 加入、移除、清空、
 * 換工作空間、workspacesLoaded 廣播、session 變更）與後備間隔時重算；裁決只讀快照。
 * 規則是 guardRules.ts 的 guardRule（P3：kbRule 加上 Bash 解析與權限角色）。setProtectedRoots
 * 保留為額外受保護根目錄（測試用；正式環境不呼叫）。
 */

import * as os from 'os';

import type { Workspace } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { WRITE_GUARD_LIST_REFRESH_INTERVAL_MS, WRITE_GUARD_LIST_VERSION } from '../constants.js';
import type { AgentState } from '../types.js';
import { listWorkspaces } from '../workspaces.js';
import type { GuardList, GuardListOwner } from './guardList.js';
import { removeGuardList, writeGuardList } from './guardList.js';
import { guardRule } from './guardRules.js';
import type { KbRuleContext, RuleVerdict } from './kbRules.js';
import type { KbState } from './kbState.js';
import { computeKbState, kbProtectedRoots } from './kbState.js';
import type { PathNormalizer } from './pathNormalization.js';
import { pathNormalizer } from './pathNormalization.js';
import type { GuardRequest, GuardVerdict } from './protocol.js';
import { parseGuardRequest } from './protocol.js';

/** 對一個已知 standalone Agent 的請求做出 allow 或 deny（unknown-session 由 WriteGuard 決定）。
 *  context 只有記憶體中的資料（F13）。 */
export type GuardRule = (request: GuardRequest, context: KbRuleContext) => RuleVerdict;

/** curator 的查詢來源（CuratorTable）。 */
export interface CuratorLookup {
  curatorOf(workspaceId: string | undefined): number | null;
}

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
  /** 工作空間 KB 的 curator；沒有時每個工作空間 KB 區都視為「尚未任命」。 */
  curators?: CuratorLookup;
  /** 工作空間清單（含根目錄）；預設讀 ~/.pixel-agents/workspaces.json。重算時才呼叫。 */
  workspaces?: () => Workspace[];
}

export class WriteGuard {
  private readonly store: AgentStateStore;
  private readonly ptyManager: { has(agentId: number): boolean };
  private readonly sessions: SessionChangeSource | undefined;
  private readonly rule: GuardRule;
  private readonly normalizer: PathNormalizer;
  private readonly homeDir: () => string;
  private readonly curators: CuratorLookup | undefined;
  private readonly workspaces: () => Workspace[];

  /** 額外受保護根目錄（setProtectedRoots）。 */
  private extraRoots: string[] = [];
  private kbState: KbState;
  private readonly storeUnsubscribers: (() => void)[] = [];
  private owner: GuardListOwner | null = null;
  private publishedHome: string | null = null;
  private lastWritten: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** P4：已收過裁決請求的 session id（只放記憶體、不持久化）。session id 換掉（/clear）
   *  後新的 id 不在其中，即視為未見。 */
  private readonly seenSessions = new Set<string>();
  private readonly firstVerdictListeners = new Set<(sessionId: string) => void>();

  constructor(deps: WriteGuardDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.sessions = deps.sessions;
    this.rule = deps.rule ?? guardRule;
    this.normalizer = deps.normalizer ?? pathNormalizer;
    this.homeDir = deps.homeDir ?? (() => os.homedir());
    this.curators = deps.curators;
    this.workspaces = deps.workspaces ?? listWorkspaces;
    this.kbState = this.computeState();

    // 規則快照隨 Agent 與工作空間設定更新（不論是否發佈清單）；發佈時一併寫清單。
    const onChange = (): void => this.update();
    const onBroadcast = (message: Record<string, unknown>): void => {
      if (message.type === 'workspacesLoaded') this.update();
    };
    const events = [
      'agentAdded',
      'agentRemoved',
      'agentsCleared',
      'agentWorkspaceChanged',
    ] as const;
    for (const event of events) this.store.on(event, onChange);
    this.store.on('broadcast', onBroadcast);
    this.storeUnsubscribers.push(() => {
      for (const event of events) this.store.off(event, onChange);
      this.store.off('broadcast', onBroadcast);
    });
    if (this.sessions) this.storeUnsubscribers.push(this.sessions.onSessionsChanged(onChange));
  }

  /** 停止跟隨 store（測試與關閉時）；也停止發佈。 */
  dispose(): void {
    this.unpublish();
    for (const unsubscribe of this.storeUnsubscribers.splice(0)) unsubscribe();
  }

  /** 重算規則快照並（發佈中時）更新清單。此處可碰檔案系統；裁決不會呼叫它。 */
  update(): void {
    try {
      this.kbState = this.computeState();
    } catch (err) {
      console.error(`[Pixel Agents] Write guard: failed to recompute KB rules: ${String(err)}`);
    }
    this.pruneSeenSessions();
    this.refresh();
  }

  private computeState(): KbState {
    const knownAgents: [number, AgentState][] = [];
    for (const [id, agent] of this.store) {
      if (this.ptyManager.has(id)) knownAgents.push([id, agent]);
    }
    return computeKbState({
      workspaces: this.workspaces(),
      knownAgents,
      homeDir: this.homeDir(),
      normalizer: this.normalizer,
    });
  }

  /** 目前的規則快照（測試與診斷用）。 */
  getKbState(): KbState {
    return this.kbState;
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
    this.extraRoots = normalized;
    this.refresh();
  }

  /** hook 本地 fail-closed 用的受保護根目錄：額外根目錄加上兩種 KB 區。 */
  getProtectedRoots(): string[] {
    const roots = [...this.extraRoots];
    for (const root of kbProtectedRoots(this.kbState)) {
      if (!roots.includes(root)) roots.push(root);
    }
    return roots;
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
    this.recordVerdictRequest(request.session_id);
    const curators = this.curators;
    return this.rule(request, {
      agentId,
      extraRoots: this.extraRoots,
      kb: this.kbState,
      curatorOf: (key) => curators?.curatorOf(key) ?? null,
      normalizer: this.normalizer,
    });
  }

  /** 伺服器是否已收過此 session 的裁決請求（hook 鏈確實在運作的證據）。 */
  hasSeenVerdict(sessionId: string): boolean {
    return this.seenSessions.has(sessionId);
  }

  /** 第一次收到某 session 的裁決請求時通知（同步呼叫，監聽者不得碰檔案系統）。 */
  onFirstVerdict(listener: (sessionId: string) => void): () => void {
    this.firstVerdictListeners.add(listener);
    return () => this.firstVerdictListeners.delete(listener);
  }

  private recordVerdictRequest(sessionId: string): void {
    if (this.seenSessions.has(sessionId)) return;
    this.seenSessions.add(sessionId);
    for (const listener of [...this.firstVerdictListeners]) listener(sessionId);
  }

  /** 只保留仍是已知 Agent 目前 session 的記錄（換掉的 session id 與已移除的 Agent 丟棄）。 */
  private pruneSeenSessions(): void {
    const known = new Set(this.knownSessions());
    for (const sessionId of [...this.seenSessions]) {
      if (!known.has(sessionId)) this.seenSessions.delete(sessionId);
    }
  }

  /** 開始發佈清單（伺服器 listen 之後呼叫，pid 與 port 才確定）。 */
  publish(owner: GuardListOwner): void {
    if (this.owner) this.unpublish();
    this.owner = { pid: owner.pid, port: owner.port };
    this.publishedHome = this.homeDir();
    this.lastWritten = null;

    // 事件已在建構時訂閱（update 會在發佈中時寫清單）；這裡只加後備間隔。
    // 間隔也重算規則快照，補上事件看不到的變更（例如 .note 之後才被換成 symlink）。
    this.refreshTimer = setInterval(() => this.update(), WRITE_GUARD_LIST_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    this.update();
  }

  /** 停止發佈並刪除自己的清單（伺服器停止時）。 */
  unpublish(): void {
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
      protectedRoots: this.getProtectedRoots(),
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
