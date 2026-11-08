/**
 * Unit tests for the curator controls on the agent card (S2 front end,
 * acceptance K): the pure curator state, where the controls must not exist
 * (no host support -- which includes VS Code -- or a read-only office), where
 * they do, and the curator badge.
 *
 * WHY UNIT TESTS, given "E2E over webview unit tests" (CLAUDE.md): the rules
 * are pure decision functions (same shape as roleLaunch / workspaces), and the
 * host issues no capability yet, so no e2e scenario can produce a curator.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';

import type { CuratorsLoaded } from '../../core/src/messages.js';
import type { AgentCuratorsValue } from '../src/agentCurators.js';
import { AgentCard } from '../src/components/AgentCard.js';
import { AgentCardProviders } from '../src/components/AgentCardProviders.js';
import type { CuratorState } from '../src/curators.js';
import {
  applyCuratorRejected,
  applyCuratorsLoaded,
  applyWorkspaceCuratorChanged,
  curatorCardAction,
  curatorControlsVisible,
  curatorRejectionFor,
  INITIAL_CURATORS,
  isCuratorOf,
  noteCuratorRequest,
} from '../src/curators.js';

const loaded = (available: boolean, curators: CuratorsLoaded['curators'] = []): CuratorState =>
  applyCuratorsLoaded({ type: 'curatorsLoaded', available, curators });

function card(
  agentId: number,
  value: Partial<AgentCuratorsValue>,
  workspaceOf: Record<number, string> = {},
): string {
  const curators: AgentCuratorsValue = {
    state: INITIAL_CURATORS,
    readOnly: false,
    workspaceOf: (id) => workspaceOf[id] ?? 'default',
    request: () => {},
    ...value,
  };
  return renderToStaticMarkup(
    createElement(
      AgentCardProviders,
      { roleNames: {}, curators },
      createElement(AgentCard, {
        agentId,
        variant: 'default',
        appearance: { palette: 0, hueShift: 0 },
        status: 'idle',
        onSelect: () => {},
        onClose: () => {},
      }),
    ),
  );
}

describe('curator state', () => {
  test('starts unavailable, as under VS Code (which never sends curatorsLoaded)', () => {
    assert.equal(INITIAL_CURATORS.available, false);
    assert.equal(curatorControlsVisible(INITIAL_CURATORS, false), false);
  });

  test('curatorsLoaded sets availability and the map; unavailable drops any list', () => {
    const state = loaded(true, [{ workspaceId: 'w1', agentId: 3 }]);
    assert.equal(state.available, true);
    assert.deepEqual(state.byWorkspace, { w1: 3 });
    assert.deepEqual(loaded(false, [{ workspaceId: 'w1', agentId: 3 }]).byWorkspace, {});
  });

  test('workspaceCuratorChanged sets and clears one Workspace', () => {
    let state = loaded(true);
    state = applyWorkspaceCuratorChanged(state, {
      type: 'workspaceCuratorChanged',
      workspaceId: 'w1',
      agentId: 4,
    });
    assert.equal(isCuratorOf(state, 4, 'w1'), true);
    assert.equal(isCuratorOf(state, 4, 'w2'), false);
    state = applyWorkspaceCuratorChanged(state, {
      type: 'workspaceCuratorChanged',
      workspaceId: 'w1',
      agentId: null,
    });
    assert.deepEqual(state.byWorkspace, {});
  });

  test('controls are hidden when unavailable or read-only, shown otherwise', () => {
    assert.equal(curatorControlsVisible(loaded(false), false), false);
    assert.equal(curatorControlsVisible(loaded(false), true), false);
    assert.equal(curatorControlsVisible(loaded(true), true), false);
    assert.equal(curatorControlsVisible(loaded(true), false), true);
  });

  test('the card offers appoint, dismiss or nothing', () => {
    const state = loaded(true, [{ workspaceId: 'w1', agentId: 2 }]);
    assert.deepEqual(curatorCardAction(state, false, 2, 'w1'), {
      kind: 'dismiss',
      message: { type: 'unsetWorkspaceCurator', workspaceId: 'w1' },
    });
    assert.deepEqual(curatorCardAction(state, false, 3, 'w1'), { kind: 'none' });
    assert.deepEqual(curatorCardAction(state, false, 3, 'w2'), {
      kind: 'appoint',
      message: { type: 'setWorkspaceCurator', workspaceId: 'w2', agentId: 3 },
    });
    assert.deepEqual(curatorCardAction(state, true, 3, 'w2'), { kind: 'none' });
    assert.deepEqual(curatorCardAction(loaded(false), false, 3, 'w2'), { kind: 'none' });
  });

  test('a refusal is shown on the card that asked, and cleared by the next change', () => {
    let state = noteCuratorRequest(loaded(true), 5);
    state = applyCuratorRejected(state, {
      type: 'curatorRejected',
      code: 'not_eligible',
      reason: 'not eligible',
    });
    assert.equal(curatorRejectionFor(state, 5), 'not eligible');
    assert.equal(curatorRejectionFor(state, 6), null);
    state = applyWorkspaceCuratorChanged(state, {
      type: 'workspaceCuratorChanged',
      workspaceId: 'w1',
      agentId: 6,
    });
    assert.equal(curatorRejectionFor(state, 5), null);
  });
});

describe('curator controls on the agent card', () => {
  test('no control and no badge when the host has no curators (VS Code included)', () => {
    for (const state of [INITIAL_CURATORS, loaded(false)]) {
      const html = card(7, { state });
      assert.equal(html.includes('agent-card-curator'), false);
    }
    // A card outside any provider looks as before too.
    const bare = renderToStaticMarkup(
      createElement(AgentCard, {
        agentId: 7,
        variant: 'default',
        appearance: { palette: 0, hueShift: 0 },
        status: 'idle',
        onSelect: () => {},
        onClose: () => {},
      }),
    );
    assert.equal(bare.includes('agent-card-curator'), false);
  });

  test('no control in a read-only office', () => {
    const html = card(7, { state: loaded(true), readOnly: true });
    assert.equal(html.includes('agent-card-curator-set'), false);
    assert.equal(html.includes('agent-card-curator-unset'), false);
  });

  test('an appoint control when available and privileged', () => {
    const html = card(7, { state: loaded(true) });
    assert.ok(html.includes('data-testid="agent-card-curator-set"'));
    assert.ok(html.includes('>Make curator<'));
    assert.equal(html.includes('data-testid="agent-card-curator"'), false);
  });

  test('the curator carries a badge and a dismiss control', () => {
    const state = loaded(true, [{ workspaceId: 'w1', agentId: 7 }]);
    const html = card(7, { state }, { 7: 'w1' });
    assert.ok(html.includes('data-testid="agent-card-curator"'));
    assert.ok(html.includes('>Curator<'));
    assert.ok(html.includes('data-testid="agent-card-curator-unset"'));

    // Read-only: the badge stays, the control goes.
    const readOnly = card(7, { state, readOnly: true }, { 7: 'w1' });
    assert.ok(readOnly.includes('data-testid="agent-card-curator"'));
    assert.equal(readOnly.includes('agent-card-curator-unset'), false);
  });

  test('a refusal reason renders as plain text', () => {
    const state = applyCuratorRejected(noteCuratorRequest(loaded(true), 7), {
      type: 'curatorRejected',
      code: 'not_eligible',
      reason: '<b>no</b>',
    });
    const html = card(7, { state });
    assert.ok(html.includes('data-testid="agent-card-curator-rejected"'));
    assert.ok(html.includes('&lt;b&gt;no&lt;/b&gt;'));
    assert.equal(html.includes('<b>'), false);
  });

  test('no curator UI source can inject HTML', () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
    for (const file of ['curators.ts', 'agentCurators.tsx', 'components/AgentCard.tsx']) {
      const source = readFileSync(path.join(srcDir, file), 'utf8');
      assert.equal(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/.test(source),
        false,
        file,
      );
    }
  });
});
