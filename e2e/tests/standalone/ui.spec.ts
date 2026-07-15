import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import type { TestHooksWindow } from '../../helpers/editor';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { buildSeedLayout } from '../../helpers/layout-seed';
import {
  closeAgentFromOverlay,
  expectOverlayCount,
  expectOverlayVisible,
} from '../../helpers/office';
import { openSettingsModal, setSettings } from '../../helpers/webview';

// The DebugView diagnostics block polls every 2s (see DebugView.tsx); allow a
// few polling rounds plus IPC/render slop.
const DIAGNOSTICS_POLL_TIMEOUT_MS = 15_000;
// onReloadAssets does its filesystem work after the externalAssetDirectoriesUpdated
// reply, so the re-broadcast lands slightly later than the dir-list update.
const ASSET_RELOAD_TIMEOUT_MS = 15_000;
// WebSocketTransport reconnects with capped exponential backoff (up to 4s);
// allow a couple of retry cycles for the state to settle both ways.
const CONNECTION_STATE_TIMEOUT_MS = 15_000;

test.describe('Standalone / UI', () => {
  test('closeAgent despawns the character @area:standalone', async ({ page, standalone }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'standalone-close-agent-session';
    const filePath = path.join(standalone.workspaceDir, 'close-agent.ts');

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

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Reading close-agent.ts');
    await standalone.drainMessages();

    await closeAgentFromOverlay(page, { text: 'Reading close-agent.ts' });

    await expectOverlayCount(page, 0);
    const messages = await standalone.drainMessages();
    expect(messages.some((message) => message.type === 'agentClosed')).toBe(true);
  });

  test('Debug View renders JSONL diagnostics in standalone @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      debugView: true,
      hooksEnabled: true,
      watchAllSessions: true,
      alwaysShowLabels: true,
    });

    const sessionId = 'standalone-debug-view-session';
    const filePath = path.join(standalone.workspaceDir, 'debug-view.ts');

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

    // Presence of the diagnostics block (either branch) is the proof that the
    // agentDiagnostics reply reached the webview via transport.onMessage; do
    // not assert a specific jsonlExists branch (a hook-only session may or may
    // not have a materialized transcript file).
    await expect(page.getByText(/JSONL (connected|not found)/)).toBeVisible({
      timeout: DIAGNOSTICS_POLL_TIMEOUT_MS,
    });
  });

  test('adding an external asset directory triggers a live asset reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    await standalone.drainMessages();

    await modal
      .locator('input[placeholder="Absolute asset directory path"]')
      .fill(standalone.workspaceDir);
    await modal.locator('button', { hasText: 'Add' }).click();

    // getByTitle matches the title attribute literally; a raw CSS
    // [title="..."] selector would mis-parse the backslashes in a Windows path
    // as CSS escapes and never match its own title.
    await expect(modal.getByTitle(standalone.workspaceDir, { exact: true })).toBeVisible();

    // Light depth: prove the onReloadAssets re-broadcast fired, not a
    // character-count delta (no fixture PNGs staged in workspaceDir).
    await expect
      .poll(
        async () => {
          const messages = await standalone.drainMessages();
          return messages.some((message) => message.type === 'characterSpritesLoaded');
        },
        { timeout: ASSET_RELOAD_TIMEOUT_MS },
      )
      .toBe(true);
  });

  test('browser Export Layout downloads the layout file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    const modal = await openSettingsModal(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      modal.locator('button', { hasText: 'Export Layout' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('pixel-agents-layout.json');
  });

  test('browser Import Layout applies the chosen file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const uniqueLabel = `Imported Area ${Date.now().toString()}`;
    const layout = buildSeedLayout({
      areas: [{ label: uniqueLabel, color: '#4287f5' }],
      areaTiles: [{ col: 1, row: 1, label: uniqueLabel }],
    });
    const tmpFile = path.join(os.tmpdir(), `pixel-agents-import-${Date.now().toString()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(layout));

    try {
      const modal = await openSettingsModal(page);
      // Set the hidden import input directly rather than clicking "Import
      // Layout" (which would open the OS file dialog Playwright can't drive).
      await page.setInputFiles('input[type="file"]', tmpFile);
      await expect(modal).toBeHidden();

      // saveLayout is client→server and unrecorded by drainMessages (Seam A),
      // so assert the applied OfficeState instead of the wire message.
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? [],
          ),
        )
        .toContainEqual({ label: uniqueLabel, color: '#4287f5' });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test('ConnectionIndicator appears when the WebSocket connection drops @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    // Settle wait before the negative assertion (office.ts wait-strategy
    // convention): give the runtime a chance to render the indicator wrongly
    // before checking absence.
    await page.waitForTimeout(500);
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0);

    // Fallback for assumption A1: `page.context().setOffline(true)` does not
    // reliably close an already-open WebSocket on this Chromium build (verified
    // empirically — the indicator never appeared). Stopping the real host
    // process closes the socket from the server side instead.
    await standalone.stopHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toBeVisible({
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });

    await standalone.startHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0, {
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });
  });
});
