import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Workspace } from '../../protocol';
import type { Agent } from '../agents/agentsSlice';
import {
  canEditWorkspaceRoot,
  confirmMessage,
  countAgentsLosingProtection,
  findOverlappingWorkspace,
  rootChangeNeedsConfirm,
} from './workspaceRoot';

const agent = (patch: Partial<Agent>) => ({ stopped: false, isExternal: false, ...patch }) as Agent;
const ws = (id: string, rootPath?: string): Workspace => ({
  id,
  name: id,
  directoryPaths: [],
  ...(rootPath === undefined ? {} : { rootPath }),
});

describe('根目錄控制', () => {
  it('Default 不顯示控制', () => {
    expect(canEditWorkspaceRoot(DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(canEditWorkspaceRoot('ws-1')).toBe(true);
  });

  it('只有既有根目錄的變更或清除才需要確認', () => {
    expect(rootChangeNeedsConfirm(undefined)).toBe(false);
    expect(rootChangeNeedsConfirm('/r')).toBe(true);
  });

  it('確認數量：執行中、idle、waiting 各算一個，已停止與外部不算（N = 3）', () => {
    const agents = [
      agent({ status: 'active' }),
      agent({ status: 'waiting' }),
      agent({ status: 'waiting', awaitingInput: true }),
      agent({ stopped: true }),
      agent({ isExternal: true }),
    ];
    expect(countAgentsLosingProtection(agents)).toBe(3);
    expect(confirmMessage(3)).toContain('3 個執行中的 Agent');
  });

  it('重疊警告以路徑邊界比較', () => {
    const others = [ws('a', '/work/proj'), ws('b', '/work/other/')];
    expect(findOverlappingWorkspace('/work/proj/sub', 'me', others)?.id).toBe('a');
    expect(findOverlappingWorkspace('/work', 'me', others)?.id).toBe('a');
    expect(findOverlappingWorkspace('/work/other', 'me', others)?.id).toBe('b');
    expect(findOverlappingWorkspace('/work/proj-2', 'me', others)).toBeUndefined();
    expect(findOverlappingWorkspace('/work/proj', 'a', others)).toBeUndefined();
    expect(findOverlappingWorkspace('', 'me', others)).toBeUndefined();
  });
});
