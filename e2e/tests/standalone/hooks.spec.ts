import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import {
  ourHookEvents,
  sendHookEvent,
  sessionEndExit,
  sessionStartStartup,
} from '../../helpers/hooks';
import { advanceIntroToConsentStep, finishIntro } from '../../helpers/intro';
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
});

/**
 * The standalone consent path end to end. The fixture normally seeds a granted Claude consent; these opt out, so the
 * CLI starts with nothing installed and the server asks over the tokened /ws handshake — the SAME in-app dialog the
 * VS Code webview shows (pinned in claude/hooks-on/consent.spec.ts). Here the pins are the standalone-only halves:
 * the token boundary and the checkbox route.
 */
test.describe('Standalone / hooks consent', () => {
  test.use({ seedHooksConsent: false });

  function readConsentFrom(tmpHome: string): boolean {
    try {
      const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
      const consent = (JSON.parse(raw) as { hooksConsent?: Record<string, string> }).hooksConsent;
      return consent?.claude === 'granted';
    } catch {
      return false;
    }
  }

  function ourHookEventCount(tmpHome: string): number {
    return ourHookEvents(tmpHome).length;
  }

  // The operator's route: the printed tokened URL loads a privileged session,
  // the Intro rides the handshake, and Install (on its consent step) writes
  // the hooks.
  test('the tokened page shows the Intro and Install writes the hooks @area:standalone', async ({
    page,
    standalone,
  }) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await advanceIntroToConsentStep(dialog);
    // The disclosure travels with the request — the browser renders the
    // server's exact terms.
    await expect(dialog).toContainText('~/.claude/settings.json');
    await expect(dialog).toContainText('Instant Detection (Hooks)');

    expect(fs.existsSync(path.join(standalone.tmpHome, '.claude', 'settings.json'))).toBe(false);

    await dialog.getByRole('button', { name: 'Install Hooks' }).click();

    await expect.poll(() => readConsentFrom(standalone.tmpHome), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => ourHookEventCount(standalone.tmpHome), { timeout: 15_000 }).toBe(12);

    // The install's own hooksStatus broadcast must not yank the closing step.
    await finishIntro(dialog);
  });

  // The token boundary, at the browser level: a bare-URL session still watches
  // the office but is never asked — its answer would be ignored
  // (server/__tests__/httpServerWs.test.ts pins the wire half), so showing it
  // the dialog would be a lie.
  test('an untokened spectator page never sees the consent dialog @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    const bareUrl = new URL(page.url());
    bareUrl.search = '';

    const spectator = await page.context().newPage();
    try {
      await spectator.goto(bareUrl.toString());
      await expect(spectator.getByRole('button', { name: 'Settings' })).toBeVisible({
        timeout: 30_000,
      });
      // Settle before the negative assertion: the dialog, were it coming,
      // rides the webviewReady handshake that just completed.
      await spectator.waitForTimeout(2_000);
      await expect(spectator.getByRole('dialog')).toHaveCount(0);
    } finally {
      await spectator.close();
    }
  });

  /**
   * The Settings-checkbox route, for a user who dismissed the dialog: Not Now
   * writes nothing, the checkbox shows the ACTUAL install state (not the
   * hooksEnabled preference, which still defaults true), and clicking it is
   * the consent grant.
   */
  test('the hooks checkbox reflects install state and its click is the consent grant @area:standalone', async ({
    page,
    standalone,
  }) => {
    const settingsPath = path.join(standalone.tmpHome, '.claude', 'settings.json');

    // First-run Intro is up; decline with Not Now — which writes NOTHING —
    // and finish the tour.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await advanceIntroToConsentStep(dialog);
    await dialog.getByRole('button', { name: 'Not Now' }).click();
    await finishIntro(dialog);
    await page.waitForTimeout(1_000);

    // Nothing installed, no consent — but the preference defaults true.
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(readConsentFrom(standalone.tmpHome)).toBe(false);

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

    // Clicking it IS the consent grant (the documented route after a decline).
    await hooksCheckbox.click();

    await expect.poll(() => readConsentFrom(standalone.tmpHome), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => ourHookEventCount(standalone.tmpHome), { timeout: 15_000 }).toBe(12);
    await expect.poll(() => isChecked(), { timeout: 15_000 }).toBe(true);
  });
});
