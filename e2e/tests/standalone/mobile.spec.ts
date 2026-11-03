import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

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

/** The + card opens the launch drawer; the launch itself is a tap on the
 *  host-contributed Directory (the workspace the server started in). */
async function launchFromCard(page: Page, workspaceDir: string) {
  await page.getByTitle('Launch agent', { exact: true }).tap();
  await page.getByRole('button', { name: path.basename(workspaceDir), exact: true }).tap();
}

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

type Pt = { x: number; y: number };

/** A two-finger gesture on the office canvas: both fingers land at `from`,
 *  move in steps to `to`, and lift — as TouchEvents on the canvas. */
async function twoFingerGesture(page: Page, from: [Pt, Pt], to: [Pt, Pt]) {
  await page.evaluate(
    ({ from, to }) => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('no office canvas');
      const touches = (pts: Pt[]) =>
        pts.map(
          (p, i) => new Touch({ identifier: i + 1, target: canvas, clientX: p.x, clientY: p.y }),
        );
      const fire = (type: string, down: Touch[], changed: Touch[]) =>
        canvas.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: down,
            targetTouches: down,
            changedTouches: changed,
          }),
        );
      const first = touches(from);
      fire('touchstart', [first[0]], [first[0]]);
      fire('touchstart', first, [first[1]]);
      const steps = 8;
      let last = first;
      for (let i = 1; i <= steps; i++) {
        last = touches(
          from.map((f, k) => ({
            x: f.x + ((to[k].x - f.x) * i) / steps,
            y: f.y + ((to[k].y - f.y) * i) / steps,
          })),
        );
        fire('touchmove', last, last);
      }
      fire('touchend', [last[0]], [last[1]]);
      fire('touchend', [], [last[0]]);
    },
    { from, to },
  );
}

const cameraFollowId = (page: Page) =>
  page.evaluate(() => window.__pixelAgentsTestHooks?.getCameraFollowId?.() ?? null);

/** A one-finger press held for `ms` at (x, y), as TouchEvents dispatched on
 *  the element under the point (Playwright's touchscreen can only tap). */
async function longPress(page: Page, x: number, y: number, ms: number) {
  const fire = (type: string, down: boolean) =>
    page.evaluate(
      ({ x, y, type, down }) => {
        const target = document.elementFromPoint(x, y);
        if (!target) throw new Error('nothing under the press');
        const t = new Touch({ identifier: 7, target, clientX: x, clientY: y });
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: down ? [t] : [],
            targetTouches: down ? [t] : [],
            changedTouches: [t],
          }),
        );
      },
      { x, y, type, down },
    );
  await fire('touchstart', true);
  await page.waitForTimeout(ms);
  await fire('touchend', false);
}

/** A real one-finger press held for `ms` on the middle of `target`, through
 *  CDP so the page also gets the pointer events a finger produces (the
 *  TouchEvent-only `longPress` above has none). */
