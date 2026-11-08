/**
 * Unit tests for the two-step launch (S1b front end, acceptance 7, 8, 13): the
 * roleLaunch state machine, the plain-text preview, the places the Role picker
 * must not exist, and the Role name on the agent card.
 *
 * WHY UNIT TESTS, given "E2E over webview unit tests" (CLAUDE.md): the reducer
 * is a pure decision function (same shape as cardBar / workspaces), and the
 * preview's plain-text guarantee is a security property of the markup that is
 * cheaper and sharper to pin on rendered output than through a browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';

import type {
  ClientMessage,
  RoleConfirmed,
  RolePreview,
  RoleRejected,
  RolesAvailable,
} from '../../core/src/messages.js';
import {
  agentCardTitle,
  AgentRoleNamesProvider,
  mergeAgentRoleNames,
  withAgentRoleName,
} from '../src/agentRoles.js';
import { AgentCard } from '../src/components/AgentCard.js';
import { RoleLaunchModal, RolePreviewText } from '../src/components/RoleLaunchModal.js';
import type { RoleLaunchEvent, RoleLaunchState } from '../src/roleLaunch.js';
import {
  previewLineCount,
  ROLE_LAUNCH_IDLE,
  roleLaunchReducer,
  roleNameOf,
  rolePickerAvailable,
} from '../src/roleLaunch.js';

const DIR = '/work/app';
const OTHER_DIR = '/work/other';
const ROLE = 'frontend.md';
const SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);

const roles: RolesAvailable = {
  type: 'rolesAvailable',
  directoryPath: DIR,
  roles: [
    { roleId: ROLE, name: 'frontend' },
    { roleId: 'backend.md', name: 'backend' },
  ],
};

function preview(overrides: Partial<RolePreview> = {}): RolePreview {
  return {
    type: 'rolePreview',
    directoryPath: DIR,
    roleId: ROLE,
    content: 'Be careful.\nSecond line.\n',
    sha256: SHA,
    size: 25,
    mtime: '2026-11-07T00:00:00.000Z',
    trusted: false,
    ...overrides,
  };
}

const confirmed = (overrides: Partial<RoleConfirmed> = {}): RoleConfirmed => ({
  type: 'roleConfirmed',
  directoryPath: DIR,
  roleId: ROLE,
  sha256: SHA,
  ...overrides,
});

const rejected = (code: RoleRejected['code'], reason = 'refused'): RoleRejected => ({
  type: 'roleRejected',
  code,
  reason,
});

/** Run events through the reducer, collecting every message it asks to send. */
function run(events: RoleLaunchEvent[], from: RoleLaunchState = ROLE_LAUNCH_IDLE) {
  let state = from;
  const sent: ClientMessage[] = [];
  for (const event of events) {
    const result = roleLaunchReducer(state, event);
    state = result.state;
    sent.push(...result.send);
  }
  return { state, sent };
}

const toChoose: RoleLaunchEvent[] = [
  { type: 'begin', directoryPath: DIR },
  { type: 'rolesAvailable', msg: roles },
];
const toPreviewRequested: RoleLaunchEvent[] = [...toChoose, { type: 'pickRole', roleId: ROLE }];
const toPreviewShown = (
  p: RolePreview = preview(),
  bypassPermissions = false,
): RoleLaunchEvent[] => [...toPreviewRequested, { type: 'rolePreview', msg: p, bypassPermissions }];

const launchesOf = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'launchAgent');

