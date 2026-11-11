/**
 * hook 端的阻擋式裁決流程（P1）。
 *
 * 順序是規則的一部分（F2）：
 * 1. 本地判斷（不碰網路）：抽欄位、讀每台 standalone 伺服器的清單、正規化路徑、
 *    算出「伺服器沒回答時的後備決定」。只有清單同時列出該 session 的伺服器才會被問。
 * 2. 網路：向那些伺服器要裁決，與既有的事件轉發並行；總截止時間
 *    WRITE_GUARD_HOOK_DEADLINE_MS，明顯短於 hook 逾時。
 * 3. 合併（F4）：只採認得該 session 的伺服器的答案；任何一台 deny 即 deny；
 *    unknown-session 不算數；連不上／逾時／非 2xx／回應壞掉的伺服器，
 *    若本地判斷是受保護路徑則 fail-closed，否則放行。
 *    被詢問的一定是寫過清單的新版伺服器，所以它回非 2xx 是「伺服器異常」，
 *    不是「舊版不認得」：放行會讓受保護路徑在伺服器出錯時被寫入（與 Q1 矛盾）。
 *    舊版伺服器沒有清單，根本不會被詢問，因此照樣放行。
 *
 * 其餘一律放行：沒有清單、清單沒列這個 session、registry 沒有活著的 PID、
 * 不是 PreToolUse、不是要裁決的工具。
 *
 * P2：每個原始路徑產生作業系統語意與字面語意兩個候選（normalizeTargetCandidates），
 * 全部送給伺服器；寫入類工具抽不到或無法正規化路徑時帶 unresolved（F7）。
 *
 * P3：Bash 在本地解析（bashPlan.ts）：寫入目標、遞迴目標、字面路徑片段都正規化後送出，
 * 也用於本地 fail-closed；讀取類工具（Read、Glob、Grep）也送裁決（權限角色 R）。
 * 伺服器不可達時角色與 F17 不生效，只有 KB 區 fail-closed（P3 補充決定 6）。
 */

import * as http from 'http';
import * as os from 'os';

import {
  WRITE_GUARD_API_PATH,
  WRITE_GUARD_BASH_TOOL,
  WRITE_GUARD_HOOK_DEADLINE_MS,
  WRITE_GUARD_MAX_REQUEST_BYTES,
  WRITE_GUARD_MAX_RESPONSE_BYTES,
  WRITE_GUARD_RULE_UNREACHABLE,
} from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { renderDenyMessage } from '../../../../writeGuard/denyMessage.js';
import { renderGuardDenyMessage } from '../../../../writeGuard/guardDenyMessage.js';
import type { GuardList } from '../../../../writeGuard/guardList.js';
import { readGuardList } from '../../../../writeGuard/guardList.js';
import type { PathNormalizer } from '../../../../writeGuard/pathNormalization.js';
import {
  normalizeTargetCandidates,
  pathNormalizer,
} from '../../../../writeGuard/pathNormalization.js';
import type { GuardRequest, GuardVerdict } from '../../../../writeGuard/protocol.js';
import { parseGuardVerdict } from '../../../../writeGuard/protocol.js';
import { bashHitsRoot, planBash } from './bashPlan.js';
import { formatDenyOutput } from './decisionOutput.js';
import type { FieldExtractor } from './fieldExtraction.js';
import { extractGuardFields, isFileWriteTool } from './fieldExtraction.js';
import { guardErrorDecision, readListSafely } from './guardErrorFallback.js';

export type GuardDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** 單一伺服器的回覆結果。 */
export type VerdictOutcome =
  /** 2xx 且內容合格。 */
  | { kind: 'verdict'; verdict: GuardVerdict }
  /** 非 2xx（500、401、403、404 等）：與 unanswered 同樣處理（受保護路徑 fail-closed）；
   *  分開列出只為了診斷紀錄。 */
  | { kind: 'rejected' }
  /** 連不上、逾時、超過截止時間、2xx 但內容壞掉、請求過大未送出。 */
  | { kind: 'unanswered' };

