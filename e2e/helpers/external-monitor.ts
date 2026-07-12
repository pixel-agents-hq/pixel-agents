import fs from 'fs';
import path from 'path';

import type { Page } from '@playwright/test';

import { runCommand } from './webview';

/**
 * Makes external mock-claude sessions self-narrate inside the recorded window.
 *
 * External sessions are detached processes Pixel Agents ADOPTS (never
 * launches), so unlike internal agents they have no terminal to narrate into.
 * Instead their stdout (magenta `[external·tag]` lines — visually distinct
 * from the internal cyan `[mock-claude]` style) is appended to a per-test log,
 * and the first external spawn in a test opens a "monitor" terminal in the
 * editor area tailing that log, so run videos show the step-by-step timeline.
 *
 * Strictly cosmetic: every failure here is swallowed and no assertion may
 * depend on the monitor — Pixel Agents never reads terminal output (its
 * inputs are JSONL transcripts and hook POSTs).
 *
 * The fixture registers the window per test (setExternalMonitorContext); the
 * suite runs with workers:1, so module state cannot cross-contaminate tests.
 */

let context: { window: Page; tmpHome: string } | null = null;
let openedForTmpHome: string | null = null;

export function getExternalNarrationLogPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'external-narration.log');
}

export function setExternalMonitorContext(window: Page, tmpHome: string): void {
  context = { window, tmpHome };
  openedForTmpHome = null;
}

export function clearExternalMonitorContext(): void {
  context = null;
  openedForTmpHome = null;
}

/** Open the monitor terminal once per test, lazily, on first external spawn. */
export async function ensureExternalMonitorOpen(tmpHome: string): Promise<void> {
  if (!context || context.tmpHome !== tmpHome) return;
  if (openedForTmpHome === tmpHome) return;
  // Mark attempted up front: one shot per test, never a retry loop of UI churn.
  openedForTmpHome = tmpHome;

  const { window } = context;
  try {
    // Touch the log so the tail has a file immediately.
    const logPath = getExternalNarrationLogPath(tmpHome);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');

    // Remember whether an internal Claude Code terminal tab is showing so we
    // can hand focus back afterwards — in mixed internal+external tests the
    // internal narration keeps the foreground, matching pre-monitor videos.
    const claudeTab = window.getByText(/Claude Code #\d+/).first();
    const hadClaudeTab = await claudeTab.isVisible().catch(() => false);

    // Opens as an editor tab (terminal.integrated.defaultLocation=editor) and
    // focuses the new terminal's shell.
    await runCommand(window, 'Terminal: Create New Terminal');
    await window.waitForTimeout(1_000); // let the shell start before typing

    const tailScript = path.join(__dirname, '..', 'fixtures', 'tail-follow.cjs');
    const invoke = `"${process.execPath}" "${tailScript}" "${logPath}"`;
    // PowerShell (Windows default profile) needs the call operator for a
    // quoted executable path; POSIX shells execute quoted paths directly.
    await window.keyboard.type(process.platform === 'win32' ? `& ${invoke}` : invoke);
    await window.keyboard.press('Enter');

    if (hadClaudeTab) {
      await claudeTab.click().catch(() => undefined);
    }
  } catch (error) {
    console.warn(
      `[e2e] external-session monitor failed to open (cosmetic, continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