describe('roleLaunch reducer', () => {
  test("begin asks the host for the Directory's roles and nothing else", () => {
    const { state, sent } = run([{ type: 'begin', directoryPath: DIR }]);
    assert.equal(state.step, 'choose');
    assert.deepEqual(sent, [{ type: 'requestRoles', directoryPath: DIR }]);
  });

  test('no role: launchAgent has exactly the fields of the launch of old', () => {
    const { state, sent } = run([...toChoose, { type: 'pickNoRole' }]);
    assert.equal(state.step, 'idle');
    const launches = launchesOf(sent);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], { type: 'launchAgent', directoryPath: DIR });
    assert.deepEqual(Object.keys(launches[0]!).sort(), ['directoryPath', 'type']);
  });

  test('picking a role requests its preview and does not launch', () => {
    const { state, sent } = run(toPreviewRequested);
    assert.equal(state.step, 'preview');
    assert.deepEqual(sent.at(-1), {
      type: 'requestRolePreview',
      directoryPath: DIR,
      roleId: ROLE,
    });
    assert.equal(launchesOf(sent).length, 0);
  });

  test('a role that was not listed cannot be picked', () => {
    const { state, sent } = run([...toChoose, { type: 'pickRole', roleId: 'evil.md' }]);
    assert.equal(state.step, 'choose');
    assert.equal(sent.length, 1); // only the requestRoles
  });

  test('trusted preview skips the confirm step and launches with the roleId', () => {
    const { state, sent } = run(toPreviewShown(preview({ trusted: true })));
    assert.equal(state.step, 'launching');
    assert.equal(
      sent.some((m) => m.type === 'confirmRole'),
      false,
    );
    assert.deepEqual(launchesOf(sent), [{ type: 'launchAgent', directoryPath: DIR, roleId: ROLE }]);
  });

  test('untrusted preview waits for the operator, then confirms with the previewed sha256', () => {
    const shown = run(toPreviewShown());
    assert.equal(shown.state.step, 'preview');
    assert.equal(launchesOf(shown.sent).length, 0);

    const confirming = run([{ type: 'confirm' }], shown.state);
    assert.deepEqual(confirming.sent, [
      { type: 'confirmRole', directoryPath: DIR, roleId: ROLE, sha256: SHA },
    ]);
    // Still no launch until roleConfirmed.
    assert.equal(launchesOf(confirming.sent).length, 0);

    const done = run([{ type: 'roleConfirmed', msg: confirmed() }], confirming.state);
    assert.equal(done.state.step, 'launching');
    assert.deepEqual(launchesOf(done.sent), [
      { type: 'launchAgent', directoryPath: DIR, roleId: ROLE },
    ]);
  });

  test('bypassPermissions on: a trusted preview is NOT skipped', () => {
    const { state, sent } = run(toPreviewShown(preview({ trusted: true }), true));
    assert.equal(state.step, 'preview');
    assert.equal(launchesOf(sent).length, 0);
    assert.equal(
      sent.some((m) => m.type === 'confirmRole'),
      false,
    );
    // The operator still has to press confirm, and the launch still waits for roleConfirmed.
    const confirming = run([{ type: 'confirm' }], state);
    assert.equal(confirming.sent[0]?.type, 'confirmRole');
    assert.equal(launchesOf(confirming.sent).length, 0);
    const done = run([{ type: 'roleConfirmed', msg: confirmed() }], confirming.state);
    assert.equal(launchesOf(done.sent).length, 1);
  });

  test('roleConfirmed never launches without a confirmRole in flight', () => {
    const shown = run(toPreviewShown());
    const result = run([{ type: 'roleConfirmed', msg: confirmed() }], shown.state);
    assert.equal(result.state, shown.state);
    assert.equal(result.sent.length, 0);
  });

  test('untrusted after the launch goes back to the preview step and re-requests it', () => {
    const trusted = run(toPreviewShown(preview({ trusted: true })));
    assert.equal(trusted.state.step, 'launching');
    const back = run([{ type: 'roleRejected', msg: rejected('untrusted') }], trusted.state);
    assert.equal(back.state.step, 'preview');
    assert.equal((back.state as { preview: unknown }).preview, null);
    assert.deepEqual(back.sent, [{ type: 'requestRolePreview', directoryPath: DIR, roleId: ROLE }]);
    assert.equal(launchesOf(back.sent).length, 0);
  });

  test('untrusted after confirmRole (file changed since the preview) goes back to the preview', () => {
    const confirming = run([...toPreviewShown(), { type: 'confirm' }]);
    const back = run([{ type: 'roleRejected', msg: rejected('untrusted') }], confirming.state);
    assert.equal(back.state.step, 'preview');
    assert.equal((back.state as { confirming: boolean }).confirming, false);
    assert.equal((back.state as { preview: unknown }).preview, null);
    assert.deepEqual(back.sent, [{ type: 'requestRolePreview', directoryPath: DIR, roleId: ROLE }]);
    // The new preview (new hash) then has to be confirmed again.
    const again = run(
      [{ type: 'rolePreview', msg: preview({ sha256: NEW_SHA }), bypassPermissions: false }],
      back.state,
    );
    assert.equal((again.state as { preview: RolePreview }).preview.sha256, NEW_SHA);
    assert.equal(launchesOf(again.sent).length, 0);
  });

  test('a repeated untrusted does not send more preview requests', () => {
    const trusted = run(toPreviewShown(preview({ trusted: true })));
    const first = run([{ type: 'roleRejected', msg: rejected('untrusted') }], trusted.state);
    const second = run([{ type: 'roleRejected', msg: rejected('untrusted') }], first.state);
    assert.equal(second.state, first.state);
    assert.equal(second.sent.length, 0);
  });

  test('other rejections show the reason and stay without launching', () => {
    for (const code of ['invalid', 'unavailable', 'io'] as const) {
      // During role listing.
      const listing = run([{ type: 'begin', directoryPath: DIR }]);
      const inChoose = run(
        [{ type: 'roleRejected', msg: rejected(code, `why ${code}`) }],
        listing.state,
      );
      assert.equal(inChoose.state.step, 'choose');
      assert.equal((inChoose.state as { error: string }).error, `why ${code}`);
      assert.equal(inChoose.sent.length, 0);

      // While confirming.
      const confirming = run([...toPreviewShown(), { type: 'confirm' }]);
      const inPreview = run(
        [{ type: 'roleRejected', msg: rejected(code, `why ${code}`) }],
        confirming.state,
      );
      assert.equal(inPreview.state.step, 'preview');
      assert.equal((inPreview.state as { error: string }).error, `why ${code}`);
      assert.equal((inPreview.state as { confirming: boolean }).confirming, false);
      assert.equal(inPreview.sent.length, 0);

      // After the launch was sent.
      const launching = run(toPreviewShown(preview({ trusted: true })));
      const inLaunch = run(
        [{ type: 'roleRejected', msg: rejected(code, `why ${code}`) }],
        launching.state,
      );
      assert.equal(inLaunch.state.step, 'preview');
      assert.equal((inLaunch.state as { error: string }).error, `why ${code}`);
      assert.equal(inLaunch.sent.length, 0);
    }
  });

  test('roleRejected while idle is ignored', () => {
    const { state, sent } = run([{ type: 'roleRejected', msg: rejected('untrusted') }]);
    assert.equal(state.step, 'idle');
    assert.equal(sent.length, 0);
  });

  test('stale replies for another Directory or Role are ignored', () => {
    const requested = run(toPreviewRequested);

    const otherDir = run(
      [
        {
          type: 'rolePreview',
          msg: preview({ directoryPath: OTHER_DIR }),
          bypassPermissions: false,
        },
      ],
      requested.state,
    );
    assert.equal(otherDir.state, requested.state);
    assert.equal(otherDir.sent.length, 0);

    const otherRole = run(
      [
        {
          type: 'rolePreview',
          msg: preview({ roleId: 'backend.md', trusted: true }),
          bypassPermissions: false,
        },
      ],
      requested.state,
    );
    assert.equal(otherRole.state, requested.state);
    assert.equal(otherRole.sent.length, 0);

    const staleRoles = run(
      [{ type: 'rolesAvailable', msg: { ...roles, directoryPath: OTHER_DIR } }],
      run([{ type: 'begin', directoryPath: DIR }]).state,
    );
    assert.equal((staleRoles.state as { roles: unknown }).roles, null);
  });

  test('a roleConfirmed for another role, Directory or hash does not launch', () => {
    const confirming = run([...toPreviewShown(), { type: 'confirm' }]);
    for (const msg of [
      confirmed({ roleId: 'backend.md' }),
      confirmed({ directoryPath: OTHER_DIR }),
      confirmed({ sha256: NEW_SHA }),
    ]) {
      const result = run([{ type: 'roleConfirmed', msg }], confirming.state);
      assert.equal(result.state, confirming.state);
      assert.equal(result.sent.length, 0);
    }
  });

  test('a duplicate preview does not replace what the operator is reading', () => {
    const shown = run(toPreviewShown());
    const dup = run(
      [
        {
          type: 'rolePreview',
          msg: preview({ sha256: NEW_SHA, trusted: true }),
          bypassPermissions: false,
        },
      ],
      shown.state,
    );
    assert.equal(dup.state, shown.state);
    assert.equal(dup.sent.length, 0);
  });

  test('a late preview after cancel or no-role launch does nothing', () => {
    const cancelled = run([...toPreviewRequested, { type: 'cancel' }]);
    const late = run(
      [{ type: 'rolePreview', msg: preview({ trusted: true }), bypassPermissions: false }],
      cancelled.state,
    );
    assert.equal(late.state.step, 'idle');
    assert.equal(late.sent.length, 0);
  });

  test('confirm twice sends one confirmRole', () => {
    const { sent } = run([...toPreviewShown(), { type: 'confirm' }, { type: 'confirm' }]);
    assert.equal(sent.filter((m) => m.type === 'confirmRole').length, 1);
  });

  test('the agent that carries the role name ends the flow; others do not', () => {
    const launching = run(toPreviewShown(preview({ trusted: true })));
    const other = run([{ type: 'agentCreated', roleName: undefined }], launching.state);
    assert.equal(other.state.step, 'launching');
    const mine = run([{ type: 'agentCreated', roleName: 'frontend' }], launching.state);
    assert.equal(mine.state.step, 'idle');
  });

  test('back returns to the role list; cancel closes', () => {
    const shown = run(toPreviewShown());
    assert.equal(run([{ type: 'back' }], shown.state).state.step, 'choose');
    assert.equal(run([{ type: 'cancel' }], shown.state).state.step, 'idle');
  });

  test('roleNameOf strips the .md suffix; previewLineCount counts lines', () => {
    assert.equal(roleNameOf('frontend.md'), 'frontend');
    assert.equal(previewLineCount(''), 0);
    assert.equal(previewLineCount('a'), 1);
    assert.equal(previewLineCount('a\nb\n'), 2);
    assert.equal(previewLineCount('a\n\nb'), 3);
  });
});

