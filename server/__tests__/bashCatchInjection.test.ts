/**
 * P3 第二次驗證 P3(b)：analyzeBash、planBash、bashRule 三處 catch 都有測試觸發。以 module mock
 * 讓內部步驟（parseBash、resolveBashPaths、lexicalBashPaths）拋例外，正式 API 不加任何鉤子。
 * 任何一處 catch 若改成放行（ops 為空、unresolved 為 false、回 allow），這裡會失敗。
 */

import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ parse: false, resolve: false, lexical: false }));

vi.mock('../src/writeGuard/bashParser.js', async () => {
  const actual = await vi.importActual<typeof import('../src/writeGuard/bashParser.js')>(
    '../src/writeGuard/bashParser.js',
  );
  return {
    ...actual,
    parseBash: (...args: Parameters<typeof actual.parseBash>) => {
      if (faults.parse) throw new Error('injected parse failure');
      return actual.parseBash(...args);
    },
  };
});

vi.mock('../src/writeGuard/bashPaths.js', async () => {
  const actual = await vi.importActual<typeof import('../src/writeGuard/bashPaths.js')>(
    '../src/writeGuard/bashPaths.js',
  );
  return {
    ...actual,
    resolveBashPaths: (...args: Parameters<typeof actual.resolveBashPaths>) => {
      if (faults.resolve) throw new Error('injected resolve failure');
      return actual.resolveBashPaths(...args);
    },
    lexicalBashPaths: (...args: Parameters<typeof actual.lexicalBashPaths>) => {
      if (faults.lexical) throw new Error('injected lexical failure');
      return actual.lexicalBashPaths(...args);
    },
  };
});

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { WRITE_GUARD_RULE_BASH_UNRESOLVED, WRITE_GUARD_RULE_ROLE_DELETE } =
  await import('../src/constants.js');
const { planBash } = await import('../src/providers/hook/claude/guard/bashPlan.js');
const { analyzeBash, UNPARSEABLE_BASH } = await import('../src/writeGuard/bashAnalysis.js');
const { pathNormalizer } = await import('../src/writeGuard/pathNormalization.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');

beforeEach(() => {
  faults.parse = false;
  faults.resolve = false;
  faults.lexical = false;
});

describe('analyzeBash catch', () => {
  it('an internal failure is unparseable: every class needed, targets unresolved', () => {
    faults.parse = true;
    const result = analyzeBash('ls');
    expect(result).toBe(UNPARSEABLE_BASH);
    expect(result.ops).toEqual(['read', 'edit', 'delete']);
    expect(result.truncated).toBe(true);
  });
});

describe('planBash catch', () => {
  it('a failure while resolving paths gives an unresolved plan needing every class', () => {
    faults.resolve = true;
    const plan = planBash('touch /tmp/a', '/tmp', '/home/u', pathNormalizer);
    expect(plan.unresolved).toBe(true);
    expect(plan.ops).toEqual(['read', 'edit', 'delete']);
  });
});

describe('bashRule catch', () => {
  function guardWith(rootPath: string | undefined, roles: ('R' | 'E' | 'D')[] | null) {
    const store = new AgentStateStore();
    const guard = new WriteGuard({
      store,
      ptyManager: { has: () => true },
      homeDir: () => '/home/u',
      workspaces: () => [
        { id: 'default', name: 'Default', directoryPaths: [], ...(rootPath ? { rootPath } : {}) },
      ],
    });
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: '/p',
        jsonlFile: path.join('/p', 's.jsonl'),
        isExternal: false,
        directoryRealPath: '/w/dir',
        permissionRoles: roles,
      }),
    );
    const ask = () =>
      guard.verdict({ tool_name: 'Bash', session_id: 's', cwd: '/w', paths: [], command: 'ls' });
    return { ask, dispose: () => (guard.dispose(), store.dispose()) };
  }

  it('KB rules on: denied as unresolved', () => {
    faults.lexical = true;
    const g = guardWith('/w', null);
    expect(g.ask()).toEqual({ verdict: 'deny', rule: WRITE_GUARD_RULE_BASH_UNRESOLVED });
    g.dispose();
  });

  it('KB rules off: every role is needed (R+E is denied, no roles is allowed)', () => {
    faults.lexical = true;
    const limited = guardWith(undefined, ['R', 'E']);
    expect(limited.ask()).toEqual({ verdict: 'deny', rule: WRITE_GUARD_RULE_ROLE_DELETE });
    limited.dispose();
    const open = guardWith(undefined, null);
    expect(open.ask()).toEqual({ verdict: 'allow' });
    open.dispose();
  });
});