async function heldTouch(page: Page, target: Locator, ms: number) {
  // A trial tap waits for the target to stop moving (the roster slides in).
  await target.tap({ trial: true });
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to press');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Launch a mock-claude session from the + card and wait for its terminal. */
async function launchTerminal(
  page: Page,
  standalone: { tmpHome: string; workspaceDir: string },
  name: string,
) {
  await arrangeNextClaudeInvocation(
    standalone.tmpHome,
    claudeScenario(name).holdOpenFor(60_000).build(),
  );
  await launchFromCard(page, standalone.workspaceDir);
  const terminal = page.locator('.xterm').first();
  await expect(terminal).toContainText('mock claude session', { timeout: 15_000 });
  return terminal;
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
    await launchFromCard(page, standalone.workspaceDir);
    const card = page.getByTitle('Agent 1', { exact: true });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expectView(page, 'terminal');
    await expect(page.locator('.xterm').first()).toContainText('mock claude session', {
      timeout: 15_000,
    });

    // The roster's arrow is there on the terminal page too.
    await expect(page.getByRole('button', { name: 'Roster', exact: true })).toBeVisible();

    // The toggle goes back to the office…
    await page.getByTitle('Show office', { exact: true }).tap();
    await expectView(page, 'office');

    // …where a card tap is two-step: the first focuses the character, a
    // repeat tap on the focused agent opens its terminal. A launched agent
    // comes in focused, so its card's first tap already opens it.
    await card.tap();
    await expectView(page, 'terminal');

    // Edge swipe from the left edge, rightwards: back to the office.
    await swipe(page, 4, PHONE.width * 0.8, PHONE.height / 2);
    await expectView(page, 'office');

    // In the office the left edge pulls the menu open. (A short pull settling
    // back is the reducer's tests' job: this synthetic swipe is instant, so
    // any length reads as a flick.)
    const menu = page.getByTestId('mobile-menu');
    await expect(menu).not.toBeInViewport();
    await swipe(page, 4, PHONE.width * 0.8, PHONE.height / 2);
    await expect(menu).toBeInViewport({ ratio: 1 });
    await expectView(page, 'office');
    // A leftward swipe across it, from the middle, pushes it back out.
    await swipe(page, PHONE.width * 0.6, 10, PHONE.height / 2);
    await expect(menu).not.toBeInViewport();
    await expectView(page, 'office');

    // And from the right edge, leftwards: to the terminal again.
    await swipe(page, PHONE.width - 4, PHONE.width * 0.2, PHONE.height / 2);
    await expectView(page, 'terminal');
  });

  test('the menu lists a finished conversation over Settings; a tap resumes it and slides to its terminal @area:mobile', async ({
    page,
    standalone,
  }) => {
    // A short session: titled, then the process ends and its agent leaves.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mobile titled conversation')
        .at(200)
        .appendJsonl({ type: 'ai-title', aiTitle: 'Phone bug hunt' })
        .holdOpenFor(2_000)
        .build(),
    );
    await launchFromCard(page, standalone.workspaceDir);
    const card = page.getByTitle('Agent 1', { exact: true });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    const showOffice = page.getByTitle('Show office', { exact: true });
    if (await showOffice.isVisible()) await showOffice.tap();
    await expectView(page, 'office');

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mobile resumed conversation').holdOpenFor(60_000).build(),
    );
    await page.getByRole('button', { name: 'Menu', exact: true }).tap();
    const panel = page.getByTestId('mobile-menu');
    // Settings sits at the menu's foot.
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    const row = panel.getByTestId('conversation-row').filter({ hasText: 'Phone bug hunt' });
    await expect(row).toBeVisible();
    await row.tap();

    // The panel closes, the agent is back, and the shell slides to its terminal.
    await expect(page.getByTitle('Agent 2', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expectView(page, 'terminal');
    await expect(row).not.toBeInViewport();
  });

  test('tapping a URL in the terminal opens it; a sideways drag from it does not @area:mobile', async ({
    page,
    standalone,
  }) => {
    const terminal = await launchTerminal(page, standalone, 'mobile link tap');

    // Put a URL on screen through the PTY's own echo.
    await terminal.tap();
    const url = 'https://example.com/pixel-agents-tap';
    await page.keyboard.type(url);
    const row = page.locator('.xterm-rows > div', { hasText: url }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const box = await row.boundingBox();
    if (!box) throw new Error('URL row has no box');
    const rowText = (await row.textContent()) ?? '';
    const charW = box.width / Math.max(1, rowText.length);
    const urlMidX = box.x + charW * (rowText.indexOf(url) + url.length / 2);
    const rowY = box.y + box.height / 2;
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));

    // A quick sideways drag starting on the URL stays under the vertical
    // scroll slop, but it is no tap: nothing opens.
    await swipe(page, urlMidX, urlMidX - 120, rowY);
    await page.waitForTimeout(1_000);
    expect(popups).toEqual([]);

    // Tap the middle of the URL text — a tap there opens it, it doesn't
    // just focus the terminal.
    await page.touchscreen.tap(urlMidX, rowY);
    await expect.poll(() => popups.length).toBe(1);
    expect(popups[0]).toContain('pixel-agents-tap');
  });

  test('the key bar shows while the software keyboard is up, under both viewport resize policies @area:mobile', async ({
    page,
    standalone,
  }) => {
    const terminal = await launchTerminal(page, standalone, 'mobile keyboard');
    const esc = page.getByRole('button', { name: 'esc', exact: true });
    // A tap focuses the terminal's input; the keyboard isn't up yet.
    await terminal.tap();
    await expect(esc).toHaveCount(0);

    // Android (interactive-widget=resizes-content): the keyboard shrinks the
    // layout viewport and the visual viewport alike.
    await page.setViewportSize({ width: PHONE.width, height: 500 });
    await expect(esc).toBeVisible();
    await page.setViewportSize(PHONE);
    await expect(esc).toHaveCount(0);

    // iOS: only the visual viewport shrinks; the shell is clamped to it.
    await page.evaluate(() => {
      const vv = window.visualViewport;
      if (!vv) throw new Error('no visualViewport');
      Object.defineProperty(vv, 'height', { configurable: true, get: () => 500 });
      vv.dispatchEvent(new Event('resize'));
    });
    await expect(esc).toBeVisible();
    const escBox = await esc.boundingBox();
    expect(escBox && escBox.y + escBox.height).toBeLessThanOrEqual(500);
  });

  test('copy and paste work on a plain-http origin (no Clipboard API) @area:mobile', async ({
    page,
    standalone,
  }) => {
    // What a phone opening the tokened LAN http:// URL gets: not a secure
    // context, so navigator.clipboard does not exist. Whatever reaches the
    // clipboard through a copy event is recorded instead.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { value: false });
      Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined });
      const setData = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (format: string, data: string) {
        (window as unknown as { __copied?: string }).__copied = data;
        setData.call(this, format, data);
      };
    });
    await page.reload();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const terminal = await launchTerminal(page, standalone, 'mobile clipboard');
    await terminal.tap();
    const word = 'pixelcopyword';
    // Enter moves the cursor (the input area, where a hold offers Paste)
    // to the next row, leaving the word on a row of plain output.
    await page.keyboard.type(word);
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows', { hasText: word })).toBeVisible({ timeout: 10_000 });
    // The word's exact on-screen box, from a DOM Range over its characters.
    const at = await page.evaluate((word) => {
      const rows = document.querySelector('.xterm-rows');
      const walker = document.createTreeWalker(rows ?? document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent?.indexOf(word) ?? -1;
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + word.length);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
      }
      throw new Error('word not on screen');
    }, word);

    // Long-press the word, then the Copy pill.
    await longPress(page, at.x, at.y, 900);
    const pill = page.locator('.terminal-copy-pill');
    await pill.getByRole('button', { name: 'Copy', exact: true }).tap();
    await expect(pill).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(
      word,
    );

    // The pill's second action, "Copy as text", copies through the same path.
    await page.evaluate(() => {
      (window as unknown as { __copied?: string }).__copied = undefined;
    });
    await longPress(page, at.x, at.y, 900);
    await pill.getByRole('button', { name: 'Copy as text', exact: true }).tap();
    await expect(pill).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(
      word,
    );

    // Paste: a hold on the input area (the cursor's row, under the word)
    // offers it; with no clipboard to read, it asks for the text instead.
    await longPress(page, at.x, at.y + at.h, 900);
    await expect(pill.getByRole('button')).toHaveText(['Paste']);
    page.once('dialog', (d) => void d.accept('pastedviaprompt'));
    await pill.getByRole('button', { name: 'Paste', exact: true }).tap();
    await expect(pill).toHaveCount(0);
    await expect(terminal).toContainText('pastedviaprompt', { timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test('the hooks info modal fits the phone screen @area:mobile', async ({
    page,
    standalone: _launched,
  }) => {
    // Seeded consent means hooks are installed: the first-run tooltip offers
    // the info modal.
    await page.getByText('View more', { exact: true }).tap();
    const title = page.getByText('Instant Detection is ON', { exact: true });
    await expect(title).toBeVisible();
    const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
    // The modal header's close button (the tooltip has a close button of its own).
    const close = page
      .locator('div', { has: title })
      .last()
      .getByRole('button', { name: 'Close', exact: true });
    for (const el of [title, gotIt, close]) {
      const box = await el.boundingBox();
      if (!box) throw new Error('modal part has no box');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
    await close.tap();
    await expect(title).toHaveCount(0);
  });

  test('a two-finger pan stops the camera following a character; a pure pinch does not @area:mobile', async ({
    page,
    standalone,
  }) => {
    await launchTerminal(page, standalone, 'mobile camera follow');
    await page.getByTitle('Show office', { exact: true }).tap();
    // A card tap in the office focuses the character and follows it.
    await page.getByTitle('Agent 1', { exact: true }).tap();
    await expect.poll(() => cameraFollowId(page)).not.toBeNull();

    // Pinch in place: the midpoint stays put, so the follow survives.
    const mid = { x: PHONE.width / 2, y: PHONE.height / 2 };
    await twoFingerGesture(
      page,
      [
        { x: mid.x - 40, y: mid.y },
        { x: mid.x + 40, y: mid.y },
      ],
      [
        { x: mid.x - 80, y: mid.y },
        { x: mid.x + 80, y: mid.y },
      ],
    );
    expect(await cameraFollowId(page)).not.toBeNull();

    // Two fingers dragged together: a manual pan, the camera is the user's.
    await twoFingerGesture(
      page,
      [
        { x: mid.x - 40, y: mid.y },
        { x: mid.x + 40, y: mid.y },
      ],
      [
        { x: mid.x - 40, y: mid.y + 100 },
        { x: mid.x + 40, y: mid.y + 100 },
      ],
    );
    expect(await cameraFollowId(page)).toBeNull();
  });

  test('the trackpad key follows the finger that pressed it, not touches[0] @area:mobile', async ({
    page,
    standalone,
  }) => {
    // Record what the terminal socket sends to the PTY.
    await page.addInitScript(() => {
      const sent: string[] = [];
      (window as unknown as { __ptyInput: string[] }).__ptyInput = sent;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('"input"')) {
          const frame = JSON.parse(data) as { type?: string; data?: string };
          if (frame.type === 'input' && frame.data) sent.push(frame.data);
        }
        send.call(this, data);
      };
    });
    await page.reload();
    const terminal = await launchTerminal(page, standalone, 'mobile trackpad');
    await terminal.tap();
    await page.setViewportSize({ width: PHONE.width, height: 500 }); // keyboard up
    const pad = page.getByRole('button', { name: 'Arrow keys', exact: true });
    await expect(pad).toBeVisible();
    const padBox = await pad.boundingBox();
    if (!padBox) throw new Error('trackpad key has no box');

    // A resting finger on the key bar lands FIRST (touches[0]); the pad
    // finger then slides 3 left/right steps (8 px each) right.
    const arrows = await page.evaluate(
      ({ x, y }) => {
        const pad = document.elementFromPoint(x, y);
        const bar = pad?.parentElement;
        if (!pad || !bar) throw new Error('no trackpad key');
        const rest = new Touch({ identifier: 9, target: bar, clientX: 4, clientY: y });
        const at = (dx: number) =>
          new Touch({ identifier: 2, target: pad, clientX: x + dx, clientY: y });
        const fire = (target: Element, type: string, down: Touch[], changed: Touch[]) =>
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: down,
              targetTouches: down.filter((t) => t.target === target),
              changedTouches: changed,
            }),
          );
        const input = (window as unknown as { __ptyInput: string[] }).__ptyInput;
        const before = input.length;
        fire(bar, 'touchstart', [rest], [rest]);
        fire(pad, 'touchstart', [rest, at(0)], [at(0)]);
        for (const dx of [8, 16, 24, 26]) fire(pad, 'touchmove', [rest, at(dx)], [at(dx)]);
        fire(pad, 'touchend', [rest], [at(26)]);
        fire(bar, 'touchend', [], [rest]);
        return input.slice(before).filter((d) => d === '\x1b[C').length;
      },
      { x: padBox.x + padBox.width / 2, y: padBox.y + padBox.height / 2 },
    );
    expect(arrows).toBe(3);
  });

  test('a trackpad drag from the pad to either screen edge sweeps a full line @area:mobile', async ({
    page,
    standalone,
  }) => {
    await page.addInitScript(() => {
      const sent: string[] = [];
      (window as unknown as { __ptyInput: string[] }).__ptyInput = sent;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('"input"')) {
          const frame = JSON.parse(data) as { type?: string; data?: string };
          if (frame.type === 'input' && frame.data) sent.push(frame.data);
        }
        send.call(this, data);
      };
    });
    await page.reload();
    const terminal = await launchTerminal(page, standalone, 'mobile trackpad sweep');
    await terminal.tap();
    await page.setViewportSize({ width: PHONE.width, height: 500 }); // keyboard up
    const pad = page.getByRole('button', { name: 'Arrow keys', exact: true });
    await expect(pad).toBeVisible();
    const padBox = await pad.boundingBox();
    if (!padBox) throw new Error('trackpad key has no box');

    // One press per side, sliding from the pad's centre to the screen edge.
    const sweep = (toEdge: number) =>
      page.evaluate(
        ({ x, y, toEdge }) => {
          const pad = document.elementFromPoint(x, y);
          if (!pad) throw new Error('no trackpad key');
          const at = (px: number) =>
            new Touch({ identifier: 3, target: pad, clientX: px, clientY: y });
          const fire = (type: string, touch: Touch, down: boolean) =>
            pad.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: down ? [touch] : [],
                changedTouches: [touch],
              }),
            );
          const input = (window as unknown as { __ptyInput: string[] }).__ptyInput;
          const before = input.length;
          fire('touchstart', at(x), true);
          for (let i = 1; i <= 20; i++) fire('touchmove', at(x + ((toEdge - x) * i) / 20), true);
          fire('touchend', at(toEdge), false);
          return input.slice(before);
        },
        { x: padBox.x + padBox.width / 2, y: padBox.y + padBox.height / 2, toEdge },
      );
    const right = (await sweep(PHONE.width)).filter((d) => d === '\x1b[C').length;
    const left = (await sweep(0)).filter((d) => d === '\x1b[D').length;

    // Both edges are a full line away, and the outer stretch accelerates:
    // far more than the linear pace (one column per 8 px) would send.
    expect(left).toBe(right);
    expect(right).toBeGreaterThan(Math.ceil(PHONE.width / 2 / 8) + 5);
  });

  test('the arrow on the + card toggles the roster: a tap launches as that character, a hold edits it @area:mobile', async ({
    page,
    standalone,
  }) => {
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mobile roster launch').holdOpenFor(60_000).build(),
    );
    const characters = page.getByRole('button', { name: 'Roster', exact: true });
    const roster = page.getByTestId('character-picker');
    const cards = roster.getByRole('button', { name: /^Launch as / });

    // The arrow sits right of the + card, as tall as it: + square, the
    // arrow a narrower tab.
    const button = await characters.boundingBox();
    const plus = await page.getByTitle('Launch agent', { exact: true }).boundingBox();
    expect(button && plus && Math.abs(button.x - (plus.x + plus.width)) < 1).toBe(true);
    expect(button && plus && Math.abs(button.y - plus.y) < 1).toBe(true);
    expect(plus && Math.abs(plus.width - plus.height) < 1).toBe(true);
    expect(button && plus && button.width < plus.width).toBe(true);

    // It opens the roster only (not the Characters view): a strip across the
    // whole screen right above the card bar, ending in + New. The arrow
    // stays, turned, to close it.
    await characters.tap();
    await expect(roster).toHaveAttribute('aria-hidden', 'false');
    await expect(characters).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.chv-root')).toHaveCount(0);
    await expect(roster.getByRole('button').first()).toHaveText(/New/);
    // A touch screen scrolls it with the finger: no scrollbar.
    await expect(roster.locator('> div')).toHaveCSS('scrollbar-width', 'none');
    // Polled: the strip slides up into place.
    await expect
      .poll(async () => {
        const strip = await roster.boundingBox();
        return (
          strip && { width: Math.round(strip.width), bottom: Math.round(strip.y + strip.height) }
        );
      })
      .toEqual({ width: PHONE.width, bottom: Math.round((button?.y ?? 0) - 8) });

    // The arrow closes it again, and reopens it.
    await characters.tap();
    await expect(roster).toHaveAttribute('aria-hidden', 'true');
    await expect(characters).toHaveAttribute('aria-expanded', 'false');
    await characters.tap();
    await expect(roster).toHaveAttribute('aria-hidden', 'false');

    // A tap picks the character and hands over to the Directory list…
    const picked = cards.nth(2);
    const name = ((await picked.getAttribute('aria-label')) ?? '').replace('Launch as ', '');
    await picked.tap();
    await expect(roster).toHaveAttribute('aria-hidden', 'true');
    await expect(characters).toBeVisible();
    const drawer = page.getByTestId('launch-drawer');
    await expect(drawer).toContainText(`Launch ${name} in`);

    // …and the agent launched there wears exactly that character.
    await drawer
      .getByRole('button', { name: path.basename(standalone.workspaceDir), exact: true })
      .tap();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__pixelAgentsTestHooks?.getCharacters?.() ?? [])
            .filter((ch) => ch.id > 0 && !ch.isGreeter)
            .map(({ palette, repeat }) => ({ palette, repeat })),
        ),
      )
      .toEqual([{ palette: 2, repeat: 0 }]);

    // Holding a card opens the Characters view on that character instead.
    await page.getByTitle('Show office', { exact: true }).tap();
    await characters.tap();
    // The last-used character now comes first, the rest in cast order: 2, 0, 1, …
    await expect(cards.first()).toHaveAttribute('aria-label', `Launch as ${name}`);
    // The server keeps that order, so a desktop office lists it the same way.
    const desktopContext = await page.context().browser()!.newContext();
    const desktop = await desktopContext.newPage();
    await desktop.goto(page.url());
    await desktop.getByRole('button', { name: 'Roster', exact: true }).click();
    await expect(
      desktop
        .getByTestId('character-picker')
        .getByRole('button', { name: /^Launch as / })
        .first(),
    ).toHaveAttribute('aria-label', `Launch as ${name}`);
    await desktopContext.close();
    await heldTouch(page, cards.nth(1), 900);
    await expect(page.locator('.chv-root')).toBeVisible();
    await expect(roster).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.chv-mcard[aria-current="true"]')).toHaveCount(1);
    await expect(page.locator('.chv-mcard').nth(0)).toHaveAttribute('aria-current', 'true');
  });
});
