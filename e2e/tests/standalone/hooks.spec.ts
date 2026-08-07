import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionEndExit, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';

test.describe('Standalone / hooks', () => {
  test('propagates hook-driven lifecycle into the browser UI @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      watchAllSessions: true,
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

  /**
   * The standalone consent path end to end.
   *
   * The fixture spawns the CLI without a TTY and without seeded consent, so the
   * first-run prompt is skipped and NOTHING is installed — while the
   * `hooksEnabled` preference still defaults to true. That divergence is
   * exactly what the checkbox used to lie about: it read "on" over an
   * untouched ~/.claude/settings.json. It must now show the ACTUAL install
   * state, and clicking it must be the consent grant.
   */
  test('the hooks checkbox reflects install state and its click is the consent grant @area:standalone', async ({
    page,
    standalone,
  }) => {
    const settingsPath = path.join(standalone.tmpHome, '.claude', 'settings.json');
    const configPath = path.join(standalone.tmpHome, '.pixel-agents', 'config.json');
    const readConsent = (): boolean => {
      try {
        return (
          (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hooksConsentGiven?: boolean })
            .hooksConsentGiven === true
        );
      } catch {
        return false;
      }
    };
    const ourHookEventCount = (): number => {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
          hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
        };
        return Object.values(settings.hooks ?? {}).filter((entries) =>
          (entries ?? []).some((entry) =>
            (entry.hooks ?? []).some((h) =>
              h.command?.includes('.pixel-agents/hooks/claude-hook.js'),
            ),
          ),
        ).length;
      } catch {
        return 0;
      }
    };

    // Nothing installed, no consent — but the preference defaults true.
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(readConsent()).toBe(false);

    // Everything below drives ONE open modal: the checkbox is clicked
    // UNCONDITIONALLY rather than through setSettings(), whose setCheckbox only
    // clicks when the current state differs from the target — if a hooksStatus
    // ever raced ahead, that would click nothing and every assertion below
    // would pass vacuously over a state this test never caused.
    const settingsModal = await openSettingsModal(page);
    const hooksCheckbox = settingsModal.locator('button', {
      hasText: 'Instant Detection (Hooks)',
    });
    const isChecked = async (): Promise<boolean> =>
      ((await hooksCheckbox.locator('span').last().textContent()) ?? '').trim().toLowerCase() ===
      'x';

    expect(await isChecked()).toBe(false);

    // Clicking it IS the consent grant (the documented non-TTY route).
    await hooksCheckbox.click();

    await expect.poll(() => readConsent(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => ourHookEventCount(), { timeout: 15_000 }).toBe(12);
    await expect.poll(() => isChecked(), { timeout: 15_000 }).toBe(true);
  });
});
