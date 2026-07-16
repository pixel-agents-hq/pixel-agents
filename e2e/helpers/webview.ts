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

export async function runCommand(window: Page, command: string, attempts = 3): Promise<void> {
  // Retry the full command palette interaction up to 3 times.
  // macOS CI can swallow keypresses or fail to populate results.
  //
  // Why keyboard automation instead of a direct API call: VS Code's
  // `vscode.commands.executeCommand` lives in the renderer's workbench,
  // not on globalThis, and is not exposed to Playwright's window.evaluate.
  // Electron's app.evaluate only reaches the main process. So we drive the
  // quick-pick via key events and accept the retry cost on flaky CI.
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
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
      if (attempt === attempts) {
        throw new Error(
          `Command palette failed after ${attempts} attempts for "${command}" (last phase=${phase}): ${message}`,
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
  // Use the default Toggle Panel chord (⌘J / Ctrl+J) instead of the command
  // palette: the palette's fuzzy match can select the wrong command — typing
  // "View: Toggle Panel" is a subsequence of "View: Toggle MAXIMIZED Panel",
  // which maximizes instead of closing and leaves the webview alive. Chords
  // need workbench (not webview) focus, so click the empty status-bar middle
  // first (same trick as arrangeReviewLayout).
  const statusBox = await window
    .locator('.part.statusbar')
    .boundingBox()
    .catch(() => null);
  if (statusBox) {
    await window.mouse.click(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
  }
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+J' : 'Control+J');
  // Wait until the Pixel Agents webview is actually DESTROYED, not merely
  // hidden. VS Code disposes a hidden WebviewView lazily; returning on a
  // fixed sleep lets a quick reopen re-show the SAME webview context, which
  // breaks tests whose premise is a fresh webview (e.g. restored-agents reads
  // the fresh context's addAgentLog). The old fixed 800ms only worked because
  // the reopen path used to be slow enough to mask this.
  await expect
    .poll(
      async () => {
        for (const frame of window.frames()) {
          if (!frame.url().startsWith('vscode-webview://')) continue;
          try {
            if ((await frame.locator('button', { hasText: '+ Agent' }).count()) > 0) return true;
          } catch {
            // Frame detached mid-check — treat as gone.
          }
        }
        return false;
      },
      {
        message: 'Expected the Pixel Agents webview to be disposed after closing the panel',
        timeout: 15_000,
      },
    )
    .toBe(false);
}

/**
 * Reopen the bottom panel with the same ⌘J/Ctrl+J toggle closeBottomPanel
 * used. Compared to openPixelAgentsPanel (palette "Show Panel" plus a
 * possible "Toggle Maximized Panel" resize), the chord restores the panel
 * exactly as it was — no command-palette overlays in the run video. Caller
 * must have closed the panel with closeBottomPanel first, and should follow
 * with getPixelAgentsFrame(window) to wait for the fresh webview.
 */
export async function reopenBottomPanel(window: Page): Promise<void> {
  const statusBox = await window
    .locator('.part.statusbar')
    .boundingBox()
    .catch(() => null);
  if (statusBox) {
    await window.mouse.click(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
  }
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+J' : 'Control+J');
}

/**
 * Single-shot (non-waiting) check for the Pixel Agents webview frame.
 *
 * The iframe must be VISIBLE, not merely attached: after the panel is hidden
 * (View: Toggle Panel), VS Code keeps the dying webview's iframe in the DOM
 * briefly. Matching it would hand callers a stale frame whose state (e.g.
 * addAgentLog) belongs to the previous webview lifetime — the restored-agents
 * test reads a fresh webview's log and MUST NOT see the old one.
 */
async function findPixelAgentsFrameOnce(window: Page): Promise<Frame | null> {
  for (const frame of window.frames()) {
    if (!frame.url().startsWith('vscode-webview://')) continue;
    try {
      // count() resolves immediately (no waiting); a non-zero count means
      // this is the Pixel Agents frame.
      const buttonCount = await frame.locator('button', { hasText: '+ Agent' }).count();
      if (buttonCount === 0) continue;
      const frameElement = await frame.frameElement();
      const box = await frameElement.boundingBox();
      await frameElement.dispose();
      if (!box || box.width < 10 || box.height < 10) continue;
      return frame;
    } catch {
      // Frame detached mid-check (webview being disposed) — not a match.
      continue;
    }
  }
  return null;
}

export async function openPixelAgentsPanel(
  window: Page,
  opts: { autoShown?: boolean } = {},
): Promise<void> {
  // If the view is already showing (single non-waiting check), there is
  // nothing to open — mid-test callers hit this when the view never got
  // hidden (terminals open as editor tabs now; see launch.ts).
  //
  // autoShown: the seeded pixel-agents.autoShowPanel setting (see
  // e2e/helpers/launch.ts) focuses the view on activation, so at fixture
  // setup the webview surfaces without any command-palette interaction. Poll
  // for it and fall back to the palette only if it never appears. Mid-test
  // callers reopening a deliberately closed panel skip the poll (the view
  // won't auto-show again) and go straight to the palette.
  let shown = (await findPixelAgentsFrameOnce(window)) !== null;
  if (!shown && opts.autoShown) {
    const deadline = Date.now() + PANEL_OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await findPixelAgentsFrameOnce(window)) {
        shown = true;
        break;
      }
      await window.waitForTimeout(250);
    }
    if (!shown) {
      console.warn(
        '[e2e] autoShowPanel did not surface the webview in time; falling back to the command palette',
      );
    }
  }
  if (!shown) {
    await runCommand(window, 'Pixel Agents: Show Panel');
  }

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

const PANEL_WIDTH_FRACTION = 2 / 3;
const PANEL_WIDTH_TOLERANCE_PX = 48;

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  winW: number;
}

async function getPanelRect(window: Page): Promise<PanelRect | null> {
  return window.evaluate(() => {
    const panel =
      document.querySelector<HTMLElement>('[id="workbench.parts.panel"]') ??
      document.querySelector<HTMLElement>('.part.panel');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, winW: globalThis.innerWidth };
  });
}

/**
 * Arrange the workbench into the run-video layout: Pixel Agents panel (docked
 * left via workbench.panel.defaultLocation, see launch.ts) at ~2/3 window
 * width, editor area (terminal tabs) in the remaining third, primary and
 * secondary side bars hidden. Called once per test by the pixelAgents fixture
 * right after the panel is shown.
 *
 * Side-bar visibility has no settings key, so hide-by-toggle with the default
 * chords, gated on a DOM visibility check (a toggle without the check could
 * SHOW a bar that started hidden). The panel resize drags the vertical sash
 * at the panel's right edge; sash hit-testing is ±px sensitive, so retry with
 * small offsets and verify by re-measuring.
 */
export async function arrangeReviewLayout(window: Page): Promise<void> {
  const isDarwin = process.platform === 'darwin';

  const isPartVisible = (selector: string): Promise<boolean> =>
    window.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el !== null && el.offsetWidth > 0;
    }, selector);

  const hidePartIfVisible = async (selector: string, chord: string): Promise<boolean> => {
    if (!(await isPartVisible(selector))) return false;
    await window.keyboard.press(chord);
    await window.waitForTimeout(200);
    return true;
  };

  // Suppress VS Code notification toasts (e.g. "All installed extensions are
  // temporarily disabled" from --disable-extensions) for the whole session —
  // they pop up at arbitrary times and overlap the recording. This hides only
  // workbench chrome; webview-internal product toasts are unaffected, and no
  // test asserts on VS Code notifications.
  await window.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.notifications-toasts { display: none !important; }';
    document.head.appendChild(style);
  });

  const dragPanelToTarget = async (): Promise<boolean> => {
    const rect = await getPanelRect(window);
    if (!rect) return true;
    const targetWidth = Math.round(rect.winW * PANEL_WIDTH_FRACTION);
    if (Math.abs(rect.width - targetWidth) <= PANEL_WIDTH_TOLERANCE_PX) return true;
    const y = rect.y + Math.min(200, rect.height / 2);
    for (const offset of [0, -2, 2, -4, 4]) {
      const start = await getPanelRect(window);
      if (!start) return true;
      await window.mouse.move(start.x + start.width + offset, y);
      await window.mouse.down();
      await window.mouse.move(start.x + targetWidth, y, { steps: 8 });
      await window.mouse.up();
      await window.waitForTimeout(150);
      const after = await getPanelRect(window);
      if (after && Math.abs(after.width - targetWidth) <= PANEL_WIDTH_TOLERANCE_PX) return true;
    }
    return false;
  };

  // VS Code restores the side bars asynchronously during startup, so a single
  // hide pass can run before they mount (and a late-restored sidebar also
  // shifts the panel/editor widths). Verify-and-repair until one pass finds
  // nothing to fix, requiring at least one clean verification round.
  let arranged = false;
  for (let round = 0; round < 5; round++) {
    await window.waitForTimeout(round === 0 ? 400 : 250);
    let touched = false;
    // The hide chords need workbench (not webview) focus: webviews forward
    // only a whitelist of keybindings, and autoShowPanel leaves focus inside
    // the Pixel Agents webview. Clicking the empty middle of the status bar
    // moves focus to workbench chrome without triggering any action.
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
    if (await hidePartIfVisible('.part.sidebar', isDarwin ? 'Meta+B' : 'Control+B')) {
      touched = true;
    }
    if (await hidePartIfVisible('.part.auxiliarybar', isDarwin ? 'Alt+Meta+B' : 'Control+Alt+B')) {
      touched = true;
    }
    if (!(await dragPanelToTarget())) touched = true;
    if (!touched) {
      arranged = true;
      break;
    }
  }
  if (!arranged) {
    console.warn('[e2e] arrangeReviewLayout: layout did not settle after repair rounds');
  }
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
        foundFrame = await findPixelAgentsFrameOnce(window);
        return foundFrame !== null;
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

export async function openSettingsModal(frame: WebviewSurface): Promise<Locator> {
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
 * Enable Watch All Sessions so hooks-only external sessions are adopted.
 * (Always Show Labels and hooks are already on via the fixture-seeded
 * config.json and the product default — see e2e/helpers/launch.ts.)
 */
export async function configureHookServerTestSettings(frame: WebviewSurface): Promise<void> {
  await setSettings(frame, {
    watchAllSessions: true,
  });
}
