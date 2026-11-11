/**
 * 對每個 Agent 廣播 agentGuardStatus（P4，僅 standalone；內嵌伺服器不建立它）。
 *
 * 狀態由 computeGuardStatus 計算。檔案系統檢查（settings.json、hook 腳本）只在
 * 固定間隔與 hooks 狀態變更（refreshChain）時做，結果快取；其餘觸發（Agent 增減、
 * 工作空間／curator／session 變更、第一次裁決請求）只讀記憶體，所以第一次裁決
 * 請求的同步通知不會讓裁決路徑碰檔案系統（F13）。內容沒變不重送。
 */

import type { AgentStateStore } from '../agentStateStore.js';
import { GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS } from '../constants.js';
import type { GuardStatus, HookChainCheck } from './guardStatus.js';
import { computeGuardStatus, guardStatusMessage, NOT_STANDALONE_STATUS } from './guardStatus.js';
import type { KbState } from './kbState.js';
import type { PermissionRoles } from './permissionRoles.js';

type Broadcast = (message: Record<string, unknown>) => void;

export interface GuardStatusReporterDeps {
  store: AgentStateStore;
  /** 「PTY 仍由本伺服器持有」的判斷來源。 */
  ptyManager: { has(agentId: number): boolean };
  guard: {
    hasSeenVerdict(sessionId: string): boolean;
    onFirstVerdict(listener: (sessionId: string) => void): () => void;
    getKbState(): KbState;
  };
  curators: { curatorOf(workspaceId: string | undefined): number | null };
  /** 讀檔案系統的鏈檢查；只在間隔與 refreshChain 時呼叫。 */
  probeChain: () => HookChainCheck;
  broadcast: Broadcast;
  /** session 註冊變更（/clear 換 session id）的來源。 */
  sessions?: { onSessionsChanged(listener: () => void): () => void };
  intervalMs?: number;
}

export class GuardStatusReporter {
  private chain: HookChainCheck;
  private readonly lastSent = new Map<number, string>();
  private readonly unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: GuardStatusReporterDeps) {
    this.chain = deps.probeChain();
    const { store } = deps;
    const onChange = (): void => this.update();
    const onRemoved = (id: number): void => {
      this.lastSent.delete(id);
    };
    const onBroadcast = (message: Record<string, unknown>): void => {
      if (message.type === 'workspacesLoaded' || message.type === 'workspaceCuratorChanged') {
        this.update();
      }
    };
    for (const event of ['agentAdded', 'agentWorkspaceChanged'] as const) store.on(event, onChange);
    store.on('agentRemoved', onRemoved);
    const onCleared = (ids: number[]): void => ids.forEach(onRemoved);
    store.on('agentsCleared', onCleared);
    store.on('broadcast', onBroadcast);
    this.unsubscribers.push(() => {
      for (const event of ['agentAdded', 'agentWorkspaceChanged'] as const)
        store.off(event, onChange);
      store.off('agentRemoved', onRemoved);
      store.off('agentsCleared', onCleared);
      store.off('broadcast', onBroadcast);
    });
    this.unsubscribers.push(deps.guard.onFirstVerdict(onChange));
    if (deps.sessions) this.unsubscribers.push(deps.sessions.onSessionsChanged(onChange));
  }

  /** 固定間隔的鏈檢查開始（伺服器啟動後呼叫）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.refreshChain(),
      this.deps.intervalMs ?? GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /** 重做鏈檢查（讀檔案系統）並廣播有變的 Agent；hooks 狀態變更時呼叫。 */
  refreshChain(): void {
    this.chain = this.deps.probeChain();
    this.update();
  }

  /** 以快取的鏈檢查結果重算，只廣播內容有變的 Agent。只讀記憶體。 */
  update(): void {
    for (const [id] of this.deps.store) {
      const message = this.messageFor(id);
      const serialized = JSON.stringify(message);
      if (this.lastSent.get(id) === serialized) continue;
      this.lastSent.set(id, serialized);
      this.deps.broadcast(message);
    }
  }

  /** 握手：把每個既有 Agent 目前的狀態送給這一個連線（不影響去重記錄）。 */
  sendAll(send: Broadcast): void {
    for (const [id] of this.deps.store) send(this.messageFor(id));
  }

  /**
   * 寫入規則對此 Agent 是否生效（與 agentGuardStatus 的 active 同一個判準：hook 鏈完整
   * 且已收過此 session 的裁決請求）。只讀記憶體（快取的鏈檢查），任務派送用。
   */
  isGuardActive(id: number): boolean {
    return this.statusFor(id).active;
  }

  private messageFor(id: number): Record<string, unknown> {
    const agent = this.deps.store.get(id);
    const roles: PermissionRoles = agent?.permissionRoles ?? null;
    return guardStatusMessage(id, this.statusFor(id), roles);
  }

  private statusFor(id: number): GuardStatus {
    const agent = this.deps.store.get(id);
    if (!agent || agent.isExternal || !this.deps.ptyManager.has(id)) {
      return { ...NOT_STANDALONE_STATUS, reasons: [...NOT_STANDALONE_STATUS.reasons] };
    }
    const info = this.deps.guard.getKbState().agents.get(id);
    return computeGuardStatus({
      isStandaloneAgent: true,
      chain: this.chain,
      verdictSeen: !!agent.sessionId && this.deps.guard.hasSeenVerdict(agent.sessionId),
      workspaceHasRoot: info?.rulesActive ?? false,
      workspaceHasCurator: this.deps.curators.curatorOf(agent.workspaceId) !== null,
    });
  }
}
