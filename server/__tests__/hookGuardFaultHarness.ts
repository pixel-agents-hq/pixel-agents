/** hookGuardErrors 系列測試的故障注入輔助：每個 dep 都可以被設定成拋例外。 */

import { extractGuardFields } from '../src/providers/hook/claude/guard/fieldExtraction.js';
import type {
  HookGuardDeps,
  VerdictOutcome,
} from '../src/providers/hook/claude/guard/hookGuard.js';
import { runGuardedDelivery } from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import type { GuardList } from '../src/writeGuard/guardList.js';
import { pathNormalizer } from '../src/writeGuard/pathNormalization.js';

export const SESSION = 'known';
export const SECRET = 'BOOM-SECRET-internal-detail';
export const SERVER: ServerConfig = {
  port: 4400,
  pid: process.pid,
  token: 't',
  startedAt: 0,
  servesSpa: true,
  protocol: 1,
  standalone: { terminal: true, host: '127.0.0.1', allowedHosts: [] },
};
const boom = (): never => {
  throw new Error(SECRET);
};

export interface Faults {
  extract?: boolean;
  normalize?: boolean;
  readList?: boolean;
  request?: boolean;
  emit?: boolean;
  forward?: boolean;
  /** 伺服器不回答（預設回 allow）。 */
  unanswered?: boolean;
  /** 清單內容：undefined 為已知 session 且 protectedRoots 非空。 */
  list?: GuardList | null;
}

export function listOf(roots: string[], sessions: string[]): GuardList {
  return {
    version: 1,
    pid: SERVER.pid,
    port: SERVER.port,
    protectedRoots: roots,
    knownSessions: sessions,
  };
}

export async function deliver(tool: string, faults: Faults, session = SESSION) {
  const emitted: string[] = [];
  const logs: string[] = [];
  const deps: HookGuardDeps & { forward(): Promise<void>; emit(o: string): Promise<void> } = {
    extractFields: (payload) => (faults.extract ? boom() : extractGuardFields(payload)),
    normalizer: {
      normalizeTarget: (raw, cwd) =>
        faults.normalize ? boom() : pathNormalizer.normalizeTarget(raw, cwd),
      normalizeRoot: pathNormalizer.normalizeRoot,
      isWithin: (a, b) => (faults.normalize ? boom() : pathNormalizer.isWithin(a, b)),
    },
    readList: () =>
      faults.readList
        ? boom()
        : faults.list !== undefined
          ? faults.list
          : listOf(['/w/.note'], [SESSION]),
    requestVerdict: () =>
      faults.request
        ? boom()
        : Promise.resolve<VerdictOutcome>(
            faults.unanswered
              ? { kind: 'unanswered' }
              : { kind: 'verdict', verdict: { verdict: 'allow' } },
          ),
    now: () => Date.now(),
    homeDir: () => '/home/u',
    log: (line) => logs.push(line),
    forward: faults.forward ? boom : async () => {},
    emit: async (output) => {
      emitted.push(output);
      if (faults.emit) boom();
    },
  };
  const input =
    tool === 'Bash'
      ? { command: 'echo x > /tmp/out' }
      : tool === 'NotebookEdit'
        ? { notebook_path: '/tmp/n.ipynb' }
        : { file_path: '/tmp/a.txt', content: 'x' };
  await runGuardedDelivery(
    {
      hook_event_name: 'PreToolUse',
      session_id: session,
      cwd: '/tmp',
      tool_name: tool,
      tool_input: input,
    },
    [SERVER],
    deps,
  );
  return { emitted, logs };
}
