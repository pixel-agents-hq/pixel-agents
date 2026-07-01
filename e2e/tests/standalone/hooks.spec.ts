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

  test('shows agent activity in the detail panel @area:standalone', async ({
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

    const sessionId = 'standalone-activity-test-session';
    const filePath = path.join(standalone.workspaceDir, 'demo.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    // Give the server time to process the hook and broadcast agentActivity to the browser.
    await page.waitForTimeout(300);

    // Live activity broadcast reached the browser.
    const afterTool = await standalone.drainMessages();
    expect(afterTool.some((m) => m.type === 'agentActivity')).toBe(true);

    // Project label appears under the character (folderName = basename(workspaceDir)).
    const projectName = path.basename(standalone.workspaceDir);
    await expect(page.locator('[data-testid="project-label"]').first()).toHaveText(projectName);

    // Overview row exists; clicking it opens the detail view + requests history.
    const row = page.locator('[data-testid="agent-overview-row"]').first();
    await expect(row).toBeVisible();
    await row.click();

    await expect(page.locator('[data-testid="agent-detail-header"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="activity-entry"]').filter({ hasText: 'Reading demo.ts' }).first(),
    ).toBeVisible();

    // Give the agentActivityHistory round-trip time to complete before draining.
    await page.waitForTimeout(300);
    const afterSelect = await standalone.drainMessages();
    expect(afterSelect.some((m) => m.type === 'agentActivityHistory')).toBe(true);

    // Divider drag changes the panel height.
    const panel = page.locator('[data-testid="agent-detail-panel"]');
    const before = (await panel.boundingBox())?.height ?? 0;
    const divider = page.locator('[data-testid="detail-panel-divider"]');
    const box = await divider.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 80);
      await page.mouse.up();
    }
    const after = (await panel.boundingBox())?.height ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});
