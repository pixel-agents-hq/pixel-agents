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
 * 不是 PreToolUse、不是 P1 處理的工具。
 */

import * as http from 'http';
import * as os from 'os';

import {
  WRITE_GUARD_API_PATH,
  WRITE_GUARD_HOOK_DEADLINE_MS,
  WRITE_GUARD_MAX_REQUEST_BYTES,
  WRITE_GUARD_MAX_RESPONSE_BYTES,
  WRITE_GUARD_RULE_UNREACHABLE,
} from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { renderDenyMessage } from '../../../../writeGuard/denyMessage.js';
import type { GuardList } from '../../../../writeGuard/guardList.js';
import { readGuardList } from '../../../../writeGuard/guardList.js';
import type { PathNormalizer } from '../../../../writeGuard/pathNormalization.js';
import { pathNormalizer } from '../../../../writeGuard/pathNormalization.js';
import type { GuardRequest, GuardVerdict } from '../../../../writeGuard/protocol.js';
import { parseGuardVerdict } from '../../../../writeGuard/protocol.js';
import { formatDenyOutput } from './decisionOutput.js';
import type { FieldExtractor } from './fieldExtraction.js';
import { extractGuardFields } from './fieldExtraction.js';

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
  deps: Pick<HookGuardDeps, 'extractFields' | 'normalizer' | 'readList'>,
): GuardPlan | null {
  const fields = deps.extractFields(payload);
  if (!fields) return null;

  const lists: { server: ServerConfig; list: GuardList }[] = [];
  for (const server of servers) {
    // 內嵌（VS Code）伺服器沒有清單，也不會被問（分流）。
    if (!isStandaloneServer(server)) continue;
    const list = deps.readList(server);
    if (list && list.knownSessions.includes(fields.sessionId)) lists.push({ server, list });
  }
  if (lists.length === 0) return null;

  const paths: string[] = [];
  for (const raw of fields.pathFields) {
    const normalized = deps.normalizer.normalizeTarget(raw, fields.cwd);
    if (normalized !== null && !paths.includes(normalized)) paths.push(normalized);
  }

  let firstHit: string | undefined;
  const targets: GuardTarget[] = lists.map(({ server, list }) => {
    const hit = paths.find((p) =>
      list.protectedRoots.some((root) => deps.normalizer.isWithin(p, root)),
    );
    if (hit !== undefined) firstHit ??= hit;
    return { server, protectedHit: hit !== undefined };
  });

  const request: GuardRequest = {
    tool_name: fields.toolName,
    session_id: fields.sessionId,
    cwd: fields.cwd,
    paths,
    ...(fields.command !== undefined ? { command: fields.command } : {}),
  };
  return {
    request,
    body: JSON.stringify(request),
    targets,
    fallback:
      firstHit === undefined
        ? ALLOW
        : {
            decision: 'deny',
            reason: renderDenyMessage(WRITE_GUARD_RULE_UNREACHABLE, firstHit, paths),
          },
  };
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

  let serverDeny: { rule: string; path?: string } | undefined;
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
      reason: renderDenyMessage(serverDeny.rule, serverDeny.path, plan.request.paths),
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
  let plan: GuardPlan | null = null;
  try {
    plan = planGuard(payload, guardServers, deps);
  } catch (err) {
    deps.log(`guard-error stage=plan err=${err instanceof Error ? err.message : String(err)}`);
  }

  const forwarding = deps.forward();

  if (plan) {
    const deadlineAt = deps.now() + WRITE_GUARD_HOOK_DEADLINE_MS;
    let decision: GuardDecision;
    try {
      decision = await resolveGuard(plan, deps, deadlineAt);
    } catch (err) {
      deps.log(`guard-error stage=resolve err=${err instanceof Error ? err.message : String(err)}`);
      decision = plan.fallback;
    }
    if (decision.decision === 'deny') {
      deps.log('guard-decision deny');
      await deps.emit(formatDenyOutput(decision.reason));
    }
  }

  await forwarding;
}

// ── 正式環境的 deps ────────────────────────────────────────

/** 向一台伺服器要裁決。所有失敗都歸類，不丟例外。 */
export function httpRequestVerdict(
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
