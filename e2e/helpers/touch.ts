import type { Locator, Page } from '@playwright/test';

/** A real one-finger press held for `ms` on the middle of `target`, through
 *  CDP so the page also gets the pointer events a finger produces (a
 *  TouchEvent-only dispatch has none). */
export async function heldTouch(page: Page, target: Locator, ms: number): Promise<void> {
  // A trial tap waits for the target to stop moving (a menu sliding in).
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
