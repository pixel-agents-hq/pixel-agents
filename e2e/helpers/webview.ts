import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Settings/modal helpers work the same against a VS Code webview iframe
 * (Frame) and the standalone browser page (Page) — both expose Playwright's
 * Locator API. The settings UI is the same React component in both contexts.
 */
type WebviewSurface = Frame | Page;

const WEBVIEW_TIMEOUT_MS = 30_000;
const PANEL_OPEN_TIMEOUT_MS = 15_000;
const MIN_PANEL_HEIGHT_PX = 320;

export interface WebviewSettings {
  watchAllSessions?: boolean;
  hooksEnabled?: boolean;
  alwaysShowLabels?: boolean;
  debugView?: boolean;
}

async function runCommand(window: Page, command: string): Promise<void> {
  // Retry the full command palette interaction up to 3 times.
  // macOS CI can swallow keypresses or fail to populate results.
  //
  // Why keyboard automation instead of a direct API call: VS Code's
  // `vscode.commands.executeCommand` lives in the renderer's workbench,
  // not on globalThis, and is not exposed to Playwright's window.evaluate.
  // Electron's app.evaluate only reaches the main process. So we drive the
  // quick-pick via key events and accept the retry cost on flaky CI.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Dismiss any previous quick-input state
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    let phase = 'open';
    try {
      phase = 'open';
      await window.keyboard.press('F1');
      await window.waitForSelector('.quick-input-widget .quick-input-filter input', {
        state: 'visible',
        timeout: 5_000,
      });
      phase = 'type';
      await window.keyboard.type(command);
      // Wait for a list row matching the typed command (not stale results)
      phase = 'list';
      await window.waitForSelector(`.quick-input-list .monaco-list-row[aria-label*="${command}"]`, {
        timeout: 5_000,
      });
      // Success: log a flake warning when we needed more than one attempt so CI
      // surfaces the timing problem before it turns into a hard failure.
      if (attempt > 1) {
        console.warn(`[e2e] runCommand("${command}") succeeded on attempt ${attempt}`);
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[e2e] runCommand("${command}") attempt ${attempt} failed at phase=${phase}: ${message}`,
      );
      if (attempt === 3) {
        throw new Error(
          `Command palette failed after 3 attempts for "${command}" (last phase=${phase}): ${message}`,
        );
      }
    }
  }
  // Guard against TypeScript flow-narrowing forgetting the loop exit path.
  if (lastError) throw lastError;

  await window.keyboard.press('Enter');
  await window
    .waitForSelector('.quick-input-widget', {
      state: 'hidden',
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
      // Some commands update layout without immediately dismissing quick input.
    });
}

async function getPanelHeight(window: Page): Promise<number> {
  return window.evaluate(() => {
    const panel =
      document.querySelector<HTMLElement>('[id="workbench.panel.bottom"]') ??
      document.querySelector<HTMLElement>('.part.panel');

    return Math.round(panel?.getBoundingClientRect().height ?? 0);
  });
}

async function ensurePanelIsLarge(window: Page): Promise<void> {
  if ((await getPanelHeight(window)) > MIN_PANEL_HEIGHT_PX) {
    return;
  }

  await runCommand(window, 'View: Toggle Maximized Panel');

  await expect
    .poll(() => getPanelHeight(window), {
      message: 'Expected the bottom panel to be resized for the Pixel Agents webview',
      timeout: PANEL_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(MIN_PANEL_HEIGHT_PX);
}

/**
 * Open the Pixel Agents panel via the Command Palette and wait for the
 * "Pixel Agents: Show Panel" command to execute.
 */
/**
 * Close the bottom panel. Triggers onDidChangeVisibility(false) on every
 * WebviewView hosted there; since PixelAgentsViewProvider does NOT set
 * retainContextWhenHidden, the webview is disposed and resolveWebviewView
 * is called fresh when the panel reopens. Used by the restored-agents test to exercise
 * the existingAgents restore path without a destructive iframe reload.
 *
 * Toggle (rather than Close) is used because the literal command name varies
 * by VS Code locale/version; "View: Toggle Panel" is stable. Caller must
 * ensure the panel is currently open before calling (it will be after a
 * preceding openPixelAgentsPanel + spawn flow).
 */
export async function closeBottomPanel(window: Page): Promise<void> {
  await runCommand(window, 'View: Toggle Panel');
  await window.waitForTimeout(800);
}

export async function openPixelAgentsPanel(window: Page): Promise<void> {
  await runCommand(window, 'Pixel Agents: Show Panel');

  // Wait for the panel container to appear
  await window
    .waitForSelector('[id="workbench.panel.bottom"], .part.panel', {
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
      // Panel might not use this id; just continue
    });

  await ensurePanelIsLarge(window);
}

/**
 * Find and return the Pixel Agents webview frame.
 *
 * VS Code renders WebviewViewProvider content in an <iframe> whose URL
 * starts with "vscode-webview://". Because VS Code can have multiple
 * webviews, we wait until one frame exposes the "+ Agent" button before
 * returning it.
 */
export async function getPixelAgentsFrame(window: Page): Promise<Frame> {
  let foundFrame: Frame | null = null;

  await expect
    .poll(
      async () => {
        for (const frame of window.frames()) {
          if (!frame.url().startsWith('vscode-webview://')) continue;
          // count() resolves immediately (no waiting); a non-zero count means
          // this is the Pixel Agents frame.
          const buttonCount = await frame.locator('button', { hasText: '+ Agent' }).count();
          if (buttonCount > 0) {
            foundFrame = frame;
            return true;
          }
        }
        return false;
      },
      {
        message: 'Pixel Agents webview frame with "+ Agent" button not found',
        timeout: WEBVIEW_TIMEOUT_MS,
        intervals: [250, 500, 1000],
      },
    )
    .toBe(true);

  if (!foundFrame) {
    throw new Error('Internal error: poll succeeded but foundFrame is null');
  }
  return foundFrame;
}

/**
 * Click "+ Agent" in the webview and wait for the call to be dispatched.
 */
export async function clickAddAgent(frame: Frame): Promise<void> {
  const btn = frame.locator('button', { hasText: '+ Agent' });
  await expect(btn).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await btn.click();
}

async function setCheckbox(modal: Locator, label: string, checked: boolean): Promise<void> {
  const button = modal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });

  const indicator = button.locator('span').last();
  const isChecked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  if (isChecked !== checked) {
    await button.click();
  }
}

async function openSettingsModal(frame: WebviewSurface): Promise<Locator> {
  const settingsButton = frame.locator('button', { hasText: 'Settings' });
  await expect(settingsButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await settingsButton.click();

  const settingsModal = frame
    .locator('div.fixed')
    .filter({ has: frame.getByText('Settings', { exact: true }) });
  await expect(settingsModal).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return settingsModal;
}

async function closeSettingsModal(settingsModal: Locator): Promise<void> {
  const closeButton = settingsModal.getByRole('button', { name: 'x', exact: true });
  await expect(closeButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await closeButton.click();
  await expect(settingsModal).toBeHidden({ timeout: WEBVIEW_TIMEOUT_MS });
}

/**
 * Read the checked state of a Settings modal toggle without changing it.
 * Used by the settings-persistence test to assert state survives a panel reload.
 */
export async function getSettingChecked(frame: WebviewSurface, label: string): Promise<boolean> {
  const settingsModal = await openSettingsModal(frame);
  const button = settingsModal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  const indicator = button.locator('span').last();
  const checked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  await closeSettingsModal(settingsModal);
  return checked;
}

export async function setSettings(frame: WebviewSurface, settings: WebviewSettings): Promise<void> {
  const settingsModal = await openSettingsModal(frame);

  if (settings.watchAllSessions !== undefined) {
    await setCheckbox(settingsModal, 'Watch All Sessions', settings.watchAllSessions);
  }
  if (settings.hooksEnabled !== undefined) {
    await setCheckbox(settingsModal, 'Instant Detection (Hooks)', settings.hooksEnabled);
  }
  if (settings.alwaysShowLabels !== undefined) {
    await setCheckbox(settingsModal, 'Always Show Labels', settings.alwaysShowLabels);
  }
  if (settings.debugView !== undefined) {
    await setCheckbox(settingsModal, 'Debug View', settings.debugView);
  }

  await closeSettingsModal(settingsModal);

  // Allow the extension host to process settings updates before the test continues.
  await frame.waitForTimeout(500);
}

/**
 * Enable the settings needed for the hook-server e2e assertions:
 * - Watch All Sessions, so hooks-only external sessions are adopted
 * - Always Show Labels, so the normal office view exposes stable overlay text
 */
export async function configureHookServerTestSettings(frame: WebviewSurface): Promise<void> {
  await setSettings(frame, {
    watchAllSessions: true,
    hooksEnabled: true,
    alwaysShowLabels: true,
    debugView: false,
  });
}
