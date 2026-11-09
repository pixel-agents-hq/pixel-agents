/**
 * P4 的 F13：第一次裁決請求會同步通知狀態回報，但整條路徑（裁決加狀態重算與廣播）
 * 不做任何檔案系統呼叫；鏈檢查（讀檔案系統）只發生在固定間隔與 refreshChain。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsCounter = { on: false, calls: [] as string[] };
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const names = [
    'readFileSync',
    'writeFileSync',
    'realpathSync',
    'statSync',
    'lstatSync',
    'readlinkSync',
    'existsSync',
    'readdirSync',
    'openSync',
    'readSync',
    'accessSync',
  ] as const;
  const overrides = Object.fromEntries(
    names.map((name) => {
      const original = actual[name] as unknown as (...args: unknown[]) => unknown;
      return [
        name,
        (...args: unknown[]) => {
          if (fsCounter.on) fsCounter.calls.push(name);
          return original(...args);
        },
      ];
    }),
  );
  const realpathSync = Object.assign(overrides.realpathSync as typeof actual.realpathSync, {
    native: actual.realpathSync.native,
  });
  return {
    ...actual,
    ...overrides,
    realpathSync,
    default: { ...actual, ...overrides, realpathSync },
  };
});

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');
const { GuardStatusReporter } = await import('../src/writeGuard/guardStatusReporter.js');
const { GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS } = await import('../src/constants.js');

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-status-f13-')));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(base, { recursive: true, force: true });
});

function setup() {
  const store = new AgentStateStore();
  const guard = new WriteGuard({
    store,
    ptyManager: { has: () => true },
    curators: { curatorOf: () => null },
    homeDir: () => base,
    workspaces: () => [
      { id: 'default', name: 'Default', directoryPaths: [], rootPath: path.join(base, 'ws') },
    ],
  });
  const probeChain = vi.fn(() => ({
    hooksInstalled: true,
    preToolUsePresent: true,
    scriptPresent: true,
  }));
  const sent: Array<Record<string, unknown>> = [];
  const reporter = new GuardStatusReporter({
    store,
    ptyManager: { has: () => true },
    guard,
    curators: { curatorOf: () => null },
    broadcast: (m) => sent.push(m),
    probeChain,
  });
  store.set(
    1,
    createAgentState({
      id: 1,
      sessionId: 's1',
      projectDir: base,
      jsonlFile: path.join(base, 's1.jsonl'),
      isExternal: false,
      directoryRealPath: path.join(base, 'dir'),
    }),
  );
  return { store, guard, reporter, probeChain, sent };
}

describe('F13 with agentGuardStatus', () => {
  it('makes no filesystem call and no chain probe on the verdict path, yet reports the first verdict', () => {
    const { store, guard, reporter, probeChain, sent } = setup();
    const probesBefore = probeChain.mock.calls.length;
    sent.length = 0;
    fsCounter.calls = [];
    fsCounter.on = true;
    const verdict = guard.verdict({ tool_name: 'Read', session_id: 's1', cwd: base, paths: [] });
    fsCounter.on = false;

    expect(verdict?.verdict).toBe('allow');
    expect(fsCounter.calls).toEqual([]);
    expect(probeChain.mock.calls.length).toBe(probesBefore);
    expect(sent).toEqual([
      expect.objectContaining({ type: 'agentGuardStatus', id: 1, active: true }),
    ]);
    reporter.dispose();
    guard.dispose();
    store.dispose();
  });

  it('probes the chain only on the fixed interval', () => {
    vi.useFakeTimers();
    const { store, guard, reporter, probeChain } = setup();
    reporter.start();
    const baseline = probeChain.mock.calls.length;

    vi.advanceTimersByTime(GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS - 1);
    expect(probeChain.mock.calls.length).toBe(baseline);
    vi.advanceTimersByTime(1);
    expect(probeChain.mock.calls.length).toBe(baseline + 1);
    vi.advanceTimersByTime(GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS);
    expect(probeChain.mock.calls.length).toBe(baseline + 2);

    reporter.dispose();
    vi.advanceTimersByTime(GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS * 3);
    expect(probeChain.mock.calls.length).toBe(baseline + 2);
    guard.dispose();
    store.dispose();
  });
});