export interface HookGuardDeps {
  extractFields: FieldExtractor;
  normalizer: PathNormalizer;
  readList(server: ServerConfig): GuardList | null;
  requestVerdict(server: ServerConfig, body: string, deadlineAt: number): Promise<VerdictOutcome>;
  now(): number;
  /** P3：Bash 的 `~` 展開用；預設 os.homedir()。 */
  homeDir?(): string;
  log(line: string): void;
}

interface GuardTarget {
  server: ServerConfig;
  /** 本地判斷：這次寫入是否落在該伺服器的受保護根目錄之下。 */
  protectedHit: boolean;
}

export interface GuardPlan {
  request: GuardRequest;
  body: string;
  targets: GuardTarget[];
  /** 這次請求自己送出的全部路徑（拒絕訊息只放這些路徑，F16）。 */
  ownPaths: string[];
  /** P3：這次 Bash 指令自己的指令名稱片段（拒絕訊息只放這些片段，F16）。 */
  ownFragments: string[];
  /** 伺服器都沒回答時的決定；只有受保護路徑命中才是 deny。 */
  fallback: GuardDecision;
}

const ALLOW: GuardDecision = { decision: 'allow' };

function isStandaloneServer(server: ServerTarget | ServerConfig): server is ServerConfig {
  return (server as ServerConfig).standalone !== undefined;
}

/**
 * 本地判斷（同步、不碰網路）。回 null 表示這次呼叫不需要裁決（直接放行）。
 * @param servers 只能是 registry 中 PID 仍存活的項目；legacy server.json 不算
 *   （registry 沒有活著的 PID 時規則視為未生效，F3）。
 */
export function planGuard(
  payload: Record<string, unknown>,
  servers: readonly (ServerTarget | ServerConfig)[],
  deps: Pick<HookGuardDeps, 'extractFields' | 'normalizer' | 'readList' | 'homeDir'> &
    Partial<Pick<HookGuardDeps, 'log'>>,
): GuardPlan | null {
  const fields = deps.extractFields(payload);
  if (!fields) return null;

  const lists: { server: ServerConfig; list: GuardList }[] = [];
  for (const server of servers) {
    // 內嵌（VS Code）伺服器沒有清單，也不會被問（分流）。
    if (!isStandaloneServer(server)) continue;
    // 清單讀取拋例外：無法確認 session 是否已知，這台伺服器不採計（放行，Q1、F5）。
    const list = readListSafely(deps, server);
    if (list && list.knownSessions.includes(fields.sessionId)) lists.push({ server, list });
  }
  if (lists.length === 0) return null;

  // F7：寫入類工具抽不到路徑、或任何路徑無法正規化，都是明確的「無法判斷」，
  // 不能被默默丟掉（P1 的版本會丟掉它而放行）。
  const paths: string[] = [];
  let unresolved = isFileWriteTool(fields.toolName) && fields.pathFields.length === 0;
  for (const raw of fields.pathFields) {
    const candidates = normalizeTargetCandidates(deps.normalizer, raw, fields.cwd);
    if (candidates === null) {
      unresolved = true;
      continue;
    }
    for (const candidate of candidates) {
      if (!paths.includes(candidate)) paths.push(candidate);
    }
  }

  // P3：Bash 在本地解析並正規化寫入目標（不碰網路），fail-closed 才能涵蓋 Bash。
  const bash =
    fields.toolName === WRITE_GUARD_BASH_TOOL
      ? planBash(fields.command, fields.cwd, deps.homeDir?.() ?? os.homedir(), deps.normalizer)
      : null;
  if (bash) {
    for (const p of bash.direct) if (!paths.includes(p)) paths.push(p);
    unresolved ||= bash.unresolved;
  }
  const ownPaths = bash ? [...paths, ...bash.recursive, ...bash.mentioned] : paths;

  let firstHit: string | undefined;
  let unresolvedHit = false;
  const targets: GuardTarget[] = lists.map(({ server, list }) => {
    const hit = bash
      ? bashHitsRoot({ ...bash, direct: paths }, list.protectedRoots, deps.normalizer)
      : paths.find((p) => list.protectedRoots.some((root) => deps.normalizer.isWithin(p, root)));
    if (hit !== undefined) firstHit ??= hit;
    // 無法判斷的寫入：該伺服器有任何受保護根目錄（KB 規則啟用中）就視為命中。
    const unresolvedProtected = unresolved && list.protectedRoots.length > 0;
    if (unresolvedProtected) unresolvedHit = true;
    return { server, protectedHit: hit !== undefined || unresolvedProtected };
  });

  const request: GuardRequest = {
    tool_name: fields.toolName,
    session_id: fields.sessionId,
    cwd: fields.cwd,
    paths,
    ...(fields.command !== undefined ? { command: fields.command } : {}),
    ...(unresolved ? { unresolved: true as const } : {}),
    ...(bash && bash.recursive.length > 0 ? { recursive_paths: bash.recursive } : {}),
    ...(bash && bash.mentioned.length > 0 ? { mentioned_paths: bash.mentioned } : {}),
  };
  return {
    request,
    body: requestBody(request, bash?.ops ?? null),
    targets,
    ownPaths,
    ownFragments: bash?.fragments ?? [],
    fallback:
      firstHit === undefined && !unresolvedHit
        ? ALLOW
        : {
            decision: 'deny',
            reason: renderDenyMessage(WRITE_GUARD_RULE_UNREACHABLE, firstHit, ownPaths),
          },
  };
}

