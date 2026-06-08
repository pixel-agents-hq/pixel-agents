import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { launchVSCode, waitForWorkbench } from '../helpers/launch';
import { clickAddAgent, getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

test('clicking + Agent spawns mock codex and creates a JSONL session file', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title, { agentEngine: 'codex' });
  const { window, tmpHome, mockLogFile } = session;

  test.setTimeout(120_000);

  try {
    await waitForWorkbench(window);
    await openPixelAgentsPanel(window);
    const frame = await getPixelAgentsFrame(window);
    await clickAddAgent(frame);

    await expect
      .poll(
        () => {
          try {
            return fs.readFileSync(mockLogFile, 'utf8').trim().length > 0;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const sessionsRoot = path.join(tmpHome, '.codex', 'sessions');
    const jsonlFiles: string[] = [];
    function collectJsonl(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectJsonl(full);
        else if (entry.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    }
    collectJsonl(sessionsRoot);
    expect(jsonlFiles.length).toBeGreaterThan(0);
  } finally {
    await session.cleanup();
  }
});
