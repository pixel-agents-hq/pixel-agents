import fs from 'fs';
import path from 'path';

import type { Page } from '@playwright/test';

import { getExternalNarrationLogPath } from './external-monitor';

/**
 * Test-action narrator: the yellow `[test]` voice in every VS Code run video.
 *
 * The narrator writes one line per action taken / assertion verified to a
 * per-test log (`<tmpHome>/.claude-mock/test-narration.log`). That log is
 * displayed on two surfaces, both merely tailing the file:
 *   - the fixture's "e2e monitor" terminal (opened once per test), and
 *   - every mock-claude terminal tab (its wrapper backgrounds a headerless
 *     tail so the story shows even when an agent tab takes focus).
 *
 * Two ways to narrate:
 *   - the fixture exposes the handle `setNarrationContext` returns as
 *     `narrator` on the pixelAgents payload — tests call `narrator.step()` /
 *     `narrator.check()`;
 *   - `narrate` (module-level, same handle) lets shared helpers narrate
 *     universal moments (e.g. spawning an agent) without threading the handle
 *     through 60+ call sites. It no-ops until the fixture sets a context.
 *
 * STRICTLY COSMETIC. Pixel Agents never reads terminal output (its inputs are
 * JSONL transcripts and hook POSTs), so no assertion may depend on narration —
 * deleting every step()/check() call must leave all tests passing. Every
 * failure here is swallowed. The suite runs with workers:1, so the single
 * module-level context cannot cross-contaminate tests.
 */

const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const NARRATION_COMPLETE = '[test] ■ narration complete';

export interface TestNarrator {
  /** Narrate an action the test is about to take. */
  step(message: string): void;
  /** Narrate an assertion that has just been verified. */
  check(message: string): void;
}

/** Per-test narration context, set by the fixture and cleared in teardown. */
let context: { logPath: string; startedAt: number } | null = null;

export function getTestNarrationLogPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'test-narration.log');
}

function write(line: string): void {
  if (!context) return; // no-op until the fixture registers a context
  try {
    fs.appendFileSync(context.logPath, line);
  } catch {
    // cosmetic — never fail the test over narration
  }
}

function stamp(): string {
  if (!context) return '';
  return `${DIM}[+${((Date.now() - context.startedAt) / 1000).toFixed(1)}s]${RESET}`;
}

/**
 * Module-level narrator. Shared helpers import this and narrate freely; the
 * fixture also returns this exact handle from setNarrationContext so tests and
 * helpers write to the same per-test log. No-op when no context is set.
 */
export const narrate: TestNarrator = {
  step: (message) => write(`${stamp()} ${YELLOW}[test]${RESET} ▸ ${message}\n`),
  check: (message) => write(`${stamp()} ${YELLOW}[test]${RESET} ${GREEN}✓${RESET} ${message}\n`),
};

/**
 * Begin narration for a test. Touches the log file (so the tails have a file to
 * follow immediately) and starts the relative-timestamp clock. Returns the
 * module-level narrator for the fixture to expose. Called by the pixelAgents
 * fixture at setup, before use().
 */
export function setNarrationContext(tmpHome: string): TestNarrator {
  const logPath = getTestNarrationLogPath(tmpHome);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch {
    // cosmetic — a missing log just means empty narration
  }
  context = { logPath, startedAt: Date.now() };
  return narrate;
}

/** End narration for a test. Called by the fixture in teardown. */
export function clearNarrationContext(): void {
  context = null;
}

/**
 * Keep the recorded window alive until its visible terminal has rendered the
 * final narration line. This runs only after the test body, so narration never
 * gates an action or assertion. Failures remain cosmetic.
 */
export async function finishNarration(window: Page): Promise<void> {
  if (!context) return;

  try {
    const visibleRows = window.locator('.xterm:visible .xterm-rows');
    if ((await visibleRows.count()) === 0) return;

    write(`${stamp()} ${DIM}${NARRATION_COMPLETE}${RESET}\n`);
    await visibleRows
      .filter({ hasText: NARRATION_COMPLETE })
      .last()
      .waitFor({ state: 'visible', timeout: 1_500 });

    // Let Chromium paint the rendered line before Playwright closes the
    // recorded Electron window. Frame-based, not an arbitrary timer.
    await window.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  } catch (error) {
    console.warn(
      `[e2e] final narration did not render before cleanup (cosmetic, continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Open the always-on "e2e monitor" terminal (an editor tab, like all fixture
 * terminals). It tails BOTH the test log (yellow) and the external log
 * (magenta) so every test — even one with no agents — has a narrated surface
 * from the first action. Cosmetic: any failure is swallowed and the test
 * proceeds with no monitor.
 *
 * Opened after VS Code finishes restoring the review layout and before any
 * agent terminal exists. Deliberately NO tab focus/click juggling — that
 * interaction class broke heuristic terminal↔agent tracking.
 */
export async function openMonitorTerminal(window: Page, tmpHome: string): Promise<void> {
  try {
    const testLog = getTestNarrationLogPath(tmpHome);
    const externalLog = getExternalNarrationLogPath(tmpHome);
    // Touch both logs so the tail has files to follow immediately.
    fs.mkdirSync(path.dirname(testLog), { recursive: true });
    if (!fs.existsSync(testLog)) fs.writeFileSync(testLog, '');
    if (!fs.existsSync(externalLog)) fs.writeFileSync(externalLog, '');

    // Move focus out of the auto-shown webview, then use the isolated profile's
    // direct Create New Terminal keybinding. This avoids the command palette's
    // guaranteed 300 ms delay and the former fixed 1 s shell-start sleep.
    const statusBox = await window
      .locator('.part.statusbar')
      .boundingBox()
      .catch(() => null);
    if (statusBox) {
      await window.mouse.click(
        statusBox.x + statusBox.width / 2,
        statusBox.y + statusBox.height / 2,
      );
    }
    const terminalRows = window.locator('.xterm:visible .xterm-rows').last();
    await window.keyboard.press('F8');
    await terminalRows.waitFor({ state: 'visible', timeout: 5_000 });
    await terminalRows.filter({ hasText: /\S/ }).waitFor({ state: 'visible', timeout: 5_000 });

    const tailScript = path.join(__dirname, '..', 'fixtures', 'tail-follow.cjs');
    const invoke = `"${process.execPath}" "${tailScript}" monitor "${testLog}" "${externalLog}"`;
    // PowerShell (Windows default profile) needs the call operator for a
    // quoted executable path; POSIX shells execute quoted paths directly.
    const terminalInput = window.locator('.xterm:visible textarea.xterm-helper-textarea').last();
    await terminalInput.focus();
    await window.keyboard.insertText(process.platform === 'win32' ? `& ${invoke}` : invoke);
    await window.keyboard.press('Enter');
  } catch (error) {
    console.warn(
      `[e2e] monitor terminal failed to open (cosmetic, continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
