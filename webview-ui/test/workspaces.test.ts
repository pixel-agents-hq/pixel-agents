/**
 * Unit tests for the webview's Workspace rules (S1 acceptance 4, 6, 10, 13, 14,
 * 18, plus the launch drawer's Directory filter and active-Workspace removal).
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md): it
 * tests pure decision functions (workspaces.ts) and the OfficeState visibility
 * filter, the same shape as cardBar and existingAgents — not React internals.
 * What only a browser can show (tab layout, badge colours, scrolling, the 44px
 * targets actually rendering at that size) is left to the standalone e2e spec.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { MOBILE_TOUCH_TARGET_MIN_PX } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import type { Workspace, WorkspaceViewState } from '../src/workspaces.js';
import {
  applyAgentClosed,
  applyAgentCreated,
  applyAgentWorkspaceChanged,
  applyExistingAgents,
  applyWorkspacesLoaded,
  canEditWorkspace,
  computeWorkspaceBadges,
  DEFAULT_WORKSPACE_ID,
  directoriesForWorkspace,
  directoryPathKey,
  INITIAL_WORKSPACE_VIEW,
  isAgentVisible,
  isMutationApplied,
  selectWorkspace,
  shouldAutoSelectNewAgent,
  shouldShowWorkspaceSwitcher,
  switcherTouchTargetStyle,
  visibleAgentIds,
  workspaceOfAgent,
  workspacePathsToSave,
  workspaceTabLabel,
} from '../src/workspaces.js';

const DEFAULT: Workspace = { id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] };
const BETA: Workspace = { id: 'beta', name: 'Beta', directoryPaths: ['/code/beta', '/code/beta2'] };
const GAMMA: Workspace = { id: 'gamma', name: 'Gamma', directoryPaths: ['/code/gamma'] };

function loaded(workspaces: Workspace[] = [DEFAULT, BETA, GAMMA]): WorkspaceViewState {
  return applyWorkspacesLoaded(INITIAL_WORKSPACE_VIEW, workspaces);
}

describe('without workspaceIds (acceptance 10)', () => {
  test('an agent created with no workspaceId is in the default Workspace and shown', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1 });
    assert.equal(workspaceOfAgent(view, 1), DEFAULT_WORKSPACE_ID);
    assert.equal(isAgentVisible(view, 1), true);
    assert.deepEqual(visibleAgentIds(view, [1, 2, 3]), [1, 2, 3]);
  });

  test('before any workspacesLoaded nothing is filtered, even for tagged agents', () => {
    const view = applyAgentCreated(INITIAL_WORKSPACE_VIEW, { id: 1, workspaceId: 'beta' });
    assert.equal(view.workspaces, null);
    assert.equal(isAgentVisible(view, 1), true);
    assert.deepEqual(visibleAgentIds(view, [1, 2]), [1, 2]);
  });

  test('existingAgents without workspaceIds leaves every agent in the default Workspace', () => {
    const view = applyExistingAgents(loaded(), undefined);
    assert.deepEqual(view.agentWorkspaceIds, {});
    assert.deepEqual(visibleAgentIds(view, [1, 2]), [1, 2]);
  });

  test('the switcher is not shown without a workspaces list, or outside the browser', () => {
    assert.equal(shouldShowWorkspaceSwitcher({ isBrowserRuntime: true, workspaces: null }), false);
    assert.equal(shouldShowWorkspaceSwitcher({ isBrowserRuntime: false, workspaces: null }), false);
    assert.equal(
      shouldShowWorkspaceSwitcher({ isBrowserRuntime: false, workspaces: [DEFAULT] }),
      false,
    );
    assert.equal(
      shouldShowWorkspaceSwitcher({ isBrowserRuntime: true, workspaces: [DEFAULT] }),
      true,
    );
  });
});

describe('filtering by the active Workspace (acceptance 4, frontend half)', () => {
  test('switching shows only that Workspace, switching back hides it again', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1 });
    view = applyAgentCreated(view, { id: 2, workspaceId: 'beta' });
    assert.deepEqual(visibleAgentIds(view, [1, 2]), [1]);

    view = selectWorkspace(view, 'beta');
    assert.deepEqual(visibleAgentIds(view, [1, 2]), [2]);

    view = selectWorkspace(view, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(visibleAgentIds(view, [1, 2]), [1]);
  });

  test('selecting an id the list does not hold is ignored', () => {
    const view = loaded();
    assert.equal(selectWorkspace(view, 'nope'), view);
    assert.equal(selectWorkspace(INITIAL_WORKSPACE_VIEW, 'beta'), INITIAL_WORKSPACE_VIEW);
  });

  test('a Teammate created without a workspaceId follows its Lead', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 10, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 11, leadAgentId: 10 });
    assert.equal(workspaceOfAgent(view, 11), 'beta');
    view = selectWorkspace(view, 'beta');
    assert.deepEqual(visibleAgentIds(view, [10, 11]), [10, 11]);
    view = selectWorkspace(view, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(visibleAgentIds(view, [10, 11]), []);
  });

  test('a Teammate whose message carries a workspaceId keeps the server value', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 10, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 11, workspaceId: 'gamma', leadAgentId: 10 });
    assert.equal(workspaceOfAgent(view, 11), 'gamma');
  });

  test('agentWorkspaceChanged moves one agent; moving to the default drops the entry', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1, workspaceId: 'beta' });
    view = applyAgentWorkspaceChanged(view, 1, 'gamma');
    assert.equal(workspaceOfAgent(view, 1), 'gamma');
    view = applyAgentWorkspaceChanged(view, 1, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(view.agentWorkspaceIds, {});
  });

  test('Lead and Teammate both returning to the default leave nothing behind', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 10, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 11, workspaceId: 'beta' });
    view = applyAgentWorkspaceChanged(view, 10, DEFAULT_WORKSPACE_ID);
    view = applyAgentWorkspaceChanged(view, 11, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(view.agentWorkspaceIds, {});
  });

  test('existingAgents replaces membership wholesale, keys parsed from strings', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 5, workspaceId: 'gamma' });
    view = applyExistingAgents(view, { '1': 'beta', '2': DEFAULT_WORKSPACE_ID });
    assert.deepEqual(view.agentWorkspaceIds, { 1: 'beta' });
  });

  test('a closed agent is forgotten', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1, workspaceId: 'beta' });
    view = applyAgentClosed(view, 1);
    assert.deepEqual(view.agentWorkspaceIds, {});
  });

  test('an agent tagged with a Workspace the list lacks counts as default', () => {
    const view = applyAgentCreated(loaded([DEFAULT, BETA]), { id: 1, workspaceId: 'gone' });
    assert.equal(workspaceOfAgent(view, 1), DEFAULT_WORKSPACE_ID);
    assert.equal(isAgentVisible(view, 1), true);
  });
});

describe('active Workspace removal', () => {
  test('falls back to the default when the active Workspace leaves the list', () => {
    let view = loaded();
    view = selectWorkspace(view, 'beta');
    assert.equal(view.activeWorkspaceId, 'beta');
    view = applyWorkspacesLoaded(view, [DEFAULT, GAMMA]);
    assert.equal(view.activeWorkspaceId, DEFAULT_WORKSPACE_ID);
  });

  test('keeps the active Workspace while it is still listed', () => {
    let view = selectWorkspace(loaded(), 'beta');
    view = applyWorkspacesLoaded(view, [DEFAULT, BETA]);
    assert.equal(view.activeWorkspaceId, 'beta');
  });

  test('agents of a removed Workspace show in the default without waiting for their messages', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 2, workspaceId: 'beta' });
    view = selectWorkspace(view, 'beta');
    view = applyWorkspacesLoaded(view, [DEFAULT, GAMMA]);
    assert.deepEqual(visibleAgentIds(view, [2]), [2]);
  });
});

describe('badges (acceptance 6)', () => {
  const attention = (table: Record<number, 'permission' | 'waiting'>) => (id: number) =>
    table[id] ?? null;

  test('counts permission and waiting separately, per non-active Workspace', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 2, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 3, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 4, workspaceId: 'gamma' });
    const badges = computeWorkspaceBadges(
      view,
      [1, 2, 3, 4],
      attention({ 1: 'permission', 2: 'waiting', 3: 'waiting', 4: 'permission' }),
    );
    assert.deepEqual(badges['beta'], { permission: 1, waiting: 2 });
    assert.deepEqual(badges['gamma'], { permission: 1, waiting: 0 });
  });

  test('the active Workspace gets no badge', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 1 });
    view = applyAgentCreated(view, { id: 2, workspaceId: 'beta' });
    const badges = computeWorkspaceBadges(
      view,
      [1, 2],
      attention({ 1: 'permission', 2: 'permission' }),
    );
    assert.equal(DEFAULT_WORKSPACE_ID in badges, false);
    assert.deepEqual(badges['beta'], { permission: 1, waiting: 0 });
    const switched = selectWorkspace(view, 'beta');
    const after = computeWorkspaceBadges(
      switched,
      [1, 2],
      attention({ 1: 'permission', 2: 'permission' }),
    );
    assert.equal('beta' in after, false);
    assert.deepEqual(after[DEFAULT_WORKSPACE_ID], { permission: 1, waiting: 0 });
  });

  test('agents needing nothing add no entry', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 2, workspaceId: 'beta' });
    assert.deepEqual(
      computeWorkspaceBadges(view, [2], () => null),
      {},
    );
  });

  test("a Teammate waiting counts toward its Lead's Workspace", () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 10, workspaceId: 'beta' });
    view = applyAgentCreated(view, { id: 11, leadAgentId: 10 });
    const badges = computeWorkspaceBadges(view, [10, 11], attention({ 11: 'waiting' }));
    assert.deepEqual(badges['beta'], { permission: 0, waiting: 1 });
  });

  test('without a list there are no badges', () => {
    assert.deepEqual(
      computeWorkspaceBadges(INITIAL_WORKSPACE_VIEW, [1], () => 'permission'),
      {},
    );
  });

  test('the tab label speaks what the badge shows', () => {
    assert.equal(workspaceTabLabel('Beta', undefined), 'Beta');
    assert.equal(
      workspaceTabLabel('Beta', { permission: 2, waiting: 0 }),
      'Beta, 2 need permission',
    );
    assert.equal(
      workspaceTabLabel('Beta', { permission: 1, waiting: 3 }),
      'Beta, 1 need permission, 3 waiting',
    );
  });
});

describe('workspace edit control', () => {
  test('shows edit/delete for non-default Workspaces only', () => {
    assert.equal(canEditWorkspace('beta'), true);
    assert.equal(canEditWorkspace(DEFAULT_WORKSPACE_ID), false);
  });
});

describe('selection on creation (acceptance 18)', () => {
  test('a new agent in the shown Workspace is auto-selected', () => {
    let view = selectWorkspace(loaded(), 'beta');
    view = applyAgentCreated(view, { id: 7, workspaceId: 'beta' });
    assert.equal(shouldAutoSelectNewAgent(view, 7), true);
  });

  test('a new agent in another Workspace is not', () => {
    let view = loaded();
    view = applyAgentCreated(view, { id: 7, workspaceId: 'beta' });
    assert.equal(shouldAutoSelectNewAgent(view, 7), false);
  });

  test('a default-Workspace agent is not selected while another Workspace is shown', () => {
    let view = selectWorkspace(loaded(), 'beta');
    view = applyAgentCreated(view, { id: 7 });
    assert.equal(shouldAutoSelectNewAgent(view, 7), false);
  });

  test('with no Workspace list (VS Code) every new agent is selected as before', () => {
    const view = applyAgentCreated(INITIAL_WORKSPACE_VIEW, { id: 7 });
    assert.equal(shouldAutoSelectNewAgent(view, 7), true);
  });
});

describe('launch drawer Directories', () => {
  const dirs = [
    { name: 'beta', path: '/code/beta' },
    { name: 'beta2', path: '/code/beta2' },
    { name: 'gamma', path: '/code/gamma' },
    { name: 'free', path: '/code/free' },
    { name: 'free2', path: '/code/free2/' },
  ];
  const list = [DEFAULT, BETA, GAMMA];

  test('the default Workspace offers those nobody owns', () => {
    assert.deepEqual(
      directoriesForWorkspace(dirs, list, DEFAULT_WORKSPACE_ID).map((d) => d.name),
      ['free', 'free2'],
    );
  });

  test('another Workspace offers only its own', () => {
    assert.deepEqual(
      directoriesForWorkspace(dirs, list, 'beta').map((d) => d.name),
      ['beta', 'beta2'],
    );
    assert.deepEqual(
      directoriesForWorkspace(dirs, list, 'gamma').map((d) => d.name),
      ['gamma'],
    );
  });

  test('without a list nothing is filtered', () => {
    assert.equal(directoriesForWorkspace(dirs, null, 'beta').length, dirs.length);
  });

  test('a trailing separator or repeated slash does not change ownership', () => {
    const w: Workspace[] = [DEFAULT, { id: 'x', name: 'X', directoryPaths: ['/code/free2'] }];
    assert.deepEqual(
      directoriesForWorkspace(dirs, w, 'x').map((d) => d.name),
      ['free2'],
    );
    assert.equal(directoryPathKey('/a//b/'), '/a/b');
    assert.equal(directoryPathKey('/'), '/');
  });

  test('Windows-shaped paths compare case-insensitively across separators', () => {
    assert.equal(directoryPathKey('C:\\Code\\App\\'), directoryPathKey('c:/code/app'));
    assert.equal(directoryPathKey('C:\\'), 'c:/');
    assert.equal(directoryPathKey('\\\\Host\\Share'), '//host/share');
    // A POSIX path keeps its case and its backslashes: they are real characters.
    assert.notEqual(directoryPathKey('/Code/App'), directoryPathKey('/code/app'));
  });
});

describe('editing round trip', () => {
  const list = [DEFAULT, BETA];

  test('a save is applied when the list holds that name and set of paths', () => {
    assert.equal(
      isMutationApplied(
        { kind: 'save', name: 'Beta', directoryPaths: ['/code/beta2', '/code/beta/'] },
        list,
      ),
      true,
    );
    assert.equal(
      isMutationApplied({ kind: 'save', name: 'Beta', directoryPaths: ['/code/beta'] }, list),
      false,
    );
  });

  test("another office's unrelated change does not look like our save", () => {
    assert.equal(isMutationApplied({ kind: 'save', name: 'New', directoryPaths: [] }, list), false);
  });

  test('an edit by id is applied only on that Workspace', () => {
    assert.equal(
      isMutationApplied(
        {
          kind: 'save',
          id: 'beta',
          name: 'Renamed',
          directoryPaths: ['/code/beta', '/code/beta2'],
        },
        list,
      ),
      false,
    );
  });

  test('a remove is applied once the id is gone', () => {
    assert.equal(isMutationApplied({ kind: 'remove', id: 'beta' }, list), false);
    assert.equal(isMutationApplied({ kind: 'remove', id: 'beta' }, [DEFAULT]), true);
  });

  test('paths the list cannot show are kept on save', () => {
    assert.deepEqual(
      workspacePathsToSave(['/code/a'], ['/code/a', '/code/b'], ['/code/b/', '/code/hidden']),
      ['/code/a', '/code/hidden'],
    );
  });
});

describe('phone touch targets (acceptance 14)', () => {
  test('the minimum is the 44px guideline', () => {
    assert.equal(MOBILE_TOUCH_TARGET_MIN_PX, 44);
  });

  test('the phone shell gets a 44px minimum on both axes, desktop none', () => {
    assert.deepEqual(switcherTouchTargetStyle(true), { minHeight: 44, minWidth: 44 });
    assert.equal(switcherTouchTargetStyle(false), undefined);
  });
});

describe('OfficeState visibility filter', () => {
  function floorLayout(cols = 9, rows = 7): OfficeLayout {
    return {
      version: 1,
      cols,
      rows,
      tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
      furniture: [],
    };
  }

  function officeWith(ids: number[]): OfficeState {
    const os = new OfficeState(floorLayout());
    for (const id of ids) os.addAgent(id, 0, 0, undefined, true);
    return os;
  }

  test('hidden characters are not drawn or hit but stay in the office', () => {
    const os = officeWith([1, 2]);
    const ch2 = os.characters.get(2)!;
    assert.equal(os.getCharacterAt(ch2.x, ch2.y - 4), 2);
    os.setVisibilityFilter((id) => id === 1);
    assert.deepEqual(
      os.getVisibleCharacters().map((c) => c.id),
      [1],
    );
    assert.equal(os.getCharacterAt(ch2.x, ch2.y - 4), null);
    assert.equal(os.characters.has(2), true);
    assert.equal(os.getCharacters().length, 2);
  });

  test('a sub-agent is shown or hidden with its parent', () => {
    const os = officeWith([1, 2]);
    const subId = os.addSubagent(2, 'tool-1');
    os.setVisibilityFilter((id) => id === 1);
    assert.equal(os.isCharacterVisible(subId), false);
    os.setVisibilityFilter((id) => id === 2);
    assert.equal(os.isCharacterVisible(subId), true);
  });

  test('switching away drops selection, camera follow and hover on a hidden agent', () => {
    const os = officeWith([1, 2]);
    os.selectAndFollow(2);
    os.hoveredAgentId = 2;
    os.setVisibilityFilter((id) => id === 1);
    assert.equal(os.selectedAgentId, null);
    assert.equal(os.cameraFollowId, null);
    assert.equal(os.hoveredAgentId, null);
  });

  test('selection of a still-visible agent survives a filter change', () => {
    const os = officeWith([1, 2]);
    os.selectAndFollow(1);
    os.setVisibilityFilter((id) => id === 1);
    assert.equal(os.selectedAgentId, 1);
    assert.equal(os.cameraFollowId, 1);
  });

  test('a null filter shows everyone again', () => {
    const os = officeWith([1, 2]);
    os.setVisibilityFilter((id) => id === 1);
    os.setVisibilityFilter(null);
    assert.equal(os.getVisibleCharacters().length, 2);
  });
});
