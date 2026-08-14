import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent } from '../../helpers/hooks';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

/**
 * Drives the web (REST) hook provider entirely over HTTP -- curl-equivalent
 * `sendHookEvent` calls against `POST /api/hooks/web` -- while Playwright
 * observes spawn/move/despawn in a real browser. This is the plan's primary
 * proof that the provider abstraction works for a non-Claude backend.
 *
 * Exercises all 8 in-scope `AgentEvent` kinds from docs/web-provider-plan.md
 * Phase 2a's coverage table: sessionStart, toolStart, toolEnd, subagentStart,
 * subagentEnd, turnEnd, permissionRequest, sessionEnd.
 *
 * `sendHookEvent` is the same helper `standalone/hooks.spec.ts` uses for
 * Claude, targeted at the "web" provider id instead -- the sanctioned direct
 * hook-endpoint call for standalone tests (see e2e/README.md's "Mocking model
 * & rules"), one level more literally here since curl really is the client
 * for this provider. See docs/web-provider-plan.md Phase 8.
 */
test.describe('Standalone / web provider', () => {
  test('drives an agent end-to-end over HTTP with no CLI, transcript, or terminal @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      watchAllSessions: true,
    });
    await standalone.drainMessages();

    const sessionId = 'standalone-web-provider-test-session';

    // 1. sessionStart (with cwd) -- no overlay yet. Proves the pending-session
    // behaviour (Phase 3) also holds for the web provider. Settle wait before
    // the negative assertion, mirroring standalone/hooks.spec.ts.
    await sendHookEvent(
      standalone.hookServerConfig,
      { session_id: sessionId, hook_event_name: 'sessionStart', cwd: standalone.workspaceDir },
      'web',
    );
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);

    // 2. toolStart (confirming event) -- the agent spawns. `isHeadless` itself
    // is always false in standalone/browser runtime by design (useExtensionMessages.ts:
    // `isExternal === true && !isBrowserRuntime` -- there are no terminals at all in
    // standalone, so "headless" has no meaning there; see CLAUDE.md). The
    // ghost-rendering verification for externally-adopted agents belongs to the
    // VS Code suite (claude/hooks-on/basic.spec.ts), not this standalone spec.
    await sendHookEvent(
      standalone.hookServerConfig,
      {
        session_id: sessionId,
        hook_event_name: 'toolStart',
        tool_id: 't1',
        tool_name: 'Build',
        status: 'Building release artifact',
      },
      'web',
    );
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Building release artifact');
    const toolStartMessages = await standalone.drainMessages();
    expect(toolStartMessages.some((m) => m.type === 'agentCreated')).toBe(true);
    const toolStart = toolStartMessages.find(
      (m): m is RecordedServerMessage & { type: 'agentToolStart' } => m.type === 'agentToolStart',
    );
    expect(toolStart).toBeTruthy();
    expect(toolStartMessages.some((m) => m.type === 'agentStatus' && m.status === 'active')).toBe(
      true,
    );

    // 3. A second toolStart/toolEnd pair with a different tool_name -- the
    // status label updates.
    await sendHookEvent(
      standalone.hookServerConfig,
      { session_id: sessionId, hook_event_name: 'toolEnd', tool_id: 't1' },
      'web',
    );
    await sendHookEvent(
      standalone.hookServerConfig,
      {
        session_id: sessionId,
        hook_event_name: 'toolStart',
        tool_id: 't2',
        tool_name: 'Deploy',
        status: 'Deploying to staging',
      },
      'web',
    );
    await expectOverlayVisible(page, 'Deploying to staging');

    // 4. subagentStart/subagentEnd -- a sub-agent character spawns next to
    // the parent and despawns on completion.
    await sendHookEvent(
      standalone.hookServerConfig,
      {
        session_id: sessionId,
        hook_event_name: 'subagentStart',
        parent_tool_id: 't2',
        tool_id: 'sub-1',
        tool_name: 'Worker',
      },
      'web',
    );
    await expectOverlayCount(page, 2);
    const subagentMessages = await standalone.drainMessages();
    expect(subagentMessages.some((m) => m.type === 'subagentToolStart')).toBe(true);

    await sendHookEvent(
      standalone.hookServerConfig,
      {
        session_id: sessionId,
        hook_event_name: 'subagentEnd',
        parent_tool_id: 't2',
        tool_id: 'sub-1',
      },
      'web',
    );
    await expectOverlayCount(page, 1);

    // 5. turnEnd (awaiting_input=true) -- the agent goes idle waiting on the
    // user, covering the 8th and final in-scope AgentEvent kind.
    await sendHookEvent(
      standalone.hookServerConfig,
      { session_id: sessionId, hook_event_name: 'turnEnd', tool_id: 't2', awaiting_input: true },
      'web',
    );
    await expectOverlayVisible(page, 'Waiting for input');
    const turnEndMessages = await standalone.drainMessages();
    expect(turnEndMessages.some((m) => m.type === 'agentToolsClear')).toBe(true);
    expect(turnEndMessages.some((m) => m.type === 'agentStatus' && m.status === 'waiting')).toBe(
      true,
    );

    // 6. permissionRequest -- permission bubble.
    await sendHookEvent(
      standalone.hookServerConfig,
      { session_id: sessionId, hook_event_name: 'permissionRequest' },
      'web',
    );
    await expectOverlayVisible(page, 'Needs approval');

    // 7. sessionEnd -- despawn.
    await sendHookEvent(
      standalone.hookServerConfig,
      { session_id: sessionId, hook_event_name: 'sessionEnd', reason: 'exit' },
      'web',
    );
    await expectOverlayCount(page, 0);
    const sessionEndMessages = await standalone.drainMessages();
    expect(sessionEndMessages.some((m) => m.type === 'agentClosed')).toBe(true);
  });
});