/**
 * 請求體。超過上限時（例如很長的 Bash 指令）改送最小請求：不帶 command 與路徑、
 * 標記 unresolved（KB 規則啟用時 deny），並帶 hook 端解析出的操作類別，讓伺服器
 * 仍能判斷權限角色；這樣指令再長也不會因為請求送不出去而跳過角色檢查。
 */
function requestBody(request: GuardRequest, ops: GuardRequest['bash_ops'] | null): string {
  const full = JSON.stringify(request);
  if (Buffer.byteLength(full) <= WRITE_GUARD_MAX_REQUEST_BYTES) return full;
  const minimal: GuardRequest = {
    tool_name: request.tool_name,
    session_id: request.session_id,
    cwd: request.cwd,
    paths: [],
    unresolved: true,
    ...(ops !== null ? { bash_ops: ops } : {}),
  };
  return JSON.stringify(minimal);
}

/** 等到 promise 或截止時間，先到者為準；截止視為沒有回答。 */
function untilDeadline(
  promise: Promise<VerdictOutcome>,
  deadlineAt: number,
  now: () => number,
): Promise<VerdictOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ kind: 'unanswered' }),
      Math.max(0, deadlineAt - now()),
    );
    promise.then(
      (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: 'unanswered' });
      },
    );
  });
}

/** 網路階段與合併（F4）。 */
export async function resolveGuard(
  plan: GuardPlan,
  deps: Pick<HookGuardDeps, 'requestVerdict' | 'now' | 'log'>,
  deadlineAt: number,
): Promise<GuardDecision> {
  const tooLarge = Buffer.byteLength(plan.body) > WRITE_GUARD_MAX_REQUEST_BYTES;
  if (tooLarge) deps.log('guard-skip reason=request-too-large');
  const outcomes = await Promise.all(
    plan.targets.map((target) =>
      tooLarge
        ? Promise.resolve<VerdictOutcome>({ kind: 'unanswered' })
        : untilDeadline(
            deps.requestVerdict(target.server, plan.body, deadlineAt),
            deadlineAt,
            deps.now,
          ),
    ),
  );

  let serverDeny: { rule: string; path?: string; fragment?: string } | undefined;
  let failClosed = false;
  outcomes.forEach((outcome, i) => {
    const target = plan.targets[i];
    deps.log(
      `guard-outcome port=${target.server.port} kind=${outcome.kind}` +
        (outcome.kind === 'verdict' ? ` verdict=${outcome.verdict.verdict}` : ''),
    );
    if (outcome.kind === 'verdict' && outcome.verdict.verdict === 'deny') {
      serverDeny ??= outcome.verdict;
    } else if (
      (outcome.kind === 'unanswered' || outcome.kind === 'rejected') &&
      target.protectedHit
    ) {
      failClosed = true;
    }
  });

  if (serverDeny) {
    return {
      decision: 'deny',
      reason: renderGuardDenyMessage(
        serverDeny.rule,
        serverDeny.path,
        serverDeny.fragment,
        plan.ownPaths,
        plan.ownFragments,
      ),
    };
  }
  return failClosed ? plan.fallback : ALLOW;
}

