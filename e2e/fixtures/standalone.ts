import fs from 'node:fs';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import { applyAllureLabels } from '../helpers/allure-labels';
import {
  launchStandalone,
  type LaunchStandaloneOptions,
  type StandaloneSession,
} from '../helpers/standalone';

export interface StandaloneContext extends StandaloneSession {}

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

async function attachText(
  testInfo: TestInfo,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  try {
    if (body.length === 0) return;
    await testInfo.attach(name, {
      body,
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

export const test = base.extend<{
  standalone: StandaloneContext;
  standaloneOptions: LaunchStandaloneOptions;
  _allureLabels: void;
}>({
  // Per-test host options (e.g. extra CLI flags, mock claude on PATH). Override
  // with test.use({ standaloneOptions: {...} }) in a describe block.
  standaloneOptions: [{}, { option: true }],
  // Auto-fixture: tag every test with Allure epic + feature derived from its
  // @area: annotation and enclosing describe path. Runs before standalone.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  standalone: async ({ page, standaloneOptions }, use, testInfo) => {
    const standalone = await launchStandalone(page, standaloneOptions);

    try {
      await use(standalone);
    } finally {
      await attachText(testInfo, 'standalone-host-log', standalone.getHostLogs(), 'text/plain');
      await attachTextFileIfExists(
        testInfo,
        'server-json',
        path.join(standalone.tmpHome, '.pixel-agents', 'server.json'),
        'application/json',
      );
      // Only ever written when the host launched a mock claude (mockClaude: true).
      await attachTextFileIfExists(
        testInfo,
        'mock-claude-invocations',
        standalone.mockLogFile,
        'text/plain',
      );

      try {
        const screenshotPath = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('final-screenshot', {
          path: screenshotPath,
          contentType: 'image/png',
        });
      } catch {
        // Screenshot failures are non-fatal in teardown.
      }

      await standalone.cleanup();
    }
  },
});

export { expect };
