import { extractGuardFields } from '../src/providers/hook/claude/guard/fieldExtraction.js';
import type { GuardPlan } from '../src/providers/hook/claude/guard/hookGuard.js';
import { planGuard, resolveGuard } from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import { pathNormalizer } from '../src/writeGuard/pathNormalization.js';
import type { PermissionRoles } from '../src/writeGuard/permissionRoles.js';
import type { GuardVerdict } from '../src/writeGuard/protocol.js';
import { WriteGuard } from '../src/writeGuard/writeGuard.js';
import type { KbHarness } from './curatorHarness.js';

/**
 * P3 的整合探針：PreToolUse payload 走真的 hook 端欄位抽取、Bash 解析與路徑正規化
 * （planGuard），請求體交給真的 WriteGuard.verdict（伺服器端再解析一次）。
 * 不呼叫真實 claude；HOME 是 KbHarness 的臨時目錄。
 */

export const PROBE_SERVER: ServerConfig = {
  port: 4200,
  pid: process.pid,
  token: 't',
  startedAt: 0,
  servesSpa: true,
  protocol: 1,
  standalone: { terminal: true, host: '127.0.0.1' },
};

export class BashGuardProbe {
  readonly guard: WriteGuard;

  constructor(private readonly h: KbHarness) {
    this.guard = new WriteGuard({
      store: h.store,
      ptyManager: h.manager,
      sessions: h.runtime,
      curators: h.curators,
    });
  }

  /** 啟動一個 PTY Agent；permissionRoles 不帶時沿用工作空間預設。 */
  launch(directoryPath: string, permissionRoles?: PermissionRoles): number {
    const { id } = this.h.launch({ directoryPath, permissionRoles });
    if (id === null) throw new Error('launch failed');
    return id;
  }

  /** hook 端的本地判斷（含 Bash 解析）；cwd 預設為 Agent Directory。 */
  plan(agentId: number, tool: string, input: Record<string, unknown>, cwd?: string): GuardPlan {
    const agent = this.h.store.get(agentId);
    if (!agent) throw new Error(`no agent ${agentId}`);
    const plan = planGuard(
      {
        hook_event_name: 'PreToolUse',
        session_id: agent.sessionId,
        cwd: cwd ?? agent.directoryRealPath ?? '',
        tool_name: tool,
        tool_input: input,
      },
      [PROBE_SERVER],
      {
        extractFields: extractGuardFields,
        normalizer: pathNormalizer,
        homeDir: () => this.h.tempHome,
        readList: () => ({
          version: 1,
          pid: PROBE_SERVER.pid,
          port: PROBE_SERVER.port,
          protectedRoots: this.guard.getProtectedRoots(),
          knownSessions: [agent.sessionId],
        }),
      },
    );
    if (!plan) throw new Error('no plan');
    return plan;
  }

  /** 伺服器對這次呼叫的裁決。 */
  ask(agentId: number, tool: string, input: Record<string, unknown>, cwd?: string): GuardVerdict {
    const verdict = this.guard.verdict(JSON.parse(this.plan(agentId, tool, input, cwd).body));
    if (!verdict) throw new Error('malformed request');
    return verdict;
  }

  bash(agentId: number, command: string, cwd?: string): GuardVerdict {
    return this.ask(agentId, 'Bash', { command }, cwd);
  }

  /** hook 收到伺服器裁決後輸出給 Claude Code 的拒絕理由；放行時為 null。 */
  async reason(agentId: number, command: string): Promise<string | null> {
    const plan = this.plan(agentId, 'Bash', { command });
    const verdict = this.guard.verdict(JSON.parse(plan.body));
    if (!verdict) throw new Error('malformed request');
    const decision = await resolveGuard(
      plan,
      {
        requestVerdict: () => Promise.resolve({ kind: 'verdict', verdict }),
        now: () => Date.now(),
        log: () => {},
      },
      Date.now() + 1000,
    );
    return decision.decision === 'deny' ? decision.reason : null;
  }

  dispose(): void {
    this.guard.dispose();
  }
}