describe('role picker availability', () => {
  test('VS Code (not a browser runtime) and read-only clients get no role picker', () => {
    assert.equal(rolePickerAvailable(false, false), false); // VS Code panel
    assert.equal(rolePickerAvailable(false, true), false);
    assert.equal(rolePickerAvailable(true, true), false); // read-only standalone
    assert.equal(rolePickerAvailable(true, false), true); // privileged standalone
  });

  test('the modal renders nothing while idle', () => {
    const html = renderToStaticMarkup(
      createElement(RoleLaunchModal, {
        state: ROLE_LAUNCH_IDLE,
        bypassPermissions: false,
        onPickRole: () => {},
        onPickNoRole: () => {},
        onConfirm: () => {},
        onBack: () => {},
        onCancel: () => {},
      }),
    );
    assert.equal(html, '');
  });
});

describe('role preview is plain text', () => {
  const hostile =
    '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[link](javascript:alert(1)) **bold** <U+202E>\n& "quoted"';

  test('HTML and markdown in the content are rendered as inert text', () => {
    const html = renderToStaticMarkup(
      createElement(RolePreviewText, { preview: preview({ content: hostile }) }),
    );
    // No element was created from the content.
    assert.equal(/<script/i.test(html), false);
    assert.equal(/<img/i.test(html), false);
    assert.equal(/<a[\s>]/i.test(html), false);
    assert.equal(/<strong|<b>|<em/i.test(html), false);
    // The text itself is there, escaped.
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('[link](javascript:alert(1)) **bold**'));
    // The host's visible escape marker passes through untouched.
    assert.ok(html.includes('&lt;U+202E&gt;'));
    // Line breaks are kept and long lines wrap.
    assert.ok(html.includes('whitespace-pre-wrap'));
    assert.ok(html.includes('data-testid="role-preview-content"'));
  });

  test('the line count is shown', () => {
    const html = renderToStaticMarkup(
      createElement(RolePreviewText, { preview: preview({ content: 'a\nb\nc' }) }),
    );
    assert.ok(html.includes('3 lines'));
  });

  test('the modal shows hostile content as text through the whole preview step', () => {
    const state: RoleLaunchState = {
      step: 'preview',
      directoryPath: DIR,
      roleId: ROLE,
      roles: roles.roles,
      preview: preview({ content: hostile }),
      confirming: false,
      error: null,
    };
    const html = renderToStaticMarkup(
      createElement(RoleLaunchModal, {
        state,
        bypassPermissions: false,
        onPickRole: () => {},
        onPickNoRole: () => {},
        onConfirm: () => {},
        onBack: () => {},
        onCancel: () => {},
      }),
    );
    assert.equal(/<script/i.test(html), false);
    assert.equal(/<img/i.test(html), false);
    assert.ok(html.includes('data-testid="role-confirm"'));
  });

  test('no role UI source can inject HTML', () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
    for (const file of [
      'components/RoleLaunchModal.tsx',
      'hooks/useRoleLaunch.ts',
      'roleLaunch.ts',
      'agentRoles.tsx',
      'components/AgentCard.tsx',
    ]) {
      const source = readFileSync(path.join(srcDir, file), 'utf8');
      assert.equal(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/.test(source),
        false,
        file,
      );
      assert.equal(
        /from '(marked|react-markdown|markdown-it|remark[^']*)'/.test(source),
        false,
        file,
      );
    }
  });
});

