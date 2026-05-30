import { test as base, expect } from '@playwright/test';
import type { Frame, Page, TestInfo } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { applyAllureLabels } from '../helpers/allure-labels';
import { launchVSCode, type VSCodeSession, waitForWorkbench } from '../helpers/launch';
import { killTrackedExternalProcesses } from '../helpers/mock-claude';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

const ATTACH_VIDEOS_ON_SUCCESS = process.env['PIXEL_AGENTS_E2E_ATTACH_VIDEOS_ON_SUCCESS'] === '1';

export interface PixelAgentsContext {
  session: VSCodeSession;
  window: Page;
  frame: Frame;
  tmpHome: string;
  workspaceDir: string;
  mockLogFile: string;
}

async function attachTextFileIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return;
    await testInfo.attach(name, {
      body: fs.readFileSync(filePath, 'utf8'),
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

function shouldAttachRunVideo(testInfo: TestInfo): boolean {
  return ATTACH_VIDEOS_ON_SUCCESS || testInfo.status !== 'passed';
}

function removeDirIfExists(dirPath: string | undefined): void {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Artifact cleanup failures are non-fatal in teardown.
  }
}

export const test = base.extend<{
  pixelAgents: PixelAgentsContext;
  _allureLabels: void;
}>({
  // Auto-fixture: tag every test with Allure epic + feature derived from its
  // @area: annotation and enclosing describe path. Runs before pixelAgents.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  pixelAgents: async ({}, use, testInfo) => {
    const session = await launchVSCode(testInfo.title);
    const { window, tmpHome, workspaceDir, mockLogFile } = session;
    const runVideo = window.video();

    try {
      await waitForWorkbench(window);
      await openPixelAgentsPanel(window);
      const frame = await getPixelAgentsFrame(window);

      await use({
        session,
        window,
        frame,
        tmpHome,
        workspaceDir,
        mockLogFile,
      });
    } finally {
      // Only attach debug artifacts (logs, screenshot, video) for failing tests
      // — or when --attach-videos-on-success is set. On a green run these are
      // pure noise and bloat the hosted Allure report (a per-test screenshot
      // alone is ~85 KB × 48 tests × 3 platforms). `shouldAttachRunVideo` is the
      // single shared predicate so all artifacts travel together.
      const keepArtifacts = shouldAttachRunVideo(testInfo);

      if (keepArtifacts) {
        await attachTextFileIfExists(
          testInfo,
          'mock-claude-invocations',
          mockLogFile,
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'mock-claude-actions',
          path.join(tmpHome, '.claude-mock', 'actions.log'),
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'launch-log',
          path.join(tmpHome, '.claude-mock', 'launch.log'),
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'server-json',
          path.join(tmpHome, '.pixel-agents', 'server.json'),
          'application/json',
        );
        // Diagnostic: server-side hook/broadcast log (gated by PIXEL_AGENTS_DEBUG_LOG
        // env var set in launchVSCode). Lets CI failure analysis see the exact
        // server-side event timeline without local repro.
        await attachTextFileIfExists(
          testInfo,
          'pixel-agents-debug-log',
          path.join(tmpHome, '.pixel-agents', 'debug.log'),
          'text/plain',
        );
        // Webview-side counterpart: every transport message the webview's
        // useExtensionMessages handler actually processed. Pair with the
        // server log above to see whether the failure is server (event not
        // broadcast) or webview (broadcast not received / out-of-order).
        try {
          const wvFrames = window.frames();
          for (const f of wvFrames) {
            if (!f.url().startsWith('vscode-webview://')) continue;
            const log = await f.evaluate(() => window.__pixelAgentsTestHooks?.messageLog ?? null);
            if (log) {
              await testInfo.attach('webview-message-log', {
                body: JSON.stringify(log, null, 2),
                contentType: 'application/json',
              });
              break;
            }
          }
        } catch {
          // Webview already disposed during cleanup or window unreachable — non-fatal.
        }

        try {
          const screenshotPath = testInfo.outputPath('final-screenshot.png');
          await window.screenshot({ path: screenshotPath });
          await testInfo.attach('final-screenshot', {
            path: screenshotPath,
            contentType: 'image/png',
          });
        } catch {
          // Screenshot failures are non-fatal in teardown.
        }
      }

      const attachRunVideo = runVideo !== null && shouldAttachRunVideo(testInfo);
      // Kill any leaked mock-claude processes spawned via spawnExternalClaudeScenario
      // BEFORE tearing down the session (and deleting tmpHome). Otherwise leaked
      // processes accumulate across the suite and add real environmental pressure.
      await killTrackedExternalProcesses();
      await session.cleanup();

      if (attachRunVideo && runVideo) {
        try {
          const videoPath = testInfo.outputPath('run-video.webm');
          await runVideo.saveAs(videoPath);
          await testInfo.attach('run-video', {
            path: videoPath,
            contentType: 'video/webm',
          });
        } catch {
          // Video attachment failures are non-fatal in teardown.
        }
      } else {
        removeDirIfExists(session.videoDir);
      }
    }
  },
});

export { expect };
