import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/pixel-agents';
import { preToolUseBash, sessionStartStartup } from '../../helpers/hooks';
import {
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectNoOverlay, expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { launchStandalone } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

function hookDrivenScenario(name: string, command: string) {
  return claudeScenario(name)
    .at(50)
    .emitHook(
      sessionStartStartup('{{sessionId}}', '{{cwd}}', '{{transcriptPath}}') as Record<
        string,
        unknown
      >,
    )
    .at(100)
    .emitHook(preToolUseBash('{{sessionId}}', command) as Record<string, unknown>)
    .exitAt(500)
    .build();
}

test.describe('Standalone / multi-server hooks', () => {
  test('extension and standalone both stay hook-driven without cross-contamination @area:standalone', async ({
    page,
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir: extensionWorkspace, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: false,
      debugView: false,
    });

    const standalone = await launchStandalone(page, { homeDir: tmpHome });
    try {
      await setSettings(page, {
        alwaysShowLabels: true,
        hooksEnabled: true,
        watchAllSessions: false,
        debugView: false,
      });
      await standalone.drainMessages();
      await waitForClaudeHookSetup(tmpHome);

      const registryDir = path.join(tmpHome, '.pixel-agents', 'servers');
      await expect
        .poll(
          () => {
            try {
              return fs.readdirSync(registryDir).filter((file) => file.endsWith('.json')).length;
            } catch {
              return 0;
            }
          },
          { message: 'Expected one embedded and one standalone registry entry' },
        )
        .toBe(2);

      const extensionSessionId = 'multi-server-extension-owned';
      const extensionCommand = 'npm run extension-owned';
      await spawnExternalClaudeScenario({
        tmpHome,
        workspaceDir: extensionWorkspace,
        mockLogFile,
        sessionId: extensionSessionId,
        scenario: hookDrivenScenario('multi-server extension-owned session', extensionCommand),
      });

      await expectOverlayVisible(frame, `Running: ${extensionCommand}`);
      await page.waitForTimeout(500);
      await expectNoOverlay(page, `Running: ${extensionCommand}`);

      const standaloneSessionId = 'multi-server-standalone-owned';
      const standaloneCommand = 'npm run standalone-owned';
      await spawnExternalClaudeScenario({
        tmpHome,
        workspaceDir: standalone.workspaceDir,
        mockLogFile,
        sessionId: standaloneSessionId,
        scenario: hookDrivenScenario('multi-server standalone-owned session', standaloneCommand),
      });

      await expectOverlayVisible(page, `Running: ${standaloneCommand}`);
      await frame.waitForTimeout(500);
      await expectNoOverlay(frame, `Running: ${standaloneCommand}`);

      await expectOverlayCount(frame, 1);
      await expectOverlayCount(page, 1);
    } finally {
      await standalone.cleanup();
    }
  });
});