describe('role name on the agent card', () => {
  const card = (agentId: number, names: Record<number, string>) =>
    renderToStaticMarkup(
      createElement(
        AgentRoleNamesProvider,
        { value: names },
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

  test('the card and its tooltip show the Role name', () => {
    const html = card(7, { 7: 'frontend' });
    assert.ok(html.includes('title="Agent 7 - Role: frontend"'));
    assert.ok(html.includes('data-testid="agent-card-role"'));
    assert.ok(html.includes('>frontend<'));
  });

  test('an agent without a Role looks as before', () => {
    const html = card(7, { 8: 'frontend' });
    assert.ok(html.includes('title="Agent 7"'));
    assert.equal(html.includes('agent-card-role'), false);
    assert.equal(agentCardTitle(7, undefined), 'Agent 7');
  });

  test('role names are collected from agentCreated and existingAgents', () => {
    assert.deepEqual(withAgentRoleName({}, 3, 'frontend'), { 3: 'frontend' });
    assert.deepEqual(withAgentRoleName({ 1: 'a' }, 3, undefined), { 1: 'a' });
    assert.deepEqual(mergeAgentRoleNames({ 1: 'a' }, { '2': 'b', '3': 'c' }), {
      1: 'a',
      2: 'b',
      3: 'c',
    });
    assert.deepEqual(mergeAgentRoleNames({ 1: 'a' }, undefined), { 1: 'a' });
  });
});

describe('protocol role name field (pattern and maxLength)', () => {
  const yaml = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/asyncapi.yaml'),
    'utf8',
  );
  const block = /^ {4}RoleName:\n(?<body>(?: {6}.*\n| *\n)+)/m.exec(yaml)?.groups?.body ?? '';
  const pattern = /pattern: '(?<p>[^']+)'/.exec(block)?.groups?.p ?? '';
  const maxLength = Number(/maxLength: (?<n>\d+)/.exec(block)?.groups?.n);

  test('the schema declares a pattern and maxLength', () => {
    assert.notEqual(pattern, '');
    assert.equal(maxLength, 64);
  });

  test('valid names pass; invalid names are refused', () => {
    const re = new RegExp(pattern);
    const accepts = (name: string) => re.test(name) && name.length <= maxLength;
    for (const ok of ['frontend', 'a', 'Back_end-2', 'v1.2', 'x'.repeat(64)]) {
      assert.equal(accepts(ok), true, ok);
    }
    for (const bad of [
      '',
      '.hidden',
      '-lead',
      'a/b',
      'a b',
      '../x',
      'front\nend',
      'é',
      'x'.repeat(65),
      'a.md\u0000',
    ]) {
      assert.equal(accepts(bad), false, JSON.stringify(bad));
    }
  });
});
