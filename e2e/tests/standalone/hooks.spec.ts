import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { sendHookEvent, sessionEndExit, sessionStartStartup } from '../../helpers/hooks';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

test.describe('Standalone / hooks', () => {
  test('propagates hook-driven lifecycle into the browser UI @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'standalone-hooks-test-session';
    const filePath = path.join(standalone.workspaceDir, 'demo.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    // Settle wait before the negative assertion: SessionStart only stages a
    // pending session, so no overlay should appear. Without the wait,
    // toHaveCount(0) passes instantly just because the overlay has not been
    // created yet, which would not actually prove SessionStart stays invisible.
    // See e2e/helpers/office.ts wait-strategy conventions (negative assertion).
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);

    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Reading demo.ts');
    const preToolMessages = await standalone.drainMessages();
    const toolStart = preToolMessages.find(
      (message): message is RecordedServerMessage & { type: 'agentToolStart' } =>
        message.type === 'agentToolStart',
    );
    expect(preToolMessages.some((message) => message.type === 'agentCreated')).toBe(true);
    expect(toolStart).toBeTruthy();
    expect(
      preToolMessages.some(
        (message) => message.type === 'agentStatus' && message.status === 'active',
      ),
    ).toBe(true);

    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PermissionRequest',
    });
    await expectOverlayVisible(page, 'Needs approval');
    const permissionMessages = await standalone.drainMessages();
    expect(permissionMessages.some((message) => message.type === 'agentToolPermission')).toBe(true);

    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
    });
    const postToolMessages = await standalone.drainMessages();
    expect(
      postToolMessages.some(
        (message) =>
          message.type === 'agentToolDone' &&
          message.toolId === toolStart?.toolId &&
          message.id === toolStart?.id,
      ),
    ).toBe(true);
    await expectOverlayVisible(page, 'Needs approval');

    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    await expectOverlayVisible(page, 'Waiting for input');
    const notificationMessages = await standalone.drainMessages();
    expect(notificationMessages.some((message) => message.type === 'agentToolsClear')).toBe(true);
    expect(
      notificationMessages.some(
        (message) => message.type === 'agentStatus' && message.status === 'waiting',
      ),
    ).toBe(true);

    await sendHookEvent(standalone.hookServerConfig, sessionEndExit(sessionId));
    await expectOverlayCount(page, 0);
    const sessionEndMessages = await standalone.drainMessages();
    expect(sessionEndMessages.some((message) => message.type === 'agentClosed')).toBe(true);
  });
});
