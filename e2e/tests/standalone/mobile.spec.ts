import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';

/**
 * The standalone mobile shell on a phone-sized touch viewport: office and
 * terminal as sliding pages, the agent-card bar along the bottom, the >_ /
 * Office toggle, the edge swipe, and tap-to-open links in the terminal.
 *
 * Touch-driven, so it uses Playwright's real touch input (`tap()` with
 * hasTouch) — except the edge swipe, which needs a multi-step drag that
 * Playwright's touchscreen API can't express; that one dispatches the same
 * TouchEvent sequence a finger produces (`swipe` below). The terminal is the
 * real PTY running the mock claude (e2e/README.md "Mocking model & rules").
 */

const PHONE = { width: 390, height: 844 };

/** The page currently showing, read off the view toggle's title. */
async function expectView(page: Page, view: 'office' | 'terminal') {
  await expect(
    page.getByTitle(view === 'office' ? 'Show terminal' : 'Show office', { exact: true }),
  ).toBeVisible();
}

/** A horizontal one-finger drag from (x0, y) to (x1, y), as TouchEvents
 *  dispatched on whatever element sits under the starting point. */
async function swipe(page: Page, x0: number, x1: number, y: number) {
  await page.evaluate(
    ({ x0, x1, y }) => {
      const target = document.elementFromPoint(x0, y);
      if (!target) throw new Error('nothing under the swipe start');
      const touchAt = (x: number) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
      const fire = (type: string, x: number, down: boolean) => {
        const t = touchAt(x);
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: down ? [t] : [],
            targetTouches: down ? [t] : [],
            changedTouches: [t],
          }),
        );
      };
      fire('touchstart', x0, true);
      const steps = 8;
      for (let i = 1; i <= steps; i++) fire('touchmove', x0 + ((x1 - x0) * i) / steps, true);
      fire('touchend', x1, false);
    },
    { x0, x1, y },
  );
}

test.describe('Standalone / mobile shell', () => {
  // Same POSIX-only PTY launch as the terminal spec (the .cmd mock shim is
  // untested under a server-side PTY on Windows).
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({
    hasTouch: true,
    isMobile: true,
    standaloneOptions: { mockClaude: true, viewport: PHONE },
  });

  test('phone shell: + card launches and slides to the terminal; toggle, card taps and edge swipe navigate @area:mobile', async ({
    page,
    standalone,
  }) => {
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mobile shell launch').holdOpenFor(60_000).build(),
    );

    // The mobile shell, not the desktop one: no bottom toolbar, a launch card.
    await expect(page.getByRole('button', { name: 'Layout' })).toHaveCount(0);
    const launch = page.getByTitle('Launch agent', { exact: true });
    await expect(launch).toBeVisible();
    await expectView(page, 'office');

    // + launches, and the shell slides over once the terminal appears.
    await launch.tap();
    const card = page.getByTitle('Agent 1', { exact: true });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expectView(page, 'terminal');
    await expect(page.locator('.xterm').first()).toContainText('mock claude session', {
      timeout: 15_000,
    });

    // The toggle goes back to the office…
    await page.getByTitle('Show office', { exact: true }).tap();
    await expectView(page, 'office');

    // …where a card tap is two-step: the first focuses the character, a
    // repeat tap on the focused agent opens its terminal.
    await card.tap();
    await expectView(page, 'office');
    await card.tap();
    await expectView(page, 'terminal');

    // Edge swipe from the left edge, rightwards: back to the office.
    await swipe(page, 4, PHONE.width * 0.8, PHONE.height / 2);
    await expectView(page, 'office');

    // And from the right edge, leftwards: to the terminal again.
    await swipe(page, PHONE.width - 4, PHONE.width * 0.2, PHONE.height / 2);
    await expectView(page, 'terminal');
  });

  test('tapping a URL in the terminal opens it @area:mobile', async ({ page, standalone }) => {
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mobile link tap').holdOpenFor(60_000).build(),
    );
    await page.getByTitle('Launch agent', { exact: true }).tap();
    const terminal = page.locator('.xterm').first();
    await expect(terminal).toContainText('mock claude session', { timeout: 15_000 });

    // Put a URL on screen through the PTY's own echo.
    await terminal.tap();
    const url = 'https://example.com/pixel-agents-tap';
    await page.keyboard.type(url);
    const row = page.locator('.xterm-rows > div', { hasText: url }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Tap the middle of the URL text — a tap there opens it, it doesn't
    // just focus the terminal.
    const box = await row.boundingBox();
    if (!box) throw new Error('URL row has no box');
    const rowText = (await row.textContent()) ?? '';
    const charW = box.width / Math.max(1, rowText.length);
    const urlMid = rowText.indexOf(url) + url.length / 2;
    const popup = page.waitForEvent('popup');
    await page.touchscreen.tap(box.x + charW * urlMid, box.y + box.height / 2);
    expect((await popup).url()).toContain('pixel-agents-tap');
  });
});
