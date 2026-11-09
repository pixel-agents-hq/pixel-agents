/** P4：computeGuardStatus 純函式（F14 的每個原因）。 */

import { describe, expect, it } from 'vitest';

import type { GuardStatusInputs } from '../src/writeGuard/guardStatus.js';
import { computeGuardStatus, guardStatusMessage } from '../src/writeGuard/guardStatus.js';

const healthy: GuardStatusInputs = {
  isStandaloneAgent: true,
  chain: { hooksInstalled: true, preToolUsePresent: true, scriptPresent: true },
  verdictSeen: true,
  workspaceHasRoot: true,
  workspaceHasCurator: true,
};

function withInputs(patch: Partial<GuardStatusInputs>): GuardStatusInputs {
  return { ...healthy, ...patch };
}

describe('computeGuardStatus', () => {
  it('is active with no reasons when the chain is whole and a verdict was seen', () => {
    expect(computeGuardStatus(healthy)).toEqual({ active: true, reasons: [] });
  });

  it('reports not_standalone_agent alone for a non-PTY agent', () => {
    expect(computeGuardStatus(withInputs({ isStandaloneAgent: false }))).toEqual({
      active: false,
      reasons: ['not_standalone_agent'],
    });
  });

  it('reports hooks_not_installed (and not pretooluse_hook_missing) when nothing is installed', () => {
    const status = computeGuardStatus(
      withInputs({
        chain: { hooksInstalled: false, preToolUsePresent: false, scriptPresent: true },
      }),
    );
    expect(status).toEqual({ active: false, reasons: ['hooks_not_installed'] });
  });

  it('reports pretooluse_hook_missing when hooks are installed but PreToolUse is gone', () => {
    const status = computeGuardStatus(
      withInputs({
        chain: { hooksInstalled: true, preToolUsePresent: false, scriptPresent: true },
      }),
    );
    expect(status).toEqual({ active: false, reasons: ['pretooluse_hook_missing'] });
  });

  it('reports hook_script_missing when the script file is absent', () => {
    const status = computeGuardStatus(
      withInputs({
        chain: { hooksInstalled: true, preToolUsePresent: true, scriptPresent: false },
      }),
    );
    expect(status).toEqual({ active: false, reasons: ['hook_script_missing'] });
  });

  it('reports awaiting_first_verdict until a verdict request was seen', () => {
    expect(computeGuardStatus(withInputs({ verdictSeen: false }))).toEqual({
      active: false,
      reasons: ['awaiting_first_verdict'],
    });
  });

  it('lists no_workspace_root and no_curator without changing active', () => {
    expect(computeGuardStatus(withInputs({ workspaceHasRoot: false }))).toEqual({
      active: true,
      reasons: ['no_workspace_root'],
    });
    expect(computeGuardStatus(withInputs({ workspaceHasCurator: false }))).toEqual({
      active: true,
      reasons: ['no_curator'],
    });
  });

  it('keeps a chain reason ahead of the display-only reasons when inactive', () => {
    const status = computeGuardStatus(withInputs({ verdictSeen: false, workspaceHasRoot: false }));
    expect(status.active).toBe(false);
    expect(status.reasons).toEqual(['awaiting_first_verdict', 'no_workspace_root']);
  });
});

describe('guardStatusMessage', () => {
  it('reflects roles as given (array copy or null) and carries only protocol fields', () => {
    const roles = ['R', 'E'] as const;
    const message = guardStatusMessage(3, { active: true, reasons: [] }, roles);
    expect(message).toEqual({
      type: 'agentGuardStatus',
      id: 3,
      active: true,
      reasons: [],
      permissionRoles: ['R', 'E'],
    });
    expect(guardStatusMessage(3, { active: false, reasons: [] }, null).permissionRoles).toBeNull();
  });
});