/**
 * hook 的完整投遞流程：本地判斷 -> 事件轉發與裁決並行 -> 需要時輸出拒絕。
 * forward 是既有的事件轉發（行為不變）；emit 寫 stdout。
 */
export async function runGuardedDelivery(
  payload: Record<string, unknown>,
  guardServers: readonly (ServerTarget | ServerConfig)[],
  deps: HookGuardDeps & { forward(): Promise<void>; emit(output: string): Promise<void> },
): Promise<void> {
  const log = (line: string): void => {
    try {
      deps.log(line);
    } catch {
      // 記錄失敗不影響決定
    }
  };
  // 裁決流程的任何例外都走同一個 fail-closed 判斷（guardErrorFallback.ts），不再因為
  // 例外而放行；記錄只寫 stage，不寫例外內容。
  const onError = (stage: string): GuardDecision => {
    log(`guard-error stage=${stage}`);
    return guardErrorDecision(payload, guardServers, deps);
  };

  let plan: GuardPlan | null = null;
  let decision: GuardDecision = ALLOW;
  try {
    plan = planGuard(payload, guardServers, deps);
  } catch {
    decision = onError('plan');
  }

  // 既有的事件轉發；同步拋出時不能跳過下面的拒絕輸出（非同步的失敗照舊往外傳）。
  let forwarding: Promise<void>;
  try {
    forwarding = deps.forward();
  } catch {
    log('guard-error stage=forward');
    forwarding = Promise.resolve();
  }

  if (plan) {
    try {
      const deadlineAt = deps.now() + WRITE_GUARD_HOOK_DEADLINE_MS;
      decision = await resolveGuard(plan, deps, deadlineAt);
    } catch {
      decision = plan.fallback.decision === 'deny' ? plan.fallback : onError('resolve');
    }
  }
  if (decision.decision === 'deny') {
    log('guard-decision deny');
    try {
      // 唯一的輸出點：最多一則 deny JSON，內容只有固定範本與該 Agent 自己的路徑。
      await deps.emit(formatDenyOutput(decision.reason));
    } catch {
      log('guard-error stage=emit');
    }
  }

  await forwarding;
}

// ── 正式環境的 deps ────────────────────────────────────────

/** 向一台伺服器要裁決。所有失敗都歸類，不丟例外。 */
function httpRequestVerdict(
  server: ServerConfig,
  body: string,
  deadlineAt: number,
): Promise<VerdictOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: VerdictOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const remaining = Math.max(1, deadlineAt - Date.now());
    let req: http.ClientRequest | undefined;
    const timer = setTimeout(() => {
      req?.destroy();
      settle({ kind: 'unanswered' });
    }, remaining);
    try {
      req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: WRITE_GUARD_API_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: remaining,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            res.resume();
            settle({ kind: 'rejected' });
            return;
          }
          let text = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.length > WRITE_GUARD_MAX_RESPONSE_BYTES) {
              req?.destroy();
              settle({ kind: 'unanswered' });
            }
          });
          res.on('end', () => {
            let verdict: GuardVerdict | null = null;
            try {
              verdict = parseGuardVerdict(JSON.parse(text) as unknown);
            } catch {
              verdict = null;
            }
            settle(verdict ? { kind: 'verdict', verdict } : { kind: 'unanswered' });
          });
          res.on('error', () => settle({ kind: 'unanswered' }));
        },
      );
      const pending = req;
      pending.on('error', () => settle({ kind: 'unanswered' }));
      pending.on('timeout', () => {
        pending.destroy();
        settle({ kind: 'unanswered' });
      });
      pending.end(body);
    } catch {
      settle({ kind: 'unanswered' });
    }
  });
}

/** 正式環境的 deps（hook 腳本用）。 */
export function defaultHookGuardDeps(log: (line: string) => void): HookGuardDeps {
  const homeDir = os.homedir();
  return {
    extractFields: extractGuardFields,
    normalizer: pathNormalizer,
    readList: (server) => readGuardList(homeDir, server),
    requestVerdict: httpRequestVerdict,
    now: () => Date.now(),
    log,
  };
}
